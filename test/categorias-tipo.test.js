// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const agente = require('../src/agente-financeiro');

// Testa o bug conhecido: categorias de despesa e receita compartilhavam a mesma
// lista, causando receitas classificadas com categoria de despesa (e vice-versa).
// Cobre: buscarTipoCategoria, listarCategoriasParaIA (filtro por tipo) e a trava
// determinística validarCategoriaPorTipo usada em registrar_transacao.

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── buscarTipoCategoria ───────────────────────────────────────────────────────

test('buscarTipoCategoria: retorna tipo da subcategoria em limites_categoria', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) {
      return { rows: [{ tipo: 'despesa' }] };
    }
    return { rows: [] };
  });

  const tipo = await db.buscarTipoCategoria('user1@c.us', 'Alimentação');
  assert.equal(tipo, 'despesa');
});

test('buscarTipoCategoria: retorna tipo receita quando cadastrado como receita', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) {
      return { rows: [{ tipo: 'receita' }] };
    }
    return { rows: [] };
  });

  const tipo = await db.buscarTipoCategoria('user1@c.us', 'Salário');
  assert.equal(tipo, 'receita');
});

test('buscarTipoCategoria: retorna "ambos" quando categoria principal está marcada como ambos', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) return { rows: [] };
    if (sql.includes('FROM categorias_principais')) return { rows: [{ tipo: 'ambos' }] };
    return { rows: [] };
  });

  const tipo = await db.buscarTipoCategoria('user1@c.us', 'Investimentos');
  assert.equal(tipo, 'ambos');
});

test('buscarTipoCategoria: categoria inexistente retorna null', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const tipo = await db.buscarTipoCategoria('user1@c.us', 'CategoriaNovaInventada');
  assert.equal(tipo, null);
});

test('buscarTipoCategoria: categoria vazia/null retorna null sem consultar o banco', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  const tipo = await db.buscarTipoCategoria('user1@c.us', null);
  assert.equal(tipo, null);
  assert.equal(chamouQuery, false);
});

// ── listarCategoriasParaIA (filtro por tipo) ─────────────────────────────────

test('listarCategoriasParaIA: filtra categorias principais e subcategorias por tipo=despesa (default)', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categorias_principais')) {
      assert.equal(params[1], 'despesa');
      return { rows: [{ id: 1, nome: 'Variáveis', percentual: 20, ordem: 2 }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      assert.equal(params[1], 'despesa');
      return { rows: [{ categoria: 'Alimentação', parent: 'Variáveis' }] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarCategoriasParaIA('user1@c.us');
  assert.equal(resultado, 'Variáveis(Alimentação)');
});

test('listarCategoriasParaIA: filtra por tipo=receita quando solicitado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categorias_principais')) {
      assert.equal(params[1], 'receita');
      return { rows: [{ id: 2, nome: 'Receitas', percentual: 0, ordem: 99 }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      assert.equal(params[1], 'receita');
      return { rows: [{ categoria: 'Salário', parent: 'Receitas' }] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarCategoriasParaIA('user1@c.us', 'receita');
  assert.equal(resultado, 'Receitas(Salário)');
});

test('listarCategoriasParaIA: subcategoria legada com tipo NULL é tratada como despesa', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categorias_principais')) {
      return { rows: [{ id: 1, nome: 'Variáveis', percentual: 20, ordem: 2 }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      // Simula a query real filtrando por tipo NULL tratado como despesa
      if (params[1] === 'despesa') {
        return { rows: [{ categoria: 'Uber', parent: 'Variáveis' }] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarCategoriasParaIA('user1@c.us', 'despesa');
  assert.ok(resultado.includes('Uber'));
});

// ── listarSubcategoriasPorTipo (fonte do <select> de categoria no painel web) ─

test('listarSubcategoriasPorTipo: retorna subcategorias filtradas por tipo=despesa (default)', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categorias_principais')) {
      assert.equal(params[1], 'despesa');
      return { rows: [{ nome: 'Variáveis' }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      assert.equal(params[1], 'despesa');
      return { rows: [{ categoria: 'Alimentação', parent: 'Variáveis' }, { categoria: 'Transporte', parent: 'Variáveis' }] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarSubcategoriasPorTipo('user1@c.us');
  assert.deepEqual(resultado, ['Alimentação', 'Transporte']);
});

test('listarSubcategoriasPorTipo: filtra por tipo=receita quando solicitado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categorias_principais')) {
      assert.equal(params[1], 'receita');
      return { rows: [{ nome: 'Receitas' }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      assert.equal(params[1], 'receita');
      return { rows: [{ categoria: 'Salário', parent: 'Receitas' }] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarSubcategoriasPorTipo('user1@c.us', 'receita');
  assert.deepEqual(resultado, ['Salário']);
});

test('listarSubcategoriasPorTipo: categoria principal sem subcategoria aparece pelo próprio nome', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categorias_principais')) {
      return { rows: [{ nome: 'Investimentos' }] };
    }
    if (sql.includes('FROM limites_categoria')) {
      return { rows: [] };
    }
    return { rows: [] };
  });

  const resultado = await db.listarSubcategoriasPorTipo('user1@c.us', 'receita');
  assert.deepEqual(resultado, ['Investimentos']);
});

test('listarSubcategoriasPorTipo: sem categorias principais cadastradas, cai no fallback legado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categorias_principais')) return { rows: [] };
    if (sql === 'SELECT nome FROM categorias ORDER BY nome') return { rows: [{ nome: 'Outros' }] };
    return { rows: [] };
  });

  const resultado = await db.listarSubcategoriasPorTipo('user1@c.us', 'despesa');
  assert.deepEqual(resultado, ['Outros']);
});

// ── validarCategoriaPorTipo (via executeTool registrar_transacao) ────────────

test('validarCategoriaPorTipo: categoria certa (despesa) passa direto, sem aviso', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'despesa');

  let categoriaUsada = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria) => {
    categoriaUsada = categoria;
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'despesa', valor: 50, descricao: 'Mercado', categoria: 'Alimentação', status: 'pago',
  });

  assert.equal(result.ok, true);
  assert.equal(categoriaUsada, 'Alimentação');
  assert.ok(!result.msg.includes('ajustada'));
});

test('validarCategoriaPorTipo: categoria de despesa aplicada numa receita é corrigida com aviso', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'despesa');

  let categoriaUsada = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria) => {
    categoriaUsada = categoria;
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'receita', valor: 3000, descricao: 'Salário', categoria: 'Alimentação', status: 'pago',
  });

  assert.equal(result.ok, true);
  assert.equal(categoriaUsada, 'Outras Receitas');
  assert.ok(result.msg.includes('ajustada'));
  assert.ok(result.msg.includes('Alimentação'));
});

test('validarCategoriaPorTipo: categoria de receita aplicada numa despesa é corrigida com aviso', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'receita');

  let categoriaUsada = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria) => {
    categoriaUsada = categoria;
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'despesa', valor: 80, descricao: 'Compra', categoria: 'Salário', status: 'pago',
  });

  assert.equal(result.ok, true);
  assert.equal(categoriaUsada, 'Outros');
  assert.ok(result.msg.includes('ajustada'));
});

test('validarCategoriaPorTipo: categoria tipo "ambos" é aceita para despesa e receita sem ajuste', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'ambos');

  let categoriaUsada = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria) => {
    categoriaUsada = categoria;
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'receita', valor: 500, descricao: 'Resgate', categoria: 'Investimentos', status: 'pago',
  });

  assert.equal(result.ok, true);
  assert.equal(categoriaUsada, 'Investimentos');
  assert.ok(!result.msg.includes('ajustada'));
});

test('validarCategoriaPorTipo: categoria nova (ainda não cadastrada) é aceita e cadastrada com o tipo correto', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => null);

  let garantirChamadoCom = null;
  const handlers = require('../src/handlers');
  t.mock.method(handlers, 'garantirSubcategoriaVinculada', async (usuarioId, categoria, tipo) => {
    garantirChamadoCom = { usuarioId, categoria, tipo };
  });

  let categoriaUsada = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria) => {
    categoriaUsada = categoria;
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'receita', valor: 150, descricao: 'Bico', categoria: 'Freela Design', status: 'pago',
  });

  assert.equal(result.ok, true);
  assert.equal(categoriaUsada, 'Freela Design');
  assert.ok(!result.msg.includes('ajustada'));
  assert.ok(garantirChamadoCom, 'garantirSubcategoriaVinculada deve ser chamada para categoria nova');
  assert.equal(garantirChamadoCom.categoria, 'Freela Design');
  assert.equal(garantirChamadoCom.tipo, 'receita');
});
