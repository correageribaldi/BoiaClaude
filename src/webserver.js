const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const pagamento = require('./pagamento');
const cronAdmin = require('./cron-admin');

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

        // Excluir projeções já cobertas por transação real (qualquer status, para cobrir itens pulados)
        // Busca sem filtro de status para garantir que itens "pago" (pulados) também suprimam projeções
        const todasNoMes = status
          ? await db.consultarTransacoes(req.usuarioId, { dataInicio: dataInicio || null, dataFim: dataFim || null, limite: 1000 })
          : transacoes;
        const idsComTransacao = new Set(
          todasNoMes
            .filter(t => t.recorrencia_id != null)
            .map(t => t.recorrencia_id)
        );

        const projetadas = ocorrencias
          .filter(o => !idsComTransacao.has(o.recorrencia_id))
          .filter(o => !tipo || o.tipo === tipo)
          .filter(o => !descricao || o.descricao.toLowerCase().includes(descricao.toLowerCase()));

        // Auto-materializar projeções do mês atual como transações reais
        const hojeISO = new Date().toISOString().substring(0, 10);
        const anoMesAtual = hojeISO.substring(0, 7);
        const periodoEhMesAtual = dataInicio && dataInicio.substring(0, 7) === anoMesAtual;

        if (periodoEhMesAtual && projetadas.length > 0) {
          for (const proj of projetadas) {
            try {
              await db.adicionarTransacaoComRecorrencia(
                req.usuarioId, proj.tipo, proj.valor, proj.descricao, proj.categoria,
                proj.data, 'pendente', proj.recorrencia_id
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
      data, 'pago', recorrencia_id
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
    const { limites } = req.body;
    if (!Array.isArray(limites)) return res.status(400).json({ erro: 'limites deve ser um array' });
    await db.salvarLimitesBatch(req.usuarioId, limites);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] PUT /api/limites:', err.message);
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

// ── Criar transação ──────────────────────────────────────────────────────────
app.post('/api/transactions', autenticar, async (req, res) => {
  try {
    const { tipo, valor, descricao, categoria, data, status, cartao_id, parcelas } = req.body;
    if (!tipo || !valor || !descricao || !data) {
      return res.status(400).json({ erro: 'tipo, valor, descricao e data são obrigatórios' });
    }
    if (!['receita', 'despesa'].includes(tipo)) {
      return res.status(400).json({ erro: 'tipo deve ser receita ou despesa' });
    }
    if (parcelas && parcelas > 1) {
      const resultado = await db.adicionarTransacoesParcelas(
        req.usuarioId, valor, descricao, categoria || null, data, cartao_id || null, parcelas
      );
      res.json(resultado);
    } else {
      const resultado = await db.adicionarTransacao(
        req.usuarioId, tipo, parseFloat(valor), descricao, categoria || null,
        data, status || 'pendente', cartao_id || null
      );
      res.json(resultado);
    }
  } catch (err) {
    console.error('[WEB] POST /api/transactions:', err.message);
    res.status(500).json({ erro: err.message });
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

// ── Caixinhas (Investimentos) ────────────────────────────────────────────────
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

// ── Lembretes ────────────────────────────────────────────────────────────────
app.post('/api/lembretes', autenticar, async (req, res) => {
  try {
    const { mensagem, dispara_em } = req.body;
    if (!mensagem || !mensagem.trim()) return res.status(400).json({ erro: 'Mensagem obrigatória' });
    if (!dispara_em) return res.status(400).json({ erro: 'Data/hora obrigatória' });
    const resultado = await db.criarLembreteGeral(req.usuarioId, mensagem.trim(), dispara_em);
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
    await db.cancelarLembreteRecorrente(req.usuarioId, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEB] DELETE /api/lembretes/recorrente/:id:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── Recorrências ─────────────────────────────────────────────────────────────
app.get('/api/recorrencias', autenticar, async (req, res) => {
  try {
    res.json(await db.listarRecorrencias(req.usuarioId));
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/recorrencias', autenticar, async (req, res) => {
  try {
    const { tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, data_fim } = req.body;
    if (!tipo || !valor || !descricao || !frequencia) {
      return res.status(400).json({ erro: 'tipo, valor, descricao e frequencia são obrigatórios' });
    }
    const resultado = await db.criarRecorrencia(
      req.usuarioId, tipo, parseFloat(valor), descricao, categoria || null,
      frequencia,
      dia_mes != null ? parseInt(dia_mes) : null,
      dia_semana != null ? parseInt(dia_semana) : null,
      data_inicio || new Date().toISOString().substring(0, 10),
      data_fim || null
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
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ ok: false, error: 'API key inválida' });
  }

  const { to, message, imageUrl } = req.body;
  if (!to || !message) {
    return res.status(400).json({ ok: false, error: 'Campos "to" e "message" são obrigatórios' });
  }

  const whatsappClient = app.get('whatsappClient');
  if (!whatsappClient) {
    return res.status(503).json({ ok: false, error: 'WhatsApp client não disponível' });
  }

  try {
    // Resolver ID real do número (evita erro "No LID for user")
    const numberId = to.endsWith('@c.us') ? to.replace('@c.us', '') : to;
    const registrado = await whatsappClient.getNumberId(numberId);
    if (!registrado) {
      return res.status(400).json({ ok: false, error: `Número ${numberId} não encontrado no WhatsApp` });
    }
    const chatId = registrado._serialized;

    let result;
    if (imageUrl) {
      const { MessageMedia } = require('whatsapp-web.js');
      const media = await MessageMedia.fromUrl(imageUrl);
      result = await whatsappClient.sendMessage(chatId, media, { caption: message });
    } else {
      result = await whatsappClient.sendMessage(chatId, message);
    }

    console.log(`📤 [ADMIN SEND] ${new Date().toISOString()} → ${chatId}: ${message.substring(0, 80)}`);
    return res.json({ ok: true, id: result.id._serialized });
  } catch (err) {
    console.error('❌ [ADMIN SEND] Erro:', err.message);
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
