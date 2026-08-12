// Nome limpo do estabelecimento (Pluggy merchant.businessName).
//
// Regra que estes testes protegem: enriquecimento NUNCA sobrescreve o que o
// usuário escreveu, e a descrição crua do banco nunca é perdida.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'd'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── Gravação: coluna própria, descrição crua preservada ─────────────────────

test('upsertTransacaoPluggy: nome limpo vai para descricao_exibicao, não por cima de descricao', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [] };
    if (sql.includes('FROM recorrencias')) return { rows: [] };
    if (sql.includes('INSERT INTO transacoes')) return { rows: [{ id: 100 }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-merchant',
    tipo: 'despesa',
    valor: 90,
    descricao: 'Compra no débito|LOJA ABC LTDA 0001',
    categoria: 'Compras',
    data: '2026-08-05',
    status: 'pago',
    contaId: 3,
    descricaoExibicao: 'Loja ABC Comércio',
  });

  const insert = queries.find(q => q.sql.includes('INSERT INTO transacoes'));
  assert.match(insert.sql, /descricao_exibicao/);
  assert.equal(insert.params[3], 'Compra no débito|LOJA ABC LTDA 0001', 'descrição crua continua sendo gravada');
  assert.equal(insert.params[insert.params.length - 1], 'Loja ABC Comércio');
});

test('upsertTransacaoPluggy: re-sync não sobrescreve descrição editada pelo usuário', async (t) => {
  mockResolverIdentidade(t);
  let updateSql = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [{ id: 7, categoria_manual: false }] };
    if (sql.includes('UPDATE transacoes')) { updateSql = sql; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-merchant',
    tipo: 'despesa',
    valor: 90,
    descricao: 'Compra no débito|LOJA ABC LTDA 0001',
    categoria: 'Compras',
    data: '2026-08-05',
    status: 'pago',
    descricaoExibicao: 'Loja ABC Comércio',
  });

  // A decisão fica no banco, no próprio UPDATE — sem ler a flag antes, sem
  // janela de corrida entre leitura e escrita.
  assert.match(updateSql, /descricao = CASE WHEN descricao_manual THEN descricao ELSE \$3 END/);
});

test('upsertTransacaoPluggy: sync sem merchant não apaga o nome limpo já conhecido', async (t) => {
  mockResolverIdentidade(t);
  let updateSql = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [{ id: 7, categoria_manual: true }] };
    if (sql.includes('UPDATE transacoes')) { updateSql = sql; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-merchant', tipo: 'despesa', valor: 90,
    descricao: 'Compra no débito|LOJA ABC LTDA 0001', categoria: 'Compras',
    data: '2026-08-05', status: 'pago',
  });

  assert.match(updateSql, /descricao_exibicao = COALESCE/);
});

// ── Marca de edição manual da descrição ─────────────────────────────────────

test('atualizarTransacao: editar descrição marca descricao_manual = TRUE', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('UPDATE transacoes')) {
      sqlCapturado = sql;
      return { rows: [{ id: params[1], tipo: 'despesa', descricao: params[0], categoria: 'Compras' }] };
    }
    return { rows: [] };
  });

  await db.atualizarTransacao('user1@c.us', 12, 'descricao', 'Presente da Ana');

  assert.match(sqlCapturado, /descricao_manual = TRUE/);
});

test('atualizarTransacao: editar valor/data não marca descricao_manual', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqls.push(sql);
    return { rows: [{ id: params[1], tipo: 'despesa', descricao: 'X', categoria: 'Y' }] };
  });

  for (const campo of ['valor', 'data', 'conta_id']) {
    await db.atualizarTransacao('user1@c.us', 12, campo, 'x');
  }

  assert.equal(sqls.some(sql => sql.includes('descricao_manual')), false);
});

// ── Leitura: quem vence na exibição ─────────────────────────────────────────

test('consultarTransacoes: descrição editada pelo usuário vence o nome limpo', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql) => { sqlCapturado = sql; return { rows: [] }; });

  await db.consultarTransacoes('user1@c.us', {});

  assert.match(sqlCapturado, /CASE WHEN descricao_manual THEN descricao/);
  assert.match(sqlCapturado, /COALESCE\(NULLIF\(descricao_exibicao, ''\), descricao\)/);
  assert.match(sqlCapturado, /AS descricao_exibida/);
  assert.match(sqlCapturado, /valor::float, descricao,/, 'a descrição crua continua indo junto, para edição e busca');
});

test('consultarTransacoes: devolve descricao_exibida junto das colunas de sempre', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({
    rows: [{
      id: 1, tipo: 'despesa', valor: 90, descricao: 'Compra no débito|LOJA ABC LTDA 0001',
      descricao_exibida: 'Loja ABC Comércio', categoria: 'Compras', data: '2026-08-05', status: 'pago',
    }],
  }));

  const linhas = await db.consultarTransacoes('user1@c.us', {});

  assert.equal(linhas[0].descricao_exibida, 'Loja ABC Comércio');
  assert.equal(linhas[0].descricao, 'Compra no débito|LOJA ABC LTDA 0001');
});
