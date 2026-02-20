const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Middleware de autenticação ────────────────────────────────────────────────
async function autenticar(req, res, next) {
  const token =
    req.query.token ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!token) return res.status(401).json({ erro: 'Token ausente' });

  const dados = await db.verificarTokenPainel(token).catch(() => null);
  if (!dados) return res.status(401).json({ erro: 'Token inválido ou expirado' });

  req.usuarioId = dados.usuarioId;
  next();
}

// ── Painel SPA ────────────────────────────────────────────────────────────────
app.get('/painel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/auth/verify', async (req, res) => {
  const token = req.query.token || '';
  const dados = await db.verificarTokenPainel(token).catch(() => null);
  if (!dados) return res.json({ valid: false });

  const usuario = await db.buscarUsuario(dados.usuarioId).catch(() => null);
  res.json({ valid: true, nome: usuario?.nome || null });
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

// Resumo anual (gráfico de evolução)
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
      limite: parseInt(limite) || 20,
    });
    res.json(transacoes);
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
    const cats = await db.listarCategorias();
    res.json(cats);
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

    const lembretes = await db.buscarLembretesGeraisPorPeriodo(req.usuarioId, dataInicio, dataFim);
    res.json(lembretes);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── Inicialização ─────────────────────────────────────────────────────────────
function iniciarWebServer() {
  const port = parseInt(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`🌐 Painel web rodando em http://localhost:${port}`);
  });
}

module.exports = { iniciarWebServer };
