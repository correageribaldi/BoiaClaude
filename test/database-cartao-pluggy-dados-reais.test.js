// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Números abaixo são 100% sintéticos — não os valores reais do cartão do
// Federico (que o coordenador compartilhou só como referência do formato).

test('criarCartaoPluggy: popula limite_total na criação (bug de produção corrigido — antes ficava NULL)', async (t) => {
  mockResolverIdentidade(t);
  let paramsInsert = null;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] };
    if (sql.includes('SELECT nome FROM cartoes')) return { rows: [] };
    if (sql.includes('INSERT INTO cartoes')) {
      paramsInsert = params;
      return { rows: [{ id: 30, nome: params[1], limite_total: params[2], dia_fechamento: null, dia_vencimento: null }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const cartao = await db.criarCartaoPluggy('user1@c.us', 1, 'acc-credit-1', 'Nubank • Cartão', 5000);

  assert.deepEqual(paramsInsert, ['user1@c.us', 'Nubank • Cartão', 5000]);
  assert.equal(cartao.limite_total, 5000);
});

test('criarCartaoPluggy: sem limite conhecido na criação, grava NULL (não quebra)', async (t) => {
  mockResolverIdentidade(t);
  let paramsInsert = null;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM pluggy_contas_map')) return { rows: [] };
    if (sql.includes('SELECT nome FROM cartoes')) return { rows: [] };
    if (sql.includes('INSERT INTO cartoes')) {
      paramsInsert = params;
      return { rows: [{ id: 31, nome: params[1], limite_total: null, dia_fechamento: null, dia_vencimento: null }] };
    }
    if (sql.includes('INSERT INTO pluggy_contas_map')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.criarCartaoPluggy('user1@c.us', 1, 'acc-credit-2', 'Nubank • Cartão');

  assert.equal(paramsInsert[2], null);
});

test('atualizarCartaoPluggyDados: grava valorUsado/disponivel/limiteTotal reais da API', async (t) => {
  mockResolverIdentidade(t);
  let paramsUpdate = null;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsUpdate = params;
    return { rows: [] };
  });

  // Cenário sintético (não os dados reais do Federico): limite 5000, usado
  // 1234.56, disponível 3765.44.
  await db.atualizarCartaoPluggyDados('user1@c.us', 30, {
    limiteTotal: 5000, valorUsado: 1234.56, disponivel: 3765.44,
  });

  assert.deepEqual(paramsUpdate, [30, 5000, 1234.56, 3765.44, 'user1@c.us']);
});

test('atualizarCartaoPluggyDados: limiteTotal null preserva o valor já existente (COALESCE)', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqlCapturado = sql;
    return { rows: [] };
  });

  await db.atualizarCartaoPluggyDados('user1@c.us', 30, { limiteTotal: null, valorUsado: 100, disponivel: 50 });

  assert.ok(sqlCapturado.includes('COALESCE($2, limite_total)'), 'limite_total não deve ser apagado se a API não trouxer creditLimit');
});

test('atualizarCartaoPluggyDados: resolve pelo usuário principal (contas compartilhadas)', async (t) => {
  let queryParams = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('contatos_compartilhados')) {
      return { rows: [{ usuario_principal_id: 'principal@c.us' }] };
    }
    queryParams = params;
    return { rows: [] };
  });

  await db.atualizarCartaoPluggyDados('5511988887777@c.us', 30, { limiteTotal: 5000, valorUsado: 100, disponivel: 50 });
  assert.equal(queryParams[4], 'principal@c.us');
});

test('listarCartoes: retorna pluggy_valor_usado e pluggy_disponivel junto com os campos existentes', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;

  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return {
      rows: [
        { id: 30, nome: 'Nubank • Cartão', limite_total: 5000, dia_fechamento: null, dia_vencimento: null, pluggy_valor_usado: 1234.56, pluggy_disponivel: 3765.44 },
        { id: 31, nome: 'Cartão Manual', limite_total: 2000, dia_fechamento: 10, dia_vencimento: 20, pluggy_valor_usado: null, pluggy_disponivel: null },
      ],
    };
  });

  const cartoes = await db.listarCartoes('user1@c.us');

  assert.ok(sqlCapturado.includes('pluggy_valor_usado'));
  assert.ok(sqlCapturado.includes('pluggy_disponivel'));
  assert.equal(cartoes[0].pluggy_valor_usado, 1234.56);
  assert.equal(cartoes[1].pluggy_valor_usado, null, 'cartão manual não tem dado Pluggy');
});
