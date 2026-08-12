const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const limites = require('./limites');
const pagamento = require('./pagamento');
const cronAdmin = require('./cron-admin');
const gcal = require('./google-calendar');
const pluggy = require('./pluggy');

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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Página raiz — serve painel ou landing conforme o hostname ────────────────
app.get('/', (req, res) => {
  const host = req.hostname;
  if (host === 'painel.cronosappai.com.br') {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.sendFile(path.join(__dirname, '../public/landing.html'));
  }
});

app.use(express.static(path.join(__dirname, '../public')));

const UPLOAD_DIR = path.join(__dirname, '../public/images');
app.use('/images', express.static(UPLOAD_DIR));

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

// ── Páginas públicas ──────────────────────────────────────────────────────────
app.get('/painel', (req, res) => {
  res.redirect(301, 'https://painel.cronosappai.com.br/');
});
app.get('/privacidade', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/privacidade.html'));
});
app.get('/termos', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/termos.html'));
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

// Previsão dos próximos meses (card do dashboard). Valores PROJETADOS, não
// realizados — a composição e a defesa contra dupla contagem estão em
// db.projetarProximosMeses.
app.get('/api/previsao', autenticar, async (req, res) => {
  try {
    const meses = parseInt(req.query.meses) || 6;
    res.json(await db.projetarProximosMeses(req.usuarioId, meses));
  } catch (err) {
    console.error('[WEB] /api/previsao:', err.message);
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
    const { tipo, status, dataInicio, dataFim, descricao, limite, recorrente, contaId, cartaoId } = req.query;
    const contaIdNum = parseInt(contaId) || null;
    const cartaoIdNum = parseInt(cartaoId) || null;
    const transacoes = await db.consultarTransacoes(req.usuarioId, {
      tipo: tipo || null,
      status: status || null,
      dataInicio: dataInicio || null,
      dataFim: dataFim || null,
      descricao: descricao || null,
      limite: parseInt(limite) || 200,
      recorrente: recorrente === '1' ? true : null,
      contaId: contaIdNum,
      cartaoId: cartaoIdNum,
    });

    // Adicionar projeções de recorrências quando não filtrando apenas por 'pago'
    let resultado = transacoes;
    if (status !== 'pago' && dataInicio && dataFim) {
      const regras = await db.listarRecorrencias(req.usuarioId);
      if (regras.length > 0) {
        const dataInicioObj = new Date(dataInicio + 'T12:00:00');
        const dataFimObj = new Date(dataFim + 'T12:00:00');
        const ocorrencias = db.calcularOcorrenciasNoPerodo(regras, dataInicioObj, dataFimObj);

        // Excluir projeções já cobertas por transação real (qualquer status, para cobrir itens pulados).
        // SEMPRE via query dedicada e SEM filtro de tipo/conta/cartão/status — nunca reusar
        // `transacoes`, que já vem filtrada pelos parâmetros da requisição. Bug de produção: ao
        // reusar a lista filtrada, qualquer filtro aberto no painel esvaziava idsComTransacao e o
        // bloco abaixo materializava a mesma recorrência de novo a cada combinação de filtro.
        const recorrenciasNoPeriodo = await db.listarRecorrenciaIdsNoPeriodo(req.usuarioId, dataInicio, dataFim);
        const idsComTransacao = new Set(
          recorrenciasNoPeriodo
            .filter(t => t.recorrencia_id != null)
            .map(t => t.recorrencia_id)
        );
        // Mês consolidado está fechado por decisão do usuário: mesmo sem
        // nenhuma entrada real (ele consolidou justamente para dizer "não veio
        // nada"), não pode ganhar projeção materializada de novo.
        for (const c of await db.listarConsolidacoesNoPeriodo(req.usuarioId, dataInicio, dataFim)) {
          idsComTransacao.add(c.recorrencia_id);
        }

        const projetadas = ocorrencias
          .filter(o => !idsComTransacao.has(o.recorrencia_id))
          .filter(o => !tipo || o.tipo === tipo)
          .filter(o => !descricao || o.descricao.toLowerCase().includes(descricao.toLowerCase()));

        // Auto-materializar projeções do mês atual como transações reais.
        // projetada = TRUE (último argumento): estas linhas são o sistema
        // materializando a regra, não fato do extrato. É essa marca que a
        // trava idx_transacoes_projecao_mes usa para impedir a segunda
        // projeção do mês, e é ela que autoriza o lançamento real da Pluggy a
        // absorver esta linha quando o dinheiro de verdade chega.
        const hojeISO = new Date().toISOString().substring(0, 10);
        const anoMesAtual = hojeISO.substring(0, 7);
        const periodoEhMesAtual = dataInicio && dataInicio.substring(0, 7) === anoMesAtual;

        if (periodoEhMesAtual && projetadas.length > 0) {
          for (const proj of projetadas) {
            try {
              await db.adicionarTransacaoComRecorrencia(
                req.usuarioId, proj.tipo, proj.valor, proj.descricao, proj.categoria,
                proj.data, 'pendente', proj.recorrencia_id,
                proj.cartao_id, proj.conta_id, true
              );
            } catch (err) {
              console.error('[WEB] Erro ao materializar projeção:', err.message);
            }
          }
          // Re-buscar para incluir as novas transações com IDs reais
          const transacoesAtualizadas = await db.consultarTransacoes(req.usuarioId, {
            tipo: tipo || null, status: status || null,
            dataInicio: dataInicio || null, dataFim: dataFim || null,
            descricao: descricao || null, limite: parseInt(limite) || 200,
            contaId: contaIdNum, cartaoId: cartaoIdNum,
          });
          resultado = transacoesAtualizadas.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
        } else {
          resultado = [...transacoes, ...projetadas.map(o => ({ ...o, id: null, status: 'pendente', projetado: true }))].sort((a, b) =>
            (a.data || '').localeCompare(b.data || '')
          );
        }
      }
    }

    // Projetar faturas de cartão para meses futuros (baseado nas parcelas pendentes)
    if (status !== 'pago' && dataInicio && dataFim) {
      const mesConsulta = dataInicio.substring(0, 7); // "YYYY-MM"
      const cartoes = await db.listarCartoes(req.usuarioId);
      for (const cartao of cartoes) {
        // Verificar se já existe uma transação de fatura para este cartão neste mês
        const jaTemFatura = resultado.some(
          t => t.cartao_id === cartao.id && t.descricao && t.descricao.startsWith('Fatura ')
        );
        if (jaTemFatura) continue;

        const projecoes = await db.projetarFaturasCartao(cartao.id);
        const valorMes = projecoes[mesConsulta];
        if (valorMes && valorMes > 0) {
          const diaVenc = cartao.dia_vencimento || 1;
          const pad = (n) => String(n).padStart(2, '0');
          const dataFatura = `${mesConsulta}-${pad(diaVenc)}`;
          resultado.push({
            id: null,
            tipo: 'despesa',
            valor: Math.round(valorMes * 100) / 100,
            descricao: `Fatura ${cartao.nome}`,
            categoria: 'Fatura',
            data: dataFatura,
            status: 'pendente',
            projetado: true,
            cartao_id: cartao.id,
          });
        }
      }
      resultado.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
    }

    // Filtro de origem também sobre projeções (recorrência e fatura de cartão),
    // que não passam pelo WHERE do SQL acima. A projeção de recorrência agora
    // carrega a origem da regra, então a fixa do cartão aparece ao filtrar por
    // aquele cartão; regra antiga, sem origem, só aparece em "Todas as origens".
    // Projeção de fatura tem cartao_id do cartão dono.
    if (contaIdNum || cartaoIdNum) {
      resultado = resultado.filter(t => {
        if (contaIdNum) return t.conta_id === contaIdNum;
        if (cartaoIdNum) return t.cartao_id === cartaoIdNum;
        return true;
      });
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

app.put('/api/transactions/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { campo, novo_valor } = req.body;
    if (!campo || novo_valor === undefined) return res.status(400).json({ erro: 'campo e novo_valor são obrigatórios' });
    const resultado = await db.atualizarTransacao(req.usuarioId, id, campo, novo_valor);
    if (!resultado) return res.status(404).json({ erro: 'Transação não encontrada' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/transactions/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/transactions/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });

    // Se não veio ?modo=apenas_este, verificar se é recorrente e perguntar ao frontend
    if (req.query.modo !== 'apenas_este') {
      const tx = await db.buscarTransacaoPorId(req.usuarioId, id);
      if (tx && tx.recorrencia_id) {
        return res.status(409).json({
          recorrente: true,
          recorrencia_id: tx.recorrencia_id,
          descricao: tx.descricao,
        });
      }
    }

    const resultado = await db.excluirTransacao(req.usuarioId, id);
    if (!resultado.changes) return res.status(404).json({ erro: 'Transação não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/transactions/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Transforma um lançamento existente em recorrência (o modal de edição só
// oferece isso para transação real, nunca para linha projetada).
// A regra criada apenas PROJETA — ver db.tornarTransacaoRecorrente.
app.post('/api/transactions/:id/recorrencia', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { frequencia, vezes } = req.body || {};
    if (frequencia && !['mensal', 'semanal'].includes(frequencia)) {
      return res.status(400).json({ erro: 'frequencia deve ser mensal ou semanal' });
    }
    const resultado = await db.tornarTransacaoRecorrente(req.usuarioId, id, { frequencia, vezes });
    if (resultado.erro === 'nao_encontrada') return res.status(404).json({ erro: 'Transação não encontrada' });
    if (resultado.erro === 'ja_recorrente') {
      return res.status(409).json({ erro: 'Este lançamento já faz parte de uma recorrência', recorrencia_id: resultado.recorrencia_id });
    }
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/transactions/:id/recorrencia:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/recurrences/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    await db.desativarRecorrencia(req.usuarioId, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/recurrences/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consolidar: fecha o mês de uma recorrência pelo total REAL que entrou.
// Ver consolidarRecorrenciaMes em src/database.js para o efeito completo —
// grava a soma, apaga a projeção remanescente, fecha o balde. Reversível.
app.post('/api/recorrencias/:id/consolidar', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { competencia } = req.body;
    if (!/^\d{4}-\d{2}$/.test(String(competencia || ''))) {
      return res.status(400).json({ erro: 'competencia é obrigatória (YYYY-MM)' });
    }
    const resultado = await db.consolidarRecorrenciaMes(req.usuarioId, id, competencia);
    if (resultado.erro === 'nao_encontrada') return res.status(404).json({ erro: 'Recorrência não encontrada' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/recorrencias/:id/consolidar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/recorrencias/:id/consolidar', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const competencia = String(req.query.competencia || '');
    if (!/^\d{4}-\d{2}$/.test(competencia)) {
      return res.status(400).json({ erro: 'competencia é obrigatória (YYYY-MM)' });
    }
    res.json(await db.desconsolidarRecorrenciaMes(req.usuarioId, id, competencia));
  } catch (err) {
    console.error('[WEB] DELETE /api/recorrencias/:id/consolidar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Pula uma ocorrência de recorrência (insere como pago para suprimir a projeção)
app.post('/api/transactions/skip-occurrence', autenticar, async (req, res) => {
  try {
    const { recorrencia_id, data } = req.body;
    if (!recorrencia_id || !data) return res.status(400).json({ erro: 'recorrencia_id e data são obrigatórios' });
    const regras = await db.listarRecorrencias(req.usuarioId);
    const regra = regras.find(r => r.id === recorrencia_id);
    if (!regra) return res.status(404).json({ erro: 'Recorrência não encontrada' });
    await db.adicionarTransacaoComRecorrencia(
      req.usuarioId, regra.tipo, regra.valor, regra.descricao, regra.categoria,
      data, 'pago', recorrencia_id, regra.cartao_id, regra.conta_id
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] POST /api/transactions/skip-occurrence:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Limites / Orçamento ───────────────────────────────────────────────────────
app.get('/api/limites', autenticar, async (req, res) => {
  try {
    res.json(await db.listarLimitesComSub(req.usuarioId));
  } catch (err) {
    console.error('[WEB] GET /api/limites:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/limites', autenticar, async (req, res) => {
  try {
    const payload = req.body?.limites;
    if (!Array.isArray(payload)) return res.status(400).json({ erro: 'limites deve ser um array' });
    await db.salvarLimitesBatch(req.usuarioId, payload);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] PUT /api/limites:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Limitadores de gasto (grupos nomeados de subcategorias com teto) ─────────

app.get('/api/limitadores', autenticar, async (req, res) => {
  try {
    res.json(await db.listarLimitadores(req.usuarioId));
  } catch (err) {
    console.error('[WEB] GET /api/limitadores:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Mensagens de erro por código do banco — o painel mostra o texto direto, então
// "categoria em uso" precisa dizer QUAL categoria e em qual limitador ela está.
function mensagemErroLimitador(resultado) {
  switch (resultado.erro) {
    case 'nome_obrigatorio': return 'Dê um nome ao limitador (ex: Mercado).';
    case 'sem_categorias':   return 'Escolha ao menos uma subcategoria.';
    case 'sem_teto':         return 'Defina o teto semanal, o mensal, ou os dois.';
    case 'nome_duplicado':   return 'Você já tem um limitador com esse nome.';
    case 'nao_encontrado':   return 'Limitador não encontrado.';
    case 'categoria_em_uso':
      return `Já está em outro limitador: ${resultado.conflitos.map(c => `${c.categoria} (${c.limitador})`).join(', ')}.`;
    default: return 'Não consegui salvar o limitador.';
  }
}

// POST cria e PUT atualiza, mas os dois caem na mesma função do banco: a
// diferença é só a presença do id, e duplicar a validação em dois caminhos é
// como se cria divergência entre criar e editar.
async function salvarLimitadorHandler(req, res, id) {
  try {
    const resultado = await db.salvarLimitador(req.usuarioId, { ...req.body, id });
    if (!resultado.ok) return res.status(400).json({ erro: mensagemErroLimitador(resultado) });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] salvar limitador:', err.message);
    res.status(500).json({ erro: err.message });
  }
}

app.post('/api/limitadores', autenticar, (req, res) => salvarLimitadorHandler(req, res, null));
app.put('/api/limitadores/:id', autenticar, (req, res) => salvarLimitadorHandler(req, res, req.params.id));

app.delete('/api/limitadores/:id', autenticar, async (req, res) => {
  try {
    const nome = await db.excluirLimitador(req.usuarioId, req.params.id);
    if (!nome) return res.status(404).json({ erro: 'Limitador não encontrado.' });
    res.json({ ok: true, nome });
  } catch (err) {
    console.error('[WEB] DELETE /api/limitadores:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Consumo dos tetos nas duas janelas (semana ISO + mês corrente). Sempre o
// período ATUAL — não aceita mês/ano por querystring de propósito: teto é
// controle do que dá para gastar de aqui até o fim da janela, não relatório
// histórico (para histórico existem os gráficos do dashboard).
app.get('/api/limitadores/consumo', autenticar, async (req, res) => {
  try {
    res.json(await db.listarConsumoLimitadores(req.usuarioId));
  } catch (err) {
    console.error('[WEB] GET /api/limitadores/consumo:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Subcategorias (criar/excluir vinculada a categoria principal) ────────────

app.post('/api/subcategorias', autenticar, async (req, res) => {
  try {
    const { nome, parent } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    if (!parent || !parent.trim()) return res.status(400).json({ erro: 'Categoria principal obrigatória' });
    await db.criarSubcategoria(req.usuarioId, nome.trim(), parent.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] POST /api/subcategorias:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/subcategorias/:nome', autenticar, async (req, res) => {
  try {
    const nome = decodeURIComponent(req.params.nome);
    const resultado = await db.excluirSubcategoria(req.usuarioId, nome);
    if (!resultado) return res.status(404).json({ erro: 'Subcategoria não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/subcategorias:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/salario', autenticar, async (req, res) => {
  try {
    const salario = await db.buscarSalarioUsuario(req.usuarioId);
    res.json({ salario });
  } catch (err) {
    console.error('[WEB] GET /api/salario:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Categorias Principais (por usuário) ───────────────────────────────────────
app.get('/api/categorias-principais', autenticar, async (req, res) => {
  try {
    let cats = await db.listarCategoriasPrincipais(req.usuarioId);
    if (cats.length === 0) {
      await db.inicializarCategoriasPrincipais(req.usuarioId);
      cats = await db.listarCategoriasPrincipais(req.usuarioId);
    }
    res.json(cats);
  } catch (err) {
    console.error('[WEB] GET /api/categorias-principais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/categorias-principais', autenticar, async (req, res) => {
  try {
    const { nome, percentual, ordem } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    if (percentual == null || percentual < 0) return res.status(400).json({ erro: 'Percentual inválido' });
    const cat = await db.criarCategoriaPrincipal(req.usuarioId, nome, percentual, ordem);
    res.json(cat);
  } catch (err) {
    console.error('[WEB] POST /api/categorias-principais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/categorias-principais', autenticar, async (req, res) => {
  try {
    const { categorias } = req.body;
    if (!Array.isArray(categorias)) return res.status(400).json({ erro: 'categorias deve ser um array' });
    await db.salvarCategoriasPrincipaisBatch(req.usuarioId, categorias);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] PUT /api/categorias-principais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/categorias-principais/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ erro: 'ID inválido' });
    const result = await db.excluirCategoriaPrincipal(req.usuarioId, id);
    if (!result) return res.status(404).json({ erro: 'Categoria principal não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/categorias-principais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Categorias ────────────────────────────────────────────────────────────────
// Sem ?tipo: mantém comportamento legado (lista global, sem usuário/tipo) para não
// quebrar call sites existentes. Com ?tipo=despesa|receita: retorna as subcategorias
// (ou categorias principais sem subcategoria) do usuário logado, já filtradas por tipo —
// mesma fonte usada pela IA (categorias_principais/limites_categoria).
app.get('/api/categories', autenticar, async (req, res) => {
  try {
    const { tipo } = req.query;
    if (tipo === 'despesa' || tipo === 'receita') {
      return res.json(await db.listarSubcategoriasPorTipo(req.usuarioId, tipo));
    }
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

// ── Criar transação ──────────────────────────────────────────────────────────
app.post('/api/transactions', autenticar, async (req, res) => {
  try {
    const { tipo, valor, descricao, categoria, data, status, cartao_id, parcelas, conta_id } = req.body;
    if (!tipo || !valor || !descricao || !data) {
      return res.status(400).json({ erro: 'tipo, valor, descricao e data são obrigatórios' });
    }
    if (!['receita', 'despesa'].includes(tipo)) {
      return res.status(400).json({ erro: 'tipo deve ser receita ou despesa' });
    }
    let resultado;
    if (parcelas && parcelas > 1) {
      // adicionarTransacoesParcelas devolve um ARRAY de ids — espalhar isso num
      // objeto viraria {0:.., 1:..}. Fica sob a chave "ids".
      const ids = await db.adicionarTransacoesParcelas(
        req.usuarioId, valor, descricao, categoria || null, data, cartao_id || null, parcelas, conta_id || null
      );
      resultado = { ids };
    } else {
      resultado = await db.adicionarTransacao(
        req.usuarioId, tipo, parseFloat(valor), descricao, categoria || null,
        data, status || 'pendente', cartao_id || null, conta_id || null
      );
    }

    // Consumo dos tetos da categoria APÓS o lançamento (o front exibe o toast
    // de alerta a partir daqui). null quando a categoria não tem teto — nunca
    // impede a resposta de sucesso: o lançamento já foi gravado.
    const limitesInfo = tipo === 'despesa'
      ? await limites.resumoLimitesDaTransacao(req.usuarioId, categoria || null)
      : null;

    res.json({ ...resultado, limites: limitesInfo });
  } catch (err) {
    console.error('[WEB] POST /api/transactions:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Contas ───────────────────────────────────────────────────────────────────

app.get('/api/contas', autenticar, async (req, res) => {
  try {
    const contas = await db.calcularSaldosPorConta(req.usuarioId);
    res.json(contas);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/contas', autenticar, async (req, res) => {
  try {
    const { nome, tipo } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    const resultado = await db.criarConta(req.usuarioId, nome.trim(), tipo || null);
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/contas:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

app.put('/api/contas/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { nome, tipo } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    const resultado = await db.atualizarConta(req.usuarioId, id, nome.trim(), tipo || null);
    if (!resultado) return res.status(404).json({ erro: 'Conta não encontrada' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/contas/:id:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/contas/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const resultado = await db.excluirConta(req.usuarioId, id);
    if (!resultado) return res.status(404).json({ erro: 'Conta não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/contas/:id:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// ── Transferências entre contas ───────────────────────────────────────────────

app.get('/api/transferencias', autenticar, async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 20;
    const transferencias = await db.listarTransferencias(req.usuarioId, limite);
    res.json(transferencias);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/transferencias', autenticar, async (req, res) => {
  try {
    const { conta_origem_id, conta_destino_id, valor, descricao, data } = req.body;
    const origemId = parseInt(conta_origem_id);
    const destinoId = parseInt(conta_destino_id);
    const valorNum = parseFloat(valor);
    if (!origemId || !destinoId) return res.status(400).json({ erro: 'Conta de origem e destino são obrigatórias' });
    if (!valorNum || valorNum <= 0) return res.status(400).json({ erro: 'Valor inválido' });
    const resultado = await db.criarTransferencia(
      req.usuarioId, origemId, destinoId, valorNum, descricao || null, data || null
    );
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/transferencias:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// ── Cartões de crédito ───────────────────────────────────────────────────────

app.get('/api/cartoes', autenticar, async (req, res) => {
  try {
    const cartoes = await db.listarCartoes(req.usuarioId);
    res.json(cartoes);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/cartoes', autenticar, async (req, res) => {
  try {
    const { nome, limite_total, dia_fechamento, dia_vencimento } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    const resultado = await db.criarCartao(
      req.usuarioId, nome.trim(),
      parseFloat(limite_total) || 0,
      parseInt(dia_fechamento) || null,
      parseInt(dia_vencimento) || null
    );
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/cartoes:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/cartoes/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { campo, novo_valor } = req.body;
    if (!campo || novo_valor === undefined) return res.status(400).json({ erro: 'campo e novo_valor são obrigatórios' });
    const resultado = await db.atualizarCartao(req.usuarioId, id, campo, novo_valor);
    if (!resultado) return res.status(404).json({ erro: 'Cartão não encontrado' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/cartoes/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/cartoes/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const nome = await db.deletarCartaoCompleto(req.usuarioId, id);
    if (!nome) return res.status(404).json({ erro: 'Cartão não encontrado' });
    res.json({ ok: true, nome });
  } catch (err) {
    console.error('[WEB] DELETE /api/cartoes/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/cartoes/uso', autenticar, async (req, res) => {
  try {
    const cartoes = await db.listarCartoes(req.usuarioId);
    // db.obterUsoCartao decide Pluggy (dado real da API) vs manual (calculado
    // via calcularUsoCartao) — mesma função usada pelo agente de WhatsApp, ver
    // src/database.js.
    const comUso = await Promise.all(cartoes.map(async (c) => {
      const uso = await db.obterUsoCartao(c);
      return { id: c.id, nome: c.nome, valorUsado: uso.valorUsado, limiteTotal: uso.limiteTotal, disponivel: uso.disponivel };
    }));
    res.json(comUso);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Pluggy (Open Finance) — Marco 1: credenciais por usuário ─────────────────
// client_secret nunca é devolvido por nenhuma dessas rotas, em nenhuma hipótese
// (nem mascarado) — é write-only do ponto de vista da API.

app.post('/api/pluggy/credenciais', autenticar, async (req, res) => {
  try {
    const { client_id, client_secret } = req.body || {};
    if (!client_id || !client_secret) {
      return res.status(400).json({ erro: 'client_id e client_secret são obrigatórios' });
    }

    // Testa a credencial de verdade na API Pluggy antes de gravar — evita
    // salvar uma credencial inválida que só seria descoberta ao tentar conectar
    // um banco (Marco 2).
    await pluggy.gerarApiKey(client_id, client_secret);

    await db.salvarCredencialPluggy(req.usuarioId, client_id, client_secret);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] POST /api/pluggy/credenciais:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

app.get('/api/pluggy/credenciais', autenticar, async (req, res) => {
  try {
    const configurado = await db.usuarioTemCredencialPluggy(req.usuarioId);
    res.json({ configurado });
  } catch (err) {
    console.error('[WEB] GET /api/pluggy/credenciais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/pluggy/credenciais', autenticar, async (req, res) => {
  try {
    await db.removerCredencialPluggy(req.usuarioId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/pluggy/credenciais:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Pluggy (Open Finance) — Marco 2: fluxo de conexão ─────────────────────────

app.get('/api/pluggy/connect-token', autenticar, async (req, res) => {
  try {
    const credencial = await db.buscarCredencialPluggy(req.usuarioId);
    if (!credencial) {
      return res.status(400).json({ erro: 'Configure sua credencial Pluggy antes de conectar um banco.' });
    }

    // Webhook registrado a nível de aplicação (client), não por Item — ver
    // pluggy.garantirWebhookRegistrado. Não passamos webhookUrl aqui (no
    // options do connect_token) para não duplicar notificação: a doc confirma
    // que webhookUrl por-item + webhook client-level juntos geram duas
    // notificações do mesmo evento. Falha aqui não deve travar a conexão —
    // loga e segue (o botão "Sincronizar agora" cobre o caso de ficar sem
    // webhook, e o registro é retentado a cada nova conexão).
    try {
      await pluggy.garantirWebhookRegistrado(req.usuarioId);
    } catch (err) {
      console.error('[WEB] Falha ao garantir webhook registrado (conexão segue sem webhook automático):', err.message);
    }

    const connectToken = await pluggy.gerarConnectToken(credencial.clientId, credencial.clientSecret, req.usuarioId);
    res.json({ connectToken });
  } catch (err) {
    console.error('[WEB] GET /api/pluggy/connect-token:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// URL do webhook do usuário, para colar manualmente no dashboard da Pluggy
// (fallback caso o registro automático via POST /webhooks não seja possível
// ou o usuário prefira gerenciar por lá). Gera o webhook_token mesmo que o
// usuário nunca tenha tentado o registro automático — a URL precisa existir
// de qualquer forma para fazer sentido colar em algum lugar.
app.get('/api/pluggy/webhook-url', autenticar, async (req, res) => {
  try {
    const temCredencial = await db.usuarioTemCredencialPluggy(req.usuarioId);
    if (!temCredencial) {
      return res.status(400).json({ erro: 'Configure sua credencial Pluggy antes.' });
    }
    const baseUrl = process.env.PAINEL_BASE_URL;
    if (!baseUrl) {
      return res.status(500).json({ erro: 'PAINEL_BASE_URL não configurada no servidor.' });
    }
    const webhookToken = await db.obterOuCriarWebhookTokenPluggy(req.usuarioId);
    const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhook/pluggy/${webhookToken}`;
    res.json({ webhookUrl });
  } catch (err) {
    console.error('[WEB] GET /api/pluggy/webhook-url:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// Chamado pelo frontend a partir do onSuccess do widget (client-side) — nunca
// confia em dado vindo do frontend além do itemId: busca o Item e as Accounts
// de verdade na API Pluggy (server-side, com a API Key do usuário) antes de
// criar qualquer coisa.
app.post('/api/pluggy/item-callback', autenticar, async (req, res) => {
  try {
    const { itemId } = req.body || {};
    if (!itemId) return res.status(400).json({ erro: 'itemId é obrigatório' });

    const resultado = await pluggy.conectarItem(req.usuarioId, itemId);
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[WEB] POST /api/pluggy/item-callback:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

app.get('/api/pluggy/items', autenticar, async (req, res) => {
  try {
    const items = await db.listarPluggyItems(req.usuarioId);
    res.json(items);
  } catch (err) {
    console.error('[WEB] GET /api/pluggy/items:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Sincronização manual — ação explícita do usuário (botão no painel), por
// isso roda de forma síncrona (responde só depois de terminar), diferente do
// webhook (que responde 2XX antes de processar por causa do limite de 5s da
// Pluggy). Cobre o caso de Items conectados antes de terem webhook associado
// (achado em produção) e serve como "puxar agora" a qualquer momento.
//
// body { completo: true } faz a re-sincronização COMPLETA: ignora
// ultimo_sync_em e rebusca toda a janela da Pluggy, recategorizando o
// histórico já importado (respeitando categoria corrigida à mão). É bem mais
// pesada que o incremental, por isso é opt-in e nunca o padrão.
app.post('/api/pluggy/items/:itemId/sincronizar', autenticar, async (req, res) => {
  try {
    const { itemId } = req.params;
    const completo = req.body?.completo === true;
    const item = await db.buscarPluggyItemDoUsuario(req.usuarioId, itemId);
    if (!item) return res.status(404).json({ erro: 'Item não encontrado.' });

    // Aproveita a ação explícita para garantir que o Item passa a notificar
    // sozinho dali pra frente — sem isso, um Item antigo sem webhook exigiria
    // clicar "Sincronizar agora" manualmente para sempre.
    try {
      await pluggy.garantirWebhookRegistrado(req.usuarioId);
    } catch (err) {
      console.error('[WEB] Falha ao garantir webhook registrado (sincronização manual segue de qualquer forma):', err.message);
    }

    const resultado = await pluggy.sincronizarItem(req.usuarioId, itemId, { completo });
    res.json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[WEB] POST /api/pluggy/items/:itemId/sincronizar:', err.message);
    res.status(400).json({ erro: err.message });
  }
});

// ── Reservas (caixinhas manuais, com meta definida pelo usuário) ─────────────
// Conceito distinto de Investimentos (posições reais sincronizadas do banco —
// endpoints logo abaixo). A rota mantém o nome /api/caixinhas para não quebrar
// cliente já publicado; só o rótulo na UI mudou.
app.get('/api/caixinhas', autenticar, async (req, res) => {
  try {
    res.json(await db.listarCaixinhas(req.usuarioId));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/caixinhas', autenticar, async (req, res) => {
  try {
    const { nome, saldo, meta, tipo, rendimento_mensal } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    const resultado = await db.criarCaixinha(
      req.usuarioId, nome.trim(),
      parseFloat(saldo) || 0,
      parseFloat(meta) || null,
      tipo || null,
      parseFloat(rendimento_mensal) || null
    );
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/caixinhas:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/caixinhas/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { campo, novo_valor } = req.body;
    if (!campo || novo_valor === undefined) return res.status(400).json({ erro: 'campo e novo_valor são obrigatórios' });
    const resultado = await db.atualizarCaixinha(req.usuarioId, id, campo, novo_valor);
    if (!resultado) return res.status(404).json({ erro: 'Caixinha não encontrada' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/caixinhas/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/caixinhas/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const resultado = await db.excluirCaixinha(req.usuarioId, id);
    if (!resultado) return res.status(404).json({ erro: 'Caixinha não encontrada' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/caixinhas/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/caixinhas/:id/deposito', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { valor } = req.body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: 'Valor deve ser positivo' });
    const resultado = await db.adicionarSaldoCaixinha(id, parseFloat(valor));
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/caixinhas/:id/deposito:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Investimentos (posições reais sincronizadas do banco via Pluggy) ─────────
// Devolve o resumo agregado junto das posições: a UI agrupa por emissor e só
// expande a lista completa sob demanda (uma carteira de renda fixa passa
// facilmente de setenta ativos, listar tudo de cara não informa nada).
app.get('/api/investimentos', autenticar, async (req, res) => {
  try {
    const [resumo, posicoes] = await Promise.all([
      db.resumoInvestimentos(req.usuarioId),
      db.listarInvestimentos(req.usuarioId),
    ]);
    res.json({ ...resumo, posicoes });
  } catch (err) {
    console.error('[WEB] GET /api/investimentos:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Patrimônio consolidado: sempre com os componentes, nunca só o total — ver
// db.calcularPatrimonio para o porquê de a composição ser obrigatória.
app.get('/api/patrimonio', autenticar, async (req, res) => {
  try {
    res.json(await db.calcularPatrimonio(req.usuarioId));
  } catch (err) {
    console.error('[WEB] GET /api/patrimonio:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Google Calendar OAuth ────────────────────────────────────────────────────

app.get('/auth/google/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).send('Google Calendar não configurado');
  const token = req.query.token;
  if (!token) return res.status(400).send('Token ausente');
  // Codifica o JWT no state para recuperar após callback
  const state = Buffer.from(JSON.stringify({ token })).toString('base64url');
  const url = gcal.getAuthUrl(state);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Parâmetros inválidos');

    // Decodificar JWT do state
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString());
    const payload = getJwt().verify(decoded.token, jwtSecret());
    const usuarioId = payload.usuarioId;

    // Trocar code por tokens e salvar
    const tokens = await gcal.exchangeCode(code);
    await db.salvarGoogleTokens(usuarioId, tokens);
    console.log(`[GCAL] Usuário ${usuarioId} conectou Google Calendar`);

    // Redirecionar de volta ao painel com flag de sucesso
    const base = process.env.PAINEL_BASE_URL || '';
    res.redirect(`${base}/#google-connected`);
  } catch (err) {
    console.error('[GCAL] Erro no callback:', err.message);
    res.status(500).send('Erro ao conectar Google Calendar. Tente novamente.');
  }
});

app.get('/api/google/status', autenticar, async (req, res) => {
  try {
    const conectado = await gcal.isConectado(req.usuarioId);
    res.json({ conectado });
  } catch (err) {
    res.json({ conectado: false });
  }
});

app.post('/api/google/disconnect', autenticar, async (req, res) => {
  try {
    await db.removerGoogleTokens(req.usuarioId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Lembretes ────────────────────────────────────────────────────────────────
app.post('/api/lembretes', autenticar, async (req, res) => {
  try {
    const { mensagem, dispara_em } = req.body;
    if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem obrigatória' });
    if (!dispara_em) return res.status(400).json({ erro: 'Data/hora obrigatória' });
    const resultado = await db.criarLembreteGeral(req.usuarioId, mensagem.trim(), dispara_em);
    // Sync Google Calendar (fire-and-forget)
    gcal.sincronizarLembreteAvulso(req.usuarioId, resultado.id, mensagem.trim(), dispara_em).catch(() => {});
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/lembretes:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/lembretes/recorrente', autenticar, async (req, res) => {
  try {
    const { mensagem, horario, frequencia, dia_semana, dia_mes, data_fim } = req.body;
    if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem obrigatória' });
    if (!horario) return res.status(400).json({ erro: 'Horário obrigatório' });
    if (!frequencia) return res.status(400).json({ erro: 'Frequência obrigatória' });
    const resultado = await db.criarLembreteRecorrente(
      req.usuarioId, mensagem.trim(), horario, frequencia,
      dia_semana != null ? parseInt(dia_semana) : null,
      dia_mes != null ? parseInt(dia_mes) : null,
      data_fim || null,
      false
    );
    // Sync Google Calendar (fire-and-forget)
    gcal.sincronizarLembreteRecorrente(
      req.usuarioId, resultado.id, mensagem.trim(), horario, frequencia,
      dia_semana, dia_mes, data_fim || null
    ).catch(() => {});
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/lembretes/recorrente:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/lembretes/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    // Remover do Google Calendar antes de deletar
    const eventId = await db.buscarGoogleEventId('lembretes_gerais', id);
    if (eventId) gcal.removerEvento(req.usuarioId, eventId).catch(() => {});
    await db.cancelReminder(id, req.usuarioId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/lembretes/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/lembretes/recorrente/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    // Remover do Google Calendar antes de deletar
    const eventId = await db.buscarGoogleEventId('lembretes_recorrentes', id);
    if (eventId) gcal.removerEvento(req.usuarioId, eventId).catch(() => {});
    await db.cancelarLembreteRecorrente(req.usuarioId, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/lembretes/recorrente/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Recorrências ─────────────────────────────────────────────────────────────
// ?competencia=YYYY-MM (default: mês corrente) — cada regra volta com `balde`:
// estado do mês de acumulação (soma real, previsto, falta, consolidado). Uma
// única query agregada em buscarEstadosBaldeMes cobre todas as regras, sem
// N+1 por linha.
app.get('/api/recorrencias', autenticar, async (req, res) => {
  try {
    const competencia = String(req.query.competencia || '');
    const regras = await db.listarRecorrencias(req.usuarioId);
    const estados = await db.buscarEstadosBaldeMes(req.usuarioId, competencia, regras);
    res.json(regras.map(r => ({ ...r, balde: estados.get(r.id) || null })));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/recorrencias', autenticar, async (req, res) => {
  try {
    const { tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, data_fim, cartao_id, conta_id } = req.body;
    if (!tipo || !valor || !descricao || !frequencia) {
      return res.status(400).json({ erro: 'tipo, valor, descricao e frequencia são obrigatórios' });
    }
    const resultado = await db.criarRecorrencia(
      req.usuarioId, tipo, parseFloat(valor), descricao, categoria || null,
      frequencia,
      dia_mes != null ? parseInt(dia_mes) : null,
      dia_semana != null ? parseInt(dia_semana) : null,
      data_inicio || new Date().toISOString().substring(0, 10),
      data_fim || null,
      cartao_id != null ? parseInt(cartao_id) : null,
      conta_id  != null ? parseInt(conta_id)  : null
    );
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] POST /api/recorrencias:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/recorrencias/:id', autenticar, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'ID inválido' });
    const { campo, novo_valor } = req.body;
    if (!campo || novo_valor === undefined) return res.status(400).json({ erro: 'campo e novo_valor são obrigatórios' });
    const resultado = await db.atualizarRecorrencia(req.usuarioId, id, campo, novo_valor);
    if (!resultado) return res.status(404).json({ erro: 'Recorrência não encontrada' });
    res.json(resultado);
  } catch (err) {
    console.error('[WEB] PUT /api/recorrencias/:id:', err.message);
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

// ── Webhook Pluggy (Open Finance) — Marco 3 ───────────────────────────────────
// Endpoint público (sem middleware autenticar — não há JWT de usuário aqui,
// o :token na URL é o único mecanismo de autenticação). Pluggy não assina o
// payload (sem HMAC nativo confirmado na doc) — o token de alta entropia
// (24 bytes, gerado por usuário em obterOuCriarWebhookTokenPluggy) é a defesa
// real: sem ele, rejeita com 401 sem processar nada do corpo.
//
// Responde 2XX imediatamente (exigência Pluggy: <5s, senão retry) e processa
// em segundo plano, fora do ciclo de resposta — sincronizar transações pode
// levar mais que 5s (365 dias de histórico na primeira vez). Trade-off consciente:
// isso roda fire-and-forget no próprio processo do webserver, não numa fila
// dedicada (o projeto já tem BullMQ para lembretes, ver src/worker-reminders.js,
// mas criar uma fila nova para isso é mudança de infra maior que o escopo deste
// marco — reavaliar se o volume de usuários/transações crescer muito).
app.post('/webhook/pluggy/:token', async (req, res) => {
  const { token } = req.params;

  let usuarioId;
  try {
    usuarioId = await db.buscarUsuarioIdPorWebhookToken(token);
  } catch (err) {
    console.error('[WEBHOOK PLUGGY] Erro ao validar token:', err.message);
    return res.status(500).json({ erro: 'Erro interno' });
  }

  if (!usuarioId) {
    return res.status(401).json({ erro: 'Token inválido' });
  }

  console.log('[WEBHOOK PLUGGY] Evento recebido:', req.body?.event, 'item:', req.body?.itemId);
  res.status(200).json({ ok: true });

  pluggy.processarWebhookEvent(usuarioId, req.body).catch((err) => {
    console.error('[WEBHOOK PLUGGY] Erro ao processar evento em segundo plano:', err.message);
  });
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

    const [gerais, recorrentes, reminders] = await Promise.all([
      db.buscarLembretesGeraisPorPeriodo(req.usuarioId, dataInicio, dataFim),
      db.buscarLembretesRecorrentesPorMes(req.usuarioId, ano, mes),
      db.buscarRemindersPorPeriodo(req.usuarioId, dataInicio, dataFim),
    ]);

    // Mescla e ordena por data_disparo + hora
    const todos = [...gerais, ...recorrentes, ...reminders].sort((a, b) => {
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

// Upload de logo (admin)
app.post('/api/admin/logo', autenticarAdmin, async (req, res) => {
  try {
    const { b64 } = req.body || {};
    if (!b64 || !b64.startsWith('data:image/')) {
      return res.status(400).json({ erro: 'Imagem inválida' });
    }
    if (b64.length > 700000) {
      return res.status(400).json({ erro: 'Imagem muito grande (máx 500KB)' });
    }
    const imgDir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const cleanB64 = b64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');
    fs.writeFileSync(path.join(imgDir, 'logo.png'), buffer);
    console.log(`[ADMIN] Logo atualizado (${buffer.length} bytes)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /api/admin/logo:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Upload de favicon (admin)
app.post('/api/admin/favicon', autenticarAdmin, async (req, res) => {
  try {
    const { b64 } = req.body || {};
    if (!b64 || !b64.startsWith('data:image/')) {
      return res.status(400).json({ erro: 'Imagem inválida' });
    }
    if (b64.length > 700000) {
      return res.status(400).json({ erro: 'Imagem muito grande (máx 500KB)' });
    }
    const imgDir = path.join(__dirname, '../public/img');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const cleanB64 = b64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');
    fs.writeFileSync(path.join(imgDir, 'favicon.png'), buffer);
    console.log(`[ADMIN] Favicon atualizado (${buffer.length} bytes)`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /api/admin/favicon:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

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

// Pausa o bot para um usuário específico (admin pode conversar sem interferência)
app.post('/api/admin/pausar', autenticarAdmin, async (req, res) => {
  try {
    const { usuarioId } = req.body || {};
    if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatório' });
    await db.pausarUsuario(usuarioId);
    console.log(`[ADMIN] Bot pausado para ${usuarioId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /api/admin/pausar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Retoma o bot para um usuário específico
app.post('/api/admin/retomar', autenticarAdmin, async (req, res) => {
  try {
    const { usuarioId } = req.body || {};
    if (!usuarioId) return res.status(400).json({ erro: 'usuarioId obrigatório' });
    await db.retomarUsuario(usuarioId);
    console.log(`[ADMIN] Bot retomado para ${usuarioId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ADMIN] /api/admin/retomar:', err.message);
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

// ── Feedback ────────────────────────────────────────────────────────────────

// Lista usuários elegíveis para feedback com filtro por dias após primeiro acesso
app.get('/api/admin/feedback/destinatarios', autenticarAdmin, async (req, res) => {
  try {
    const diasAposAcesso = parseInt(req.query.dias_apos_acesso) || 0;
    const usuarios = await db.listarUsuariosFeedback(diasAposAcesso);
    res.json({ total: usuarios.length, usuarios });
  } catch (err) {
    console.error('[FEEDBACK] /destinatarios:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Cria campanha de feedback e envia mensagens via WhatsApp
app.post('/api/admin/feedback/enviar', autenticarAdmin, async (req, res) => {
  try {
    const { mensagem, dias_apos_acesso, usuario_ids } = req.body || {};
    if (!mensagem?.trim()) return res.status(400).json({ erro: 'Mensagem obrigatória' });

    let usuarios;
    if (usuario_ids && Array.isArray(usuario_ids) && usuario_ids.length > 0) {
      const todos = await db.listarUsuariosFeedback(0);
      usuarios = todos.filter(u => usuario_ids.includes(u.usuario_id));
    } else {
      usuarios = await db.listarUsuariosFeedback(dias_apos_acesso || 0);
    }

    if (usuarios.length === 0) {
      return res.json({ ok: true, total: 0, campanhaId: null, aviso: 'Nenhum usuário encontrado.' });
    }

    // Deduplicar
    const vistos = new Set();
    const usuariosUnicos = usuarios.filter(u => {
      if (vistos.has(u.usuario_id)) return false;
      vistos.add(u.usuario_id);
      return true;
    });

    const campanhaId = await db.criarFeedbackCampanha(mensagem.trim(), dias_apos_acesso || null, usuariosUnicos.length);
    res.json({ ok: true, total: usuariosUnicos.length, campanhaId });

    const whatsappClient = app.get('whatsappClient');
    if (!whatsappClient) {
      await db.atualizarProgressoFeedbackCampanha(campanhaId, 0, 0, true);
      return;
    }

    // Envio assíncrono com delay aleatório 5-15s
    (async () => {
      let enviados = 0, erros = 0;
      console.log(`[FEEDBACK] Campanha ${campanhaId} iniciada — ${usuariosUnicos.length} destinatários`);

      for (let i = 0; i < usuariosUnicos.length; i++) {
        const usuario = usuariosUnicos[i];
        try {
          const primeiroNome = (usuario.nome || '').split(' ')[0] || 'amigo(a)';
          const msg = mensagem.trim().replace(/\{nome\}/gi, primeiroNome);
          await whatsappClient.sendMessage(usuario.usuario_id, msg);
          enviados++;
          await db.registrarDestinatarioFeedback(campanhaId, usuario.usuario_id, usuario.nome);
        } catch (err) {
          erros++;
          console.error(`[FEEDBACK] Erro ao enviar para ${usuario.usuario_id}:`, err.message);
        }
        if (i < usuariosUnicos.length - 1) {
          const delay = Math.floor(5000 + Math.random() * 10000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      await db.atualizarProgressoFeedbackCampanha(campanhaId, enviados, erros, true);
      console.log(`[FEEDBACK] Campanha ${campanhaId} finalizada — enviados: ${enviados}, erros: ${erros}`);
    })();
  } catch (err) {
    console.error('[FEEDBACK] /enviar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Lista campanhas de feedback com totais
app.get('/api/admin/feedback/campanhas', autenticarAdmin, async (req, res) => {
  try {
    const campanhas = await db.listarFeedbackCampanhas();
    res.json({ campanhas });
  } catch (err) {
    console.error('[FEEDBACK] /campanhas:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// Detalhe de uma campanha com todas as respostas
app.get('/api/admin/feedback/campanhas/:id', autenticarAdmin, async (req, res) => {
  try {
    const { campanha, respostas } = await db.buscarFeedbackCampanha(req.params.id);
    if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
    res.json({ campanha, respostas });
  } catch (err) {
    console.error('[FEEDBACK] /campanhas/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
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

// ── Crons Admin ───────────────────────────────────────────────────────────────

app.get('/api/admin/crons', autenticarAdmin, async (req, res) => {
  try {
    const crons = await db.listarAdminCrons();
    res.json(crons);
  } catch (err) {
    console.error('[CRON-ADMIN] GET /crons:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/crons', autenticarAdmin, async (req, res) => {
  try {
    const { titulo, mensagem, frequencia, horario, regra, regra_valor, usuario_ids } = req.body || {};
    if (!titulo?.trim() || !mensagem?.trim() || !regra || !frequencia) {
      return res.status(400).json({ erro: 'titulo, mensagem, frequencia e regra são obrigatórios' });
    }
    if (!cronAdmin.FREQUENCIAS[frequencia]) {
      return res.status(400).json({ erro: 'Frequência inválida' });
    }
    const novaCron = await db.criarAdminCron(
      titulo.trim(), mensagem.trim(), frequencia, horario || null,
      regra, regra_valor || null, usuario_ids || null
    );
    res.json(novaCron);
  } catch (err) {
    console.error('[CRON-ADMIN] POST /crons:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/admin/crons/:id', autenticarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const campos = {};
    const permitidos = ['titulo', 'mensagem', 'frequencia', 'horario', 'regra', 'regra_valor', 'usuario_ids', 'ativo'];
    for (const key of permitidos) {
      if (req.body[key] !== undefined) campos[key] = req.body[key];
    }
    if (campos.frequencia && !cronAdmin.FREQUENCIAS[campos.frequencia]) {
      return res.status(400).json({ erro: 'Frequência inválida' });
    }
    const atualizada = await db.atualizarAdminCron(id, campos);
    if (!atualizada) return res.status(404).json({ erro: 'Cron não encontrada' });
    res.json(atualizada);
  } catch (err) {
    console.error('[CRON-ADMIN] PUT /crons/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/admin/crons/:id', autenticarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.excluirAdminCron(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[CRON-ADMIN] DELETE /crons/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/admin/crons/:id/executar', autenticarAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const c = await db.buscarAdminCron(id);
    if (!c) return res.status(404).json({ erro: 'Cron não encontrada' });
    const whatsappClient = app.get('whatsappClient');
    if (!whatsappClient) return res.status(503).json({ erro: 'WhatsApp não disponível' });
    // Executa em background
    cronAdmin.executarCron(id, whatsappClient);
    res.json({ ok: true, mensagem: 'Execução iniciada em background' });
  } catch (err) {
    console.error('[CRON-ADMIN] POST /crons/:id/executar:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/admin/crons/preview', autenticarAdmin, async (req, res) => {
  try {
    const { regra, valor } = req.query;
    if (!regra) return res.status(400).json({ erro: 'regra é obrigatória' });
    const usuarios = await cronAdmin.resolverDestinatarios(regra, parseInt(valor) || null, null);
    res.json({ total: usuarios.length, usuarios });
  } catch (err) {
    console.error('[CRON-ADMIN] GET /crons/preview:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/api/admin/crons/usuarios-busca', autenticarAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const usuarios = await db.buscarUsuariosParaSelect(q);
    res.json(usuarios.map(u => ({ id: u.usuario_id, text: u.nome ? `${u.nome} (${u.usuario_id})` : u.usuario_id })));
  } catch (err) {
    console.error('[CRON-ADMIN] GET /usuarios-busca:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Admin API (API Key — para N8N) ───────────────────────────────────────────
app.post('/admin/send', async (req, res) => {
  console.log(`📥 [ADMIN SEND] ${new Date().toISOString()} Requisição recebida — headers: x-admin-key=${req.headers['x-admin-key'] ? 'presente' : 'ausente'}`);
  console.log(`📥 [ADMIN SEND] Body: to=${req.body?.to}, message=${req.body?.message?.substring(0, 50)}, imageUrl=${req.body?.imageUrl ? 'sim' : 'não'}`);

  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    console.log('🚫 [ADMIN SEND] API key inválida');
    return res.status(401).json({ ok: false, error: 'API key inválida' });
  }

  const body = req.body || {};
  const { to, message, imageUrl } = body;
  if (!to || !message) {
    console.log(`🚫 [ADMIN SEND] Campos obrigatórios faltando — body type: ${typeof req.body}, raw: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ ok: false, error: 'Campos "to" e "message" são obrigatórios' });
  }

  const whatsappClient = app.get('whatsappClient');
  if (!whatsappClient) {
    console.log('🚫 [ADMIN SEND] WhatsApp client não disponível');
    return res.status(503).json({ ok: false, error: 'WhatsApp client não disponível' });
  }

  console.log('✅ [ADMIN SEND] Respondendo ok e iniciando envio em background');
  res.json({ ok: true });

  (async () => {
    try {
      const numberId = to.endsWith('@c.us') ? to.replace('@c.us', '') : to;
      console.log(`🔍 [ADMIN SEND] Resolvendo número: ${numberId}`);
      const registrado = await whatsappClient.getNumberId(numberId);
      if (!registrado) {
        console.log(`🚫 [ADMIN SEND] Número ${numberId} não encontrado no WhatsApp`);
        return;
      }
      const chatId = registrado._serialized;
      console.log(`🔍 [ADMIN SEND] Número resolvido → ${chatId}`);

      const cleanImageUrl = imageUrl ? imageUrl.replace(/^=/, '').trim() : null;
      if (cleanImageUrl) {
        const { MessageMedia } = require('whatsapp-web.js');
        let media;

        // Se a imagem é local (salva via /admin/upload-image), lê direto do disco
        const baseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
        if (baseUrl && cleanImageUrl.startsWith(baseUrl + '/images/')) {
          const filename = cleanImageUrl.split('/images/').pop();
          const localPath = path.join(UPLOAD_DIR, filename);
          console.log(`🖼️ [ADMIN SEND] Lendo imagem local: ${localPath}`);
          media = MessageMedia.fromFilePath(localPath);
        } else {
          console.log(`🖼️ [ADMIN SEND] Baixando imagem: ${cleanImageUrl.substring(0, 80)}...`);
          media = await MessageMedia.fromUrl(cleanImageUrl, { unsafeMime: true });
        }

        console.log(`🖼️ [ADMIN SEND] Imagem pronta (${media.data.length} bytes), enviando...`);
        await whatsappClient.sendMessage(chatId, media, { caption: message });
      } else {
        await whatsappClient.sendMessage(chatId, message);
      }
      console.log(`📤 [ADMIN SEND] ${new Date().toISOString()} Enviado com sucesso → ${chatId}`);
    } catch (err) {
      console.error(`❌ [ADMIN SEND] Erro background: ${err.message}`);
      console.error(err.stack);
    }
  })();
});

app.post('/admin/upload-image', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ ok: false, error: 'API key inválida' });
  }

  const body = req.body || {};
  const { b64, filename } = body;
  if (!b64) {
    return res.status(400).json({ ok: false, error: 'Campo "b64" é obrigatório' });
  }

  try {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    const crypto = require('crypto');
    const nome = filename || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
    const filePath = path.join(UPLOAD_DIR, nome);

    // Limpar prefixo data URL se presente (ex: "data:image/png;base64,iVBOR...")
    const cleanB64 = b64.replace(/^=/, '').replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(cleanB64, 'base64');
    console.log(`🖼️ [UPLOAD] Base64 recebido: ${b64.substring(0, 50)}... (${cleanB64.length} chars → ${buffer.length} bytes)`);
    fs.writeFileSync(filePath, buffer);

    const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://seasy.host').replace(/\/$/, '');
    const url = `${baseUrl}/images/${nome}`;

    console.log(`🖼️ [UPLOAD] Imagem salva: ${filePath} → ${url} (${buffer.length} bytes)`);
    return res.json({ ok: true, url });
  } catch (err) {
    console.error('❌ [UPLOAD] Erro:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
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
