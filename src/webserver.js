const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const pagamento = require('./pagamento');

const EULA_PDF_PATH = path.join(__dirname, '../docs/cronos-eula.pdf');

async function enviarEulaPDF(whatsappClient, usuarioId) {
  if (!whatsappClient) return;
  if (!fs.existsSync(EULA_PDF_PATH)) return;
  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = MessageMedia.fromFilePath(EULA_PDF_PATH);
    await whatsappClient.sendMessage(usuarioId, media, { sendMediaAsDocument: true });
  } catch (err) {
    console.error('[EULA] Erro ao enviar PDF de termos:', err.message);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function getJwt() { return require('jsonwebtoken'); }
function getBcrypt() { return require('bcrypt'); }

function jwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET não configurado no .env');
  return s;
}

// ── Middleware de autenticação JWT ────────────────────────────────────────────
async function autenticar(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'Token ausente' });

  try {
    const payload = getJwt().verify(token, jwtSecret());
    req.usuarioId = payload.usuarioId;
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// ── Painel SPA ────────────────────────────────────────────────────────────────
app.get('/painel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ erro: 'Usuário e senha obrigatórios' });
  }

  try {
    const usuario = await db.buscarUsuarioPainelPorUsername(username);
    if (!usuario) return res.status(401).json({ erro: 'Usuário ou senha incorretos' });

    const ok = await getBcrypt().compare(String(password), usuario.password_hash);
    if (!ok) return res.status(401).json({ erro: 'Usuário ou senha incorretos' });

    const token = getJwt().sign(
      { usuarioId: usuario.usuario_id, username: usuario.username },
      jwtSecret(),
      { expiresIn: '30d' }
    );

    res.json({ token, username: usuario.username });
  } catch (err) {
    console.error('[WEB] /api/auth/login:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/auth/me', autenticar, async (req, res) => {
  try {
    const usuario = await db.buscarUsuario(req.usuarioId).catch(() => null);
    const painel = await db.buscarUsuarioPainelPorUserId(req.usuarioId).catch(() => null);
    const isAdmin = !!painel?.is_admin;
    res.json({ usuarioId: req.usuarioId, nome: usuario?.nome || null, username: painel?.username || null, isAdmin, avatarData: painel?.avatar_data || null });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/auth/avatar', autenticar, async (req, res) => {
  try {
    const { avatarData } = req.body || {};
    if (!avatarData || !avatarData.startsWith('data:image/')) {
      return res.status(400).json({ erro: 'Dados de imagem inválidos' });
    }
    if (avatarData.length > 300000) {
      return res.status(400).json({ erro: 'Imagem muito grande (máx 300KB)' });
    }
    await db.salvarAvatarPainel(req.usuarioId, avatarData);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] /api/auth/avatar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', autenticar, async (req, res) => {
  try {
    const agora = new Date();
    const mes = parseInt(req.query.mes) || agora.getMonth() + 1;
    const ano = parseInt(req.query.ano) || agora.getFullYear();

    const [resumo, saldos] = await Promise.all([
      db.resumoMensal(req.usuarioId, mes, ano),
      db.calcularSaldos(req.usuarioId),
    ]);

    res.json({ resumo, saldos });
  } catch (err) {
    console.error('[WEB] /api/dashboard:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/resumo-anual', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const resumo = await db.resumoAnual(req.usuarioId, ano);
    res.json(resumo);
  } catch (err) {
    console.error('[WEB] /api/resumo-anual:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Transações ────────────────────────────────────────────────────────────────
app.get('/api/transactions', autenticar, async (req, res) => {
  try {
    const { tipo, status, dataInicio, dataFim, descricao, limite } = req.query;
    const transacoes = await db.consultarTransacoes(req.usuarioId, {
      tipo: tipo || null,
      status: status || null,
      dataInicio: dataInicio || null,
      dataFim: dataFim || null,
      descricao: descricao || null,
      limite: parseInt(limite) || 200,
    });

    // Adicionar projeções de recorrências quando não filtrando apenas por 'pago'
    let resultado = transacoes;
    if (status !== 'pago' && dataInicio && dataFim) {
      const regras = await db.listarRecorrencias(req.usuarioId);
      if (regras.length > 0) {
        const dataInicioObj = new Date(dataInicio + 'T12:00:00');
        const dataFimObj = new Date(dataFim + 'T12:00:00');
        const ocorrencias = db.calcularOcorrenciasNoPerodo(regras, dataInicioObj, dataFimObj);

        // Excluir projeções já cobertas por transação real (mesmo recorrencia_id no mês)
        const anoMes = dataInicio.substring(0, 7);
        const idsComTransacao = new Set(
          transacoes
            .filter(t => t.recorrencia_id != null && (t.data || '').startsWith(anoMes))
            .map(t => t.recorrencia_id)
        );

        const projetadas = ocorrencias
          .filter(o => !idsComTransacao.has(o.recorrencia_id))
          .filter(o => !tipo || o.tipo === tipo)
          .filter(o => !descricao || o.descricao.toLowerCase().includes(descricao.toLowerCase()))
          .map(o => ({ ...o, id: null, status: 'pendente', projetado: true }));

        resultado = [...transacoes, ...projetadas].sort((a, b) =>
          (a.data || '').localeCompare(b.data || '')
        );
      }
    }

    res.json(resultado);
  } catch (err) {
    console.error('[WEB] /api/transactions:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/transactions/:id/pagar', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const resultado = await db.liquidarTransacao(req.usuarioId, id);
    if (!resultado) return res.status(404).json({ erro: 'Transação não encontrada ou já paga' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/transactions/:id/pagar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/transactions/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const resultado = await db.excluirTransacao(req.usuarioId, id);
    if (!resultado.changes) return res.status(404).json({ erro: 'Transação não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/transactions/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Categorias ────────────────────────────────────────────────────────────────
app.get('/api/categories', autenticar, async (req, res) => {
  try {
    res.json(await db.listarCategorias());
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/categories', autenticar, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    await db.criarCategoria(nome);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/categories/:nome', autenticar, async (req, res) => {
  try {
    const nome = decodeURIComponent(req.params.nome);
    const resultado = await db.excluirCategoria(nome);
    if (!resultado) return res.status(404).json({ erro: 'Categoria não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Redirect pós-pagamento InfinityPay ───────────────────────────────────────
// InfinityPay redireciona o browser do cliente aqui após pagamento confirmado
// URL: GET /pagamento/sucesso?order_nsu=...&transaction_nsu=...&slug=...&receipt_url=...
app.get('/pagamento/sucesso', async (req, res) => {
  try {
    console.log('[REDIRECT PAGAMENTO] Params recebidos:', JSON.stringify(req.query));

    const resultado = await pagamento.processarRedirectPagamento(req.query);

    const whatsappClient = app.get('whatsappClient');

    if (resultado) {
      const { usuarioId, pagoAteStr, receipt_url } = resultado;
      const dataFormatada = pagoAteStr.split('-').reverse().join('/');

      // Notificar usuário via WhatsApp
      if (whatsappClient) {
        try {
          let msg = `✅ *Pagamento confirmado!*\n\nSua assinatura do *Cronos* está ativa até *${dataFormatada}*. Obrigado! 🚀`;
          if (receipt_url) msg += `\n\n🧾 Comprovante: ${receipt_url}`;
          await whatsappClient.sendMessage(usuarioId, msg);
          await enviarEulaPDF(whatsappClient, usuarioId);
        } catch (err) {
          console.error('[REDIRECT PAGAMENTO] Erro ao notificar WhatsApp:', err.message);
        }
      }

      // Página de confirmação para o cliente
      res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pagamento Confirmado - Cronos</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f0fdf4; }
    .card { background: white; border-radius: 16px; padding: 40px 32px; text-align: center;
            max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #16a34a; margin: 0 0 8px; font-size: 24px; }
    p { color: #555; margin: 8px 0; }
    .data { font-weight: bold; color: #111; }
    .footer { margin-top: 24px; font-size: 13px; color: #888; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Pagamento confirmado!</h1>
    <p>Sua assinatura do <strong>Cronos</strong> está ativa.</p>
    <p>Válida até: <span class="data">${dataFormatada}</span></p>
    <p class="footer">Volte ao WhatsApp — uma mensagem de confirmação foi enviada para você.</p>
  </div>
</body>
</html>`);
    } else {
      // Pagamento não confirmado ainda (pode ser raro, InfinityPay redireciona após aprovação)
      res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aguardando confirmação - Cronos</title>
  <style>
    body { font-family: sans-serif; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #fffbeb; }
    .card { background: white; border-radius: 16px; padding: 40px 32px; text-align: center;
            max-width: 400px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #d97706; margin: 0 0 8px; font-size: 22px; }
    p { color: #555; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏳</div>
    <h1>Aguardando confirmação</h1>
    <p>Seu pagamento está sendo processado.</p>
    <p>Em até 5 minutos você receberá uma mensagem no WhatsApp confirmando o acesso.</p>
  </div>
</body>
</html>`);
    }
  } catch (err) {
    console.error('[REDIRECT PAGAMENTO] Erro:', err.message);
    res.status(500).send('Erro interno. Tente novamente em instantes.');
  }
});

// ── Webhook de pagamento InfinityPay ──────────────────────────────────────────
// Endpoint público (sem autenticação JWT) — InfinityPay envia confirmação aqui
app.post('/webhook/pagamento', async (req, res) => {
  try {
    console.log('[WEBHOOK PAGAMENTO] Payload recebido:', JSON.stringify(req.body));
    const usuarioId = await pagamento.processarWebhook(req.body);

    if (usuarioId) {
      // Notificar usuário via WhatsApp se o cliente estiver disponível
      const whatsappClient = app.get('whatsappClient');
      if (whatsappClient) {
        try {
          await whatsappClient.sendMessage(
            usuarioId,
            '✅ *Pagamento confirmado!*\n\nSeu acesso ao *Cronos* foi renovado por mais 30 dias. Pode usar à vontade! 🚀'
          );
          await enviarEulaPDF(whatsappClient, usuarioId);
        } catch (err) {
          console.error('[WEBHOOK PAGAMENTO] Erro ao notificar usuário:', err.message);
        }
      }
      // Resposta obrigatória InfinityPay: { "success": true, "message": null }
      res.json({ success: true, message: null });
    } else {
      // Retornar 200 com success:false para não provocar retentativas desnecessárias
      res.json({ success: true, message: null });
    }
  } catch (err) {
    console.error('[WEBHOOK PAGAMENTO] Erro:', err.message);
    // 400 faz InfinityPay tentar novamente — usar só em erros transitórios
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── Agenda ────────────────────────────────────────────────────────────────────
app.get('/api/agenda', autenticar, async (req, res) => {
  try {
    const agora = new Date();
    const ano = parseInt(req.query.ano) || agora.getFullYear();
    const mes = parseInt(req.query.mes) || agora.getMonth() + 1;
    const mesStr = String(mes).padStart(2, '0');
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dataInicio = `${ano}-${mesStr}-01`;
    const dataFim = `${ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

    const [gerais, recorrentes] = await Promise.all([
      db.buscarLembretesGeraisPorPeriodo(req.usuarioId, dataInicio, dataFim),
      db.buscarLembretesRecorrentesPorMes(req.usuarioId, ano, mes),
    ]);

    // Mescla e ordena por data_disparo + hora
    const todos = [...gerais, ...recorrentes].sort((a, b) => {
      const ka = (a.data_disparo || '') + (a.hora || '');
      const kb = (b.data_disparo || '') + (b.hora || '');
      return ka.localeCompare(kb);
    });

    res.json(todos);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// Estado em memória das campanhas em andamento
const campanhasAtivas = new Map();

async function autenticarAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ erro: 'Token ausente' });

  try {
    const payload = getJwt().verify(token, jwtSecret());
    req.usuarioId = payload.usuarioId;
    const painel = await db.buscarUsuarioPainelPorUserId(req.usuarioId).catch(() => null);
    if (!painel?.is_admin) {
      return res.status(403).json({ erro: 'Acesso negado: requer permissão de administrador' });
    }
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado' });
  }
}

// Lista todos os usuários com status de assinatura
app.get('/api/admin/usuarios', autenticarAdmin, async (req, res) => {
  try {
    const usuarios = await db.listarUsuariosAdmin();
    res.json(usuarios);
  } catch (err) {
    console.error('[ADMIN] /api/admin/usuarios:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Ativa assinatura manualmente por 30 dias
app.post('/api/admin/ativar', autenticarAdmin, async (req, res) => {
  try {
    const { usuarioId } = req.body || {};
    if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatório' });
    const pagoAteStr = await pagamento.ativarManualmente(usuarioId);
    const whatsappClient = app.get('whatsappClient');
    if (whatsappClient) {
      const dataFormatada = pagoAteStr.split('-').reverse().join('/');
      await whatsappClient.sendMessage(usuarioId,
        `✅ *Assinatura ativada!*\n\nSua assinatura do *Cronos* está ativa até *${dataFormatada}*. 🚀`
      ).catch(e => console.error('[ADMIN] Erro ao notificar WhatsApp:', e.message));
      await enviarEulaPDF(whatsappClient, usuarioId);
    }
    res.json({ ok: true, pagoAte: pagoAteStr });
  } catch (err) {
    console.error('[ADMIN] /api/admin/ativar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Gera/retorna link de pagamento para um usuário
app.post('/api/admin/link', autenticarAdmin, async (req, res) => {
  try {
    const { usuarioId } = req.body || {};
    if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatório' });
    const assinatura = await db.buscarAssinatura(usuarioId);
    const link = await pagamento.obterLinkPagamento(usuarioId, assinatura);
    res.json({ link: link || null });
  } catch (err) {
    console.error('[ADMIN] /api/admin/link:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Cria um cupom de desconto ou dias grátis
app.post('/api/admin/cupom', autenticarAdmin, async (req, res) => {
  try {
    const { codigo, tipo, valor, usoMaximo, validoAte } = req.body || {};
    if (!codigo || !tipo || !valor) return res.status(400).json({ erro: 'codigo, tipo e valor são obrigatórios' });
    if (!['dias_gratis', 'desconto_percent'].includes(tipo)) {
      return res.status(400).json({ erro: 'tipo deve ser dias_gratis ou desconto_percent' });
    }
    await db.criarCupom(codigo, tipo, parseInt(valor), parseInt(usoMaximo) || 1, validoAte || null);
    res.json({ ok: true });
  } catch (err) {
    if (err.message?.includes('unique') || err.code === '23505') {
      return res.status(409).json({ erro: 'Já existe um cupom com esse código' });
    }
    console.error('[ADMIN] /api/admin/cupom:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Lista todos os cupons criados
app.get('/api/admin/cupons', autenticarAdmin, async (req, res) => {
  try {
    const cupons = await db.listarCupons();
    res.json(cupons);
  } catch (err) {
    console.error('[ADMIN] /api/admin/cupons:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Campanhas ─────────────────────────────────────────────────────────────────

// Lista usuários elegíveis para campanha com contagem prévia
app.get('/api/admin/campanhas/destinatarios', autenticarAdmin, async (req, res) => {
  try {
    const { filtro } = req.query;
    const usuarios = await db.listarUsuariosNaoPagantes(filtro || 'todos');
    res.json({ total: usuarios.length, usuarios });
  } catch (err) {
    console.error('[CAMPANHA] /destinatarios:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Inicia envio em massa com delay aleatório entre mensagens
app.post('/api/admin/campanhas/enviar', autenticarAdmin, async (req, res) => {
  try {
    const { mensagem, filtro } = req.body || {};
    if (!mensagem?.trim()) return res.status(400).json({ erro: 'Mensagem obrigatória' });

    const usuarios = await db.listarUsuariosNaoPagantes(filtro || 'todos');
    if (usuarios.length === 0) {
      return res.json({ ok: true, total: 0, campanhaId: null, aviso: 'Nenhum usuário encontrado para este filtro.' });
    }

    const campanhaId = Date.now().toString();
    const estado = { enviados: 0, total: usuarios.length, erros: 0, finalizado: false, log: [] };
    campanhasAtivas.set(campanhaId, estado);

    // Responde imediatamente — envio ocorre em background
    res.json({ ok: true, total: usuarios.length, campanhaId });

    const whatsappClient = app.get('whatsappClient');
    if (!whatsappClient) {
      estado.finalizado = true;
      estado.log.push('WhatsApp client não disponível.');
      return;
    }

    // Envio assíncrono com delay aleatório 5-15s
    (async () => {
      // Deduplicar por usuario_id (garante que a mesma pessoa não receba duas vezes)
      const vistos = new Set();
      const usuariosUnicos = usuarios.filter(u => {
        if (vistos.has(u.usuario_id)) return false;
        vistos.add(u.usuario_id);
        return true;
      });
      estado.total = usuariosUnicos.length;
      console.log(`[CAMPANHA] ${campanhaId} iniciada — ${usuariosUnicos.length} destinatários únicos`);

      for (let i = 0; i < usuariosUnicos.length; i++) {
        const usuario = usuariosUnicos[i];
        const nomeExibido = usuario.nome || usuario.usuario_id;
        try {
          const primeiroNome = (usuario.nome || '').split(' ')[0] || 'amigo(a)';
          const msg = mensagem.replace(/\{nome\}/gi, primeiroNome);
          await whatsappClient.sendMessage(usuario.usuario_id, msg);
          estado.enviados++;
          estado.log.push({ ok: true, nome: nomeExibido });
        } catch (err) {
          estado.erros++;
          estado.log.push({ ok: false, nome: nomeExibido, erro: err.message });
          console.error(`[CAMPANHA] Erro ao enviar para ${usuario.usuario_id}:`, err.message);
        }

        // Delay aleatório entre 5 e 15 segundos (exceto no último)
        if (i < usuariosUnicos.length - 1) {
          const delay = Math.floor(5000 + Math.random() * 10000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      estado.finalizado = true;
      console.log(`[CAMPANHA] ${campanhaId} finalizada — enviados: ${estado.enviados}, erros: ${estado.erros}`);
    })();
  } catch (err) {
    console.error('[CAMPANHA] /enviar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consulta status de uma campanha em andamento
app.get('/api/admin/campanhas/:id', autenticarAdmin, (req, res) => {
  const estado = campanhasAtivas.get(req.params.id);
  if (!estado) return res.status(404).json({ erro: 'Campanha não encontrada' });
  res.json(estado);
});

// Envia mensagem individual para um usuário específico
app.post('/api/admin/enviar-individual', autenticarAdmin, async (req, res) => {
  try {
    const { usuarioId, mensagem } = req.body || {};
    if (!usuarioId || !mensagem?.trim()) {
      return res.status(400).json({ erro: 'usuarioId e mensagem são obrigatórios' });
    }
    const whatsappClient = app.get('whatsappClient');
    if (!whatsappClient) return res.status(503).json({ erro: 'WhatsApp não disponível' });

    await whatsappClient.sendMessage(usuarioId, mensagem.trim());
    console.log(`[ADMIN] Mensagem individual enviada para ${usuarioId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /enviar-individual:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Inicialização ─────────────────────────────────────────────────────────────
function iniciarWebServer(whatsappClient) {
  if (whatsappClient) {
    app.set('whatsappClient', whatsappClient);
  }

  const port = parseInt(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`🌐 Painel web rodando em http://localhost:${port}`);
  });
}

module.exports = { iniciarWebServer };
