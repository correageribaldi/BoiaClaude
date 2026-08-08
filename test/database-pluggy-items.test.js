// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'd'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── proximoNomeDisponivel (função pura) ────────────────────────────────────────

test('proximoNomeDisponivel: nome livre retorna o próprio nome base', () => {
  const nome = db.proximoNomeDisponivel('Nubank • Conta corrente', []);
  assert.equal(nome, 'Nubank • Conta corrente');
});

test('proximoNomeDisponivel: nome base ocupado usa sufixo (2)', () => {
  const nome = db.proximoNomeDisponivel('Nubank', ['Nubank']);
  assert.equal(nome, 'Nubank (2)');
});

test('proximoNomeDisponivel: nome base e (2) ocupados usa (3)', () => {
  const nome = db.proximoNomeDisponivel('Nubank', ['Nubank', 'Nubank (2)']);
  assert.equal(nome, 'Nubank (3)');
});

test('proximoNomeDisponivel: ignora nomes não relacionados', () => {
  const nome = db.proximoNomeDisponivel('Nubank', ['Itaú', 'Conta Principal']);
  assert.equal(nome, 'Nubank');
});

// ── criarContaPluggy ────────────────────────────────────────────────────────────

test('criarContaPluggy: cria conta com saldo_inicial=0 e grava o mapeamento', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] }; // sem mapeamento prévio
    if (sql.includes('SELECT nome FROM contas')) return { rows: [] }; // sem colisão
    if (sql.includes('INSERT INTO contas')) {
      return { rows: [{ id: 10, nome: params[1], tipo: params[2], saldo_inicial: 0, ativo: true, padrao: false }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada no teste: ${sql}`);
  });

  const conta = await db.criarContaPluggy('user1@c.us', 1, 'acc-abc', 'Nubank • Conta corrente', 'corrente');

  assert.equal(conta.nome, 'Nubank • Conta corrente');
  assert.equal(conta.saldo_inicial, 0);

  const insertConta = queries.find(q => q.sql.includes('INSERT INTO contas'));
  assert.deepEqual(insertConta.params, ['user1@c.us', 'Nubank • Conta corrente', 'corrente']);

  const insertMapa = queries.find(q => q.sql.includes('INSERT INTO pluggy_contas_map'));
  assert.deepEqual(insertMapa.params, [1, 'acc-abc', 10]);
});

test('criarContaPluggy: nome colidindo com conta existente ganha sufixo (2)', async (t) => {
  mockResolverIdentidade(t);
  let nomeInserido = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] };
    if (sql.includes('SELECT nome FROM contas')) return { rows: [{ nome: 'Nubank • Conta corrente' }] };
    if (sql.includes('INSERT INTO contas')) {
      nomeInserido = params[1];
      return { rows: [{ id: 11, nome: params[1], tipo: params[2], saldo_inicial: 0, ativo: true, padrao: false }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada no teste: ${sql}`);
  });

  const conta = await db.criarContaPluggy('user1@c.us', 1, 'acc-xyz', 'Nubank • Conta corrente', 'corrente');

  assert.equal(nomeInserido, 'Nubank • Conta corrente (2)');
  assert.equal(conta.nome, 'Nubank • Conta corrente (2)');
});

test('criarContaPluggy: Account já mapeado antes reaproveita a conta existente (idempotência)', async (t) => {
  mockResolverIdentidade(t);
  let tentouInserir = false;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM pluggy_contas_map')) {
      return { rows: [{ id: 99, nome: 'Nubank • Conta corrente', tipo: 'corrente', saldo_inicial: 0, ativo: true, padrao: false }] };
    }
    if (sql.includes('INSERT INTO contas')) { tentouInserir = true; }
    throw new Error(`Não deveria consultar mais nada além do mapeamento: ${sql}`);
  });

  const conta = await db.criarContaPluggy('user1@c.us', 1, 'acc-ja-mapeado', 'Nubank • Conta corrente', 'corrente');

  assert.equal(conta.id, 99);
  assert.equal(tentouInserir, false, 'não deveria tentar criar conta nova quando já existe mapeamento');
});

// ── criarCartaoPluggy ───────────────────────────────────────────────────────────

test('criarCartaoPluggy: cria cartão e grava o mapeamento', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] };
    if (sql.includes('SELECT nome FROM cartoes')) return { rows: [] };
    if (sql.includes('INSERT INTO cartoes')) {
      return { rows: [{ id: 20, nome: params[1], limite_total: null, dia_fechamento: null, dia_vencimento: null }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada no teste: ${sql}`);
  });

  const cartao = await db.criarCartaoPluggy('user1@c.us', 1, 'acc-credit-1', 'Nubank • Cartão');

  assert.equal(cartao.nome, 'Nubank • Cartão');
  const insertMapa = queries.find(q => q.sql.includes('INSERT INTO pluggy_contas_map'));
  assert.deepEqual(insertMapa.params, [1, 'acc-credit-1', 20]);
});

test('criarCartaoPluggy: nome colidindo ganha sufixo (2)', async (t) => {
  mockResolverIdentidade(t);
  let nomeInserido = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] };
    if (sql.includes('SELECT nome FROM cartoes')) return { rows: [{ nome: 'Nubank • Cartão' }] };
    if (sql.includes('INSERT INTO cartoes')) {
      nomeInserido = params[1];
      return { rows: [{ id: 21, nome: params[1], limite_total: null, dia_fechamento: null, dia_vencimento: null }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada no teste: ${sql}`);
  });

  await db.criarCartaoPluggy('user1@c.us', 1, 'acc-credit-2', 'Nubank • Cartão');
  assert.equal(nomeInserido, 'Nubank • Cartão (2)');
});

// ── salvarPluggyItem / listarPluggyItems ────────────────────────────────────────

test('salvarPluggyItem: insere com ON CONFLICT por item_id (upsert)', async (t) => {
  mockResolverIdentidade(t);
  let queryCapturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queryCapturada = { sql, params };
    return { rows: [{ id: 5 }] };
  });

  const id = await db.salvarPluggyItem('user1@c.us', 'item-123', 'Nubank', 'UPDATING');

  assert.equal(id, 5);
  assert.ok(queryCapturada.sql.includes('INSERT INTO pluggy_items'));
  assert.ok(queryCapturada.sql.includes('ON CONFLICT (item_id) DO UPDATE'));
  assert.deepEqual(queryCapturada.params, ['user1@c.us', 'item-123', 'Nubank', 'UPDATING']);
});

test('listarPluggyItems: retorna os items do usuário', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({
    rows: [
      { id: 1, item_id: 'item-1', connector_nome: 'Nubank', status: 'UPDATED' },
      { id: 2, item_id: 'item-2', connector_nome: 'Itaú', status: 'UPDATING' },
    ],
  }));

  const items = await db.listarPluggyItems('user1@c.us');
  assert.equal(items.length, 2);
  assert.equal(items[0].connector_nome, 'Nubank');
});

test('listarPluggyItems: usuário sem items retorna array vazio', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const items = await db.listarPluggyItems('user1@c.us');
  assert.deepEqual(items, []);
});
