const express = require('express');
const path = require('path');
const db = require('./database');
const pagamento = require('./pagamento');

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
    res.json({ usuarioId: req.usuarioId, nome: usuario?.nome || null, username: painel?.username || null });
  } catch (err) {
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

    res.json(await db.buscarLembretesGeraisPorPeriodo(req.usuarioId, dataInicio, dataFim));
  } catch (err) {
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
