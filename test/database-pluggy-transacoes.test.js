// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'g'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── resolverCategoriaPluggy ──────────────────────────────────────────────────────

test('resolverCategoriaPluggy: sem categoria da Pluggy (null) cai direto no fallback, sem consultar o banco', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', null, 'despesa');

  assert.equal(categoria, 'Outros');
  assert.equal(chamouQuery, false, 'categoria ausente não deveria nem tentar buscar match');
});

test('resolverCategoriaPluggy: fallback de receita é "Outras Receitas"', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', null, 'receita');
  assert.equal(categoria, 'Outras Receitas');
});

test('resolverCategoriaPluggy: 1 match único usa a categoria já cadastrada do usuário', async (t) => {
  mockResolverIdentidade(t);
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ categoria: 'Supermercado' }] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Food and drinks - Groceries', 'despesa');

  assert.equal(categoria, 'Supermercado');
  assert.deepEqual(paramsCapturados, ['user1@c.us', 'despesa', '%Food and drinks - Groceries%']);
});

test('resolverCategoriaPluggy: 0 matches cai no fallback genérico', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Categoria inexistente', 'despesa');
  assert.equal(categoria, 'Outros');
});

test('resolverCategoriaPluggy: múltiplos matches fuzzy SEM match exato (ambíguo) cai no fallback genérico', async (t) => {
  mockResolverIdentidade(t);
  // Nem "Mercado Livre" nem "Hipermercado" são === "mercado" normalizado —
  // genuinamente ambíguo. Ver test/database-categoria-match-exato.test.js
  // para o caso "Compras"/"Compras online", que resolve por match exato.
  t.mock.method(db.pool, 'query', async () => ({
    rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }],
  }));

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'mercado', 'despesa');
  assert.equal(categoria, 'Outros');
});

// ── upsertTransacaoPluggy ────────────────────────────────────────────────────────

test('upsertTransacaoPluggy: transação nova faz INSERT com numero_usuario calculado', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [] };
    if (sql.includes('INSERT INTO transacoes')) return { rows: [{ id: 42 }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const resultado = await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-abc',
    tipo: 'despesa',
    valor: 150.5,
    descricao: 'PIX MERCADO XYZ',
    categoria: 'Supermercado',
    data: '2026-08-01',
    status: 'pago',
    contaId: 10,
    cartaoId: null,
  });

  assert.equal(resultado.novo, true);
  assert.equal(resultado.id, 42);

  const insert = queries.find(q => q.sql.includes('INSERT INTO transacoes'));
  assert.deepEqual(insert.params, [
    'user1@c.us', 'despesa', 150.5, 'PIX MERCADO XYZ', 'Supermercado', '2026-08-01', 'pago', 10, null, 'tx-abc',
    null, null, null,
  ]);
});

test('upsertTransacaoPluggy: grava parcelamento quando a transação é parcelada', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [] };
    if (sql.includes('INSERT INTO transacoes')) return { rows: [{ id: 43 }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-parc',
    tipo: 'despesa',
    valor: 100,
    descricao: 'LOJA FICTICIA 7/10',
    categoria: 'Compras',
    data: '2026-08-01',
    status: 'pago',
    cartaoId: 42,
    parcelaAtual: 7,
    parcelaTotal: 10,
    parcelaGrupo: 'loja ficticia|10',
  });

  const insert = queries.find(q => q.sql.includes('INSERT INTO transacoes'));
  assert.deepEqual(insert.params.slice(-3), [7, 10, 'loja ficticia|10']);
  assert.match(insert.sql, /parcela_atual, parcela_total, parcela_grupo/);
});

test('upsertTransacaoPluggy: transação já existente (mesmo pluggy_transaction_id) faz UPDATE, não duplica', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [{ id: 7 }] };
    if (sql.startsWith('\n      UPDATE transacoes') || sql.includes('UPDATE transacoes')) return { rows: [] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const resultado = await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-abc',
    tipo: 'despesa',
    valor: 200,
    descricao: 'PIX MERCADO XYZ (atualizado)',
    categoria: 'Supermercado',
    data: '2026-08-01',
    status: 'pago',
  });

  assert.equal(resultado.novo, false);
  assert.equal(resultado.id, 7);

  const insertChamado = queries.some(q => q.sql.includes('INSERT INTO transacoes'));
  assert.equal(insertChamado, false, 'não deveria inserir quando já existe pelo pluggy_transaction_id');

  const update = queries.find(q => q.sql.includes('UPDATE transacoes'));
  assert.deepEqual(update.params, ['tx-abc', 200, 'PIX MERCADO XYZ (atualizado)', 'Supermercado', '2026-08-01', 'pago', null, null, null]);
});

// ── removerTransacoesPluggyPorIds ────────────────────────────────────────────────

test('removerTransacoesPluggyPorIds: remove pelos ids informados', async (t) => {
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rowCount: 2 };
  });

  const removidos = await db.removerTransacoesPluggyPorIds(['tx-1', 'tx-2']);

  assert.equal(removidos, 2);
  assert.deepEqual(paramsCapturados, [['tx-1', 'tx-2']]);
});

test('removerTransacoesPluggyPorIds: lista vazia não consulta o banco', async (t) => {
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rowCount: 0 }; });

  const removidos = await db.removerTransacoesPluggyPorIds([]);

  assert.equal(removidos, 0);
  assert.equal(chamouQuery, false);
});

// ── atualizarStatusPluggyItem / buscarPluggyItemPorItemId / marcarPluggyItemSincronizado ─

test('atualizarStatusPluggyItem: grava status bruto e mensagem amigável', async (t) => {
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ id: 3 }] };
  });

  const id = await db.atualizarStatusPluggyItem('item-123', 'LOGIN_ERROR', 'Credencial expirada.');

  assert.equal(id, 3);
  assert.deepEqual(paramsCapturados, ['item-123', 'LOGIN_ERROR', 'Credencial expirada.']);
});

test('buscarPluggyItemPorItemId: encontrado retorna a linha', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({
    rows: [{ id: 1, usuario_id: 'user1@c.us', status: 'UPDATED', ultimo_sync_em: null }],
  }));

  const item = await db.buscarPluggyItemPorItemId('item-123');
  assert.equal(item.id, 1);
});

test('buscarPluggyItemPorItemId: não encontrado retorna null', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const item = await db.buscarPluggyItemPorItemId('item-inexistente');
  assert.equal(item, null);
});

test('marcarPluggyItemSincronizado: atualiza ultimo_sync_em pelo id', async (t) => {
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [] };
  });

  await db.marcarPluggyItemSincronizado(5);
  assert.deepEqual(paramsCapturados, [5]);
});

// ── listarContasMapPorItem / buscarMapeamentoContaPorAccountId ──────────────────

test('listarContasMapPorItem: retorna os mapeamentos do item', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({
    rows: [
      { pluggy_account_id: 'acc-1', tipo: 'conta', cronos_conta_id: 10, cronos_cartao_id: null },
      { pluggy_account_id: 'acc-2', tipo: 'cartao', cronos_conta_id: null, cronos_cartao_id: 20 },
    ],
  }));

  const mapas = await db.listarContasMapPorItem(1);
  assert.equal(mapas.length, 2);
  assert.equal(mapas[1].tipo, 'cartao');
});

test('buscarMapeamentoContaPorAccountId: encontrado', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({
    rows: [{ tipo: 'conta', cronos_conta_id: 10, cronos_cartao_id: null }],
  }));

  const mapa = await db.buscarMapeamentoContaPorAccountId('acc-1');
  assert.equal(mapa.cronos_conta_id, 10);
});

test('buscarMapeamentoContaPorAccountId: não encontrado retorna null', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const mapa = await db.buscarMapeamentoContaPorAccountId('acc-inexistente');
  assert.equal(mapa, null);
});

// ── obterOuCriarWebhookTokenPluggy / buscarUsuarioIdPorWebhookToken ──────────────

test('obterOuCriarWebhookTokenPluggy: token já existente é reaproveitado, sem gerar outro', async (t) => {
  mockResolverIdentidade(t);
  let fezUpdate = false;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SELECT webhook_token')) return { rows: [{ webhook_token: 'token-existente-123' }] };
    if (sql.includes('UPDATE pluggy_credenciais')) { fezUpdate = true; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  const token = await db.obterOuCriarWebhookTokenPluggy('user1@c.us');

  assert.equal(token, 'token-existente-123');
  assert.equal(fezUpdate, false, 'não deveria regravar um token que já existe');
});

test('obterOuCriarWebhookTokenPluggy: sem token ainda, gera um novo de alta entropia e grava', async (t) => {
  mockResolverIdentidade(t);
  let tokenGravado = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT webhook_token')) return { rows: [{ webhook_token: null }] };
    if (sql.includes('UPDATE pluggy_credenciais')) { tokenGravado = params[1]; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  const token = await db.obterOuCriarWebhookTokenPluggy('user1@c.us');

  assert.equal(token, tokenGravado);
  assert.equal(token.length, 48, '24 bytes em hex = 48 caracteres');
  assert.match(token, /^[0-9a-f]{48}$/);
});

test('obterOuCriarWebhookTokenPluggy: usuário sem credencial configurada lança erro claro', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  await assert.rejects(
    () => db.obterOuCriarWebhookTokenPluggy('user1@c.us'),
    /Nenhuma credencial Pluggy configurada/
  );
});

test('buscarUsuarioIdPorWebhookToken: token válido resolve o usuário', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({ rows: [{ usuario_id: 'user1@c.us' }] }));

  const usuarioId = await db.buscarUsuarioIdPorWebhookToken('token-valido');
  assert.equal(usuarioId, 'user1@c.us');
});

test('buscarUsuarioIdPorWebhookToken: token inválido/inexistente retorna null (endpoint rejeita com 401)', async (t) => {
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const usuarioId = await db.buscarUsuarioIdPorWebhookToken('token-invalido');
  assert.equal(usuarioId, null);
});

test('buscarUsuarioIdPorWebhookToken: token vazio nem consulta o banco', async (t) => {
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  const usuarioId = await db.buscarUsuarioIdPorWebhookToken('');
  assert.equal(usuarioId, null);
  assert.equal(chamouQuery, false);
});
