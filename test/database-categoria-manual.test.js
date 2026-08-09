// Protege a correção manual de categoria contra o re-sync da Pluggy.
//
// Bug de produção que originou estes testes: upsertTransacaoPluggy reescrevia
// `categoria` toda vez que a mesma transação voltava da Pluggy (intencional
// para valor/status — PENDING vira POSTED), apagando em silêncio a categoria
// que o usuário tinha corrigido no painel.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'g'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── atualizarTransacao: marca a origem da categoria ──────────────────────────

test('atualizarTransacao: editar categoria marca categoria_manual = TRUE', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('UPDATE transacoes')) {
      sqlCapturado = sql;
      return { rows: [{ id: params[1], tipo: 'despesa', descricao: 'MERCADO FICTICIO', categoria: params[0] }] };
    }
    return { rows: [] };
  });

  const atualizada = await db.atualizarTransacao('user1@c.us', 12, 'categoria', 'Supermercado');

  assert.equal(atualizada.categoria, 'Supermercado');
  assert.match(sqlCapturado, /categoria_manual = TRUE/);
});

test('atualizarTransacao: editar outro campo NÃO marca categoria_manual', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqls.push(sql);
    return { rows: [{ id: params[1], tipo: 'despesa', descricao: 'MERCADO FICTICIO', valor: params[0] }] };
  });

  for (const campo of ['valor', 'data', 'descricao', 'conta_id']) {
    await db.atualizarTransacao('user1@c.us', 12, campo, 'x');
  }

  assert.equal(
    sqls.some((sql) => sql.includes('categoria_manual')),
    false,
    'só a edição de categoria deve mexer na flag'
  );
});

// ── upsertTransacaoPluggy: re-sync respeita a correção manual ────────────────

test('upsertTransacaoPluggy: categoria_manual = TRUE preserva a categoria e ainda atualiza valor/status/data/descrição', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT id, categoria_manual FROM transacoes')) {
      return { rows: [{ id: 7, categoria_manual: true }] };
    }
    if (sql.includes('UPDATE transacoes')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const resultado = await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-abc',
    tipo: 'despesa',
    valor: 320.9,
    descricao: 'Compra no débito|MERCADO FICTICIO',
    categoria: 'Outros', // o que a Pluggy devolveria agora
    data: '2026-08-02',
    status: 'pago',
  });

  assert.equal(resultado.novo, false);

  const update = queries.find((q) => q.sql.includes('UPDATE transacoes'));
  assert.equal(update.sql.includes('categoria = '), false, 'categoria corrigida à mão não pode ser sobrescrita');
  assert.deepEqual(update.params, ['tx-abc', 320.9, 'Compra no débito|MERCADO FICTICIO', '2026-08-02', 'pago']);
});

test('upsertTransacaoPluggy: categoria_manual = FALSE continua atualizando a categoria (recategorização do histórico)', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT id, categoria_manual FROM transacoes')) {
      return { rows: [{ id: 7, categoria_manual: false }] };
    }
    if (sql.includes('UPDATE transacoes')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-abc',
    tipo: 'despesa',
    valor: 320.9,
    descricao: 'Compra no débito|MERCADO FICTICIO',
    categoria: 'Supermercado',
    data: '2026-08-02',
    status: 'pago',
  });

  const update = queries.find((q) => q.sql.includes('UPDATE transacoes'));
  assert.match(update.sql, /categoria = \$4/);
  assert.deepEqual(update.params, ['tx-abc', 320.9, 'Compra no débito|MERCADO FICTICIO', 'Supermercado', '2026-08-02', 'pago']);
});
