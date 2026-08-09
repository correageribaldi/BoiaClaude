// Aprendizado de categoria por estabelecimento: corrigir a categoria de UM
// lançamento faz todo lançamento FUTURO do mesmo estabelecimento nascer
// naquela categoria.
//
// Descrições nos testes reproduzem os padrões de formato reais da Pluggy com
// nomes fictícios — nenhum dado de usuário real.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'g'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── registrarCategoriaAprendida ─────────────────────────────────────────────

test('registrarCategoriaAprendida: grava a CHAVE normalizada, não a descrição crua', async (t) => {
  mockResolverIdentidade(t);
  let params = null;
  t.mock.method(db.pool, 'query', async (sql, p) => { params = p; return { rows: [] }; });

  const chave = await db.registrarCategoriaAprendida(
    'user1@c.us', 'Compra no débito|IFD*PIZZARIA DO ZE L', 'despesa', 'Restaurantes'
  );

  assert.equal(chave, 'pizzaria do ze l');
  assert.deepEqual(params, ['user1@c.us', 'pizzaria do ze l', 'despesa', 'Restaurantes']);
});

test('registrarCategoriaAprendida: corrigir de novo sobrescreve o aprendizado anterior (upsert)', async (t) => {
  mockResolverIdentidade(t);
  let sql = null;
  t.mock.method(db.pool, 'query', async (s) => { sql = s; return { rows: [] }; });

  await db.registrarCategoriaAprendida('user1@c.us', 'Uber', 'despesa', 'Transporte');

  assert.match(sql, /ON CONFLICT \(usuario_id, chave_estabelecimento, tipo\)/);
  assert.match(sql, /DO UPDATE SET categoria = EXCLUDED\.categoria/);
});

test('registrarCategoriaAprendida: descrição sem chave confiável não grava nada', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  const chave = await db.registrarCategoriaAprendida('user1@c.us', 'Compra no débito|', 'despesa', 'Supermercado');

  assert.equal(chave, null);
  assert.equal(chamouQuery, false, 'sem chave não deveria tocar no banco');
});

test('registrarCategoriaAprendida: categoria vazia não grava nada', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  assert.equal(await db.registrarCategoriaAprendida('user1@c.us', 'Uber', 'despesa', null), null);
  assert.equal(chamouQuery, false);
});

// ── buscarCategoriaAprendida ────────────────────────────────────────────────

test('buscarCategoriaAprendida: consulta pela chave normalizada + tipo', async (t) => {
  mockResolverIdentidade(t);
  let params = null;
  t.mock.method(db.pool, 'query', async (sql, p) => {
    params = p;
    return { rows: [{ categoria: 'Supermercado' }] };
  });

  const categoria = await db.buscarCategoriaAprendida('user1@c.us', 'Compra no crédito|MERCADO FICTICIO', 'despesa');

  assert.equal(categoria, 'Supermercado');
  assert.deepEqual(params, ['user1@c.us', 'mercado ficticio', 'despesa']);
});

test('buscarCategoriaAprendida: sem aprendizado retorna null', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  assert.equal(await db.buscarCategoriaAprendida('user1@c.us', 'Uber', 'despesa'), null);
});

// ── Prioridade dentro de resolverCategoriaPluggy ────────────────────────────

test('resolverCategoriaPluggy: aprendizado do usuário VENCE a categoria sugerida pela Pluggy', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    sqls.push(sql);
    if (sql.includes('FROM categoria_aprendida')) return { rows: [{ categoria: 'Padaria' }] };
    return { rows: [{ categoria: 'Restaurantes' }] };
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Alimentação e bebidas', 'despesa', 'Variáveis', 'Compra no débito|PADARIA DO BAIRRO'
  );

  assert.equal(categoria, 'Padaria');
  assert.equal(
    sqls.some((sql) => sql.includes('FROM limites_categoria')),
    false,
    'com aprendizado não precisa nem consultar a taxonomia da Pluggy'
  );
});

test('resolverCategoriaPluggy: aprendizado vale mesmo quando a Pluggy não manda categoria (o caso "Outros")', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida')) return { rows: [{ categoria: 'Transporte' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', null, 'despesa', null, 'Uber');
  assert.equal(categoria, 'Transporte');
});

test('resolverCategoriaPluggy: sem aprendizado, segue o fluxo antigo (match na taxonomia)', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida')) return { rows: [] };
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Restaurantes' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Alimentação e bebidas', 'despesa', 'Variáveis', 'Compra no débito|LANCHONETE EXEMPLO'
  );
  assert.equal(categoria, 'Restaurantes');
});

test('resolverCategoriaPluggy: sem aprendizado e sem categoria da Pluggy cai no genérico', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  assert.equal(await db.resolverCategoriaPluggy('user1@c.us', null, 'despesa', null, 'Uber'), 'Outros');
  assert.equal(await db.resolverCategoriaPluggy('user1@c.us', null, 'receita', null, 'Uber'), 'Outras Receitas');
});

test('resolverCategoriaPluggy: aprendizado de despesa NÃO vaza para a receita de mesmo nome', async (t) => {
  mockResolverIdentidade(t);
  // "Transferência enviada|FULANO" e "Transferência Recebida|FULANO" caem na
  // mesma chave — só o tipo separa uma da outra.
  const aprendidos = { 'fulano de tal|despesa': 'Empréstimos' };
  const consultas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM categoria_aprendida')) {
      consultas.push(params);
      const achado = aprendidos[`${params[1]}|${params[2]}`];
      return { rows: achado ? [{ categoria: achado }] : [] };
    }
    return { rows: [] };
  });

  const despesa = await db.resolverCategoriaPluggy(
    'user1@c.us', null, 'despesa', null, 'Transferência enviada|FULANO DE TAL'
  );
  const receita = await db.resolverCategoriaPluggy(
    'user1@c.us', null, 'receita', null, 'Transferência Recebida|FULANO DE TAL'
  );

  assert.equal(despesa, 'Empréstimos');
  assert.equal(receita, 'Outras Receitas', 'receita não pode herdar a categoria aprendida da despesa');
  assert.deepEqual(consultas.map((p) => p[1]), ['fulano de tal', 'fulano de tal'], 'mesma chave');
  assert.deepEqual(consultas.map((p) => p[2]), ['despesa', 'receita'], 'tipos diferentes');
});

// ── Gancho na edição manual ─────────────────────────────────────────────────

test('atualizarTransacao: editar a categoria registra o aprendizado do estabelecimento', async (t) => {
  mockResolverIdentidade(t);
  let aprendizado = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('UPDATE transacoes')) {
      return { rows: [{ id: 12, tipo: 'despesa', descricao: 'Compra no débito|MERCADO FICTICIO', categoria: params[0] }] };
    }
    if (sql.includes('INSERT INTO categoria_aprendida')) { aprendizado = params; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.atualizarTransacao('user1@c.us', 12, 'categoria', 'Supermercado');

  assert.deepEqual(aprendizado, ['user1@c.us', 'mercado ficticio', 'despesa', 'Supermercado']);
});

test('atualizarTransacao: editar outro campo não registra aprendizado', async (t) => {
  mockResolverIdentidade(t);
  let gravouAprendizado = false;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('INSERT INTO categoria_aprendida')) gravouAprendizado = true;
    return { rows: [{ id: 12, tipo: 'despesa', descricao: 'Compra no débito|MERCADO FICTICIO' }] };
  });

  await db.atualizarTransacao('user1@c.us', 12, 'valor', 99.9);

  assert.equal(gravouAprendizado, false);
});

test('atualizarTransacao: falha ao aprender NÃO derruba a edição', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('INSERT INTO categoria_aprendida')) throw new Error('banco fora');
    return { rows: [{ id: 12, tipo: 'despesa', descricao: 'Uber', categoria: params[0] }] };
  });

  const atualizada = await db.atualizarTransacao('user1@c.us', 12, 'categoria', 'Transporte');

  assert.equal(atualizada.categoria, 'Transporte', 'a edição em si tem que valer mesmo se o aprendizado falhar');
});
