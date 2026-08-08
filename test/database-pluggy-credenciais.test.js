// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'c'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const pluggyCrypto = require('../src/pluggyCrypto');

// Mock de resolverUsuarioPrincipal: por padrão, retorna o próprio usuarioId
// (mesmo padrão de test/database-contas.test.js).
function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('salvarCredencialPluggy: cifra o client_secret antes de gravar (nunca em texto plano)', async (t) => {
  mockResolverIdentidade(t);
  let queryCapturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queryCapturada = { sql, params };
    return { rows: [{ id: 1 }] };
  });

  await db.salvarCredencialPluggy('user1@c.us', 'client-id-123', 'segredo-super-sensivel');

  assert.ok(queryCapturada.sql.includes('INSERT INTO pluggy_credenciais'));
  assert.ok(queryCapturada.sql.includes('ON CONFLICT (usuario_id) DO UPDATE'));

  const [usuarioId, clientId, valorCifrado, iv] = queryCapturada.params;
  assert.equal(usuarioId, 'user1@c.us');
  assert.equal(clientId, 'client-id-123');
  assert.notEqual(valorCifrado, 'segredo-super-sensivel', 'client_secret nunca deve ir em texto plano pro banco');
  assert.ok(!valorCifrado.includes('segredo'), 'ciphertext não pode conter fragmento legível do segredo');
  assert.ok(valorCifrado.includes(':'), 'formato esperado: ciphertextHex:authTagHex');
  assert.equal(iv.length, 24, 'iv de 12 bytes vira 24 chars em hex');
});

test('salvarCredencialPluggy: resolve pelo usuário principal (contas compartilhadas)', async (t) => {
  // resolverUsuarioPrincipal é chamado pelo binding léxico interno do módulo
  // (database.js:78), não pela propriedade exportada — t.mock.method(db,
  // 'resolverUsuarioPrincipal', ...) não afeta essa chamada interna (mesma
  // característica nos demais testes deste arquivo, mascarada ali porque
  // 'user1@c.us' não é um telefone válido e cai direto no fallback de
  // identidade, sem consultar o banco). Aqui simulamos o vínculo real
  // mockando o nível que a função de fato consulta: contatos_compartilhados.
  let queryInsert = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('contatos_compartilhados')) {
      return { rows: [{ usuario_principal_id: 'principal@c.us' }] };
    }
    queryInsert = { sql, params };
    return { rows: [{ id: 1 }] };
  });

  await db.salvarCredencialPluggy('5511988887777@c.us', 'client-id', 'secret-xyz');
  assert.equal(queryInsert.params[0], 'principal@c.us');
});

test('buscarCredencialPluggy: decifra corretamente o que foi persistido', async (t) => {
  mockResolverIdentidade(t);
  const { iv, valorCifrado } = pluggyCrypto.encriptar('segredo-original-999');

  t.mock.method(db.pool, 'query', async () => ({
    rows: [{ client_id: 'client-abc', client_secret_encrypted: valorCifrado, iv }],
  }));

  const cred = await db.buscarCredencialPluggy('user1@c.us');
  assert.equal(cred.clientId, 'client-abc');
  assert.equal(cred.clientSecret, 'segredo-original-999');
});

test('buscarCredencialPluggy: usuário sem credencial retorna null', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const cred = await db.buscarCredencialPluggy('user1@c.us');
  assert.equal(cred, null);
});

test('usuarioTemCredencialPluggy: true quando existe linha', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [{}] }));

  const tem = await db.usuarioTemCredencialPluggy('user1@c.us');
  assert.equal(tem, true);
});

test('usuarioTemCredencialPluggy: false quando não existe linha', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const tem = await db.usuarioTemCredencialPluggy('user1@c.us');
  assert.equal(tem, false);
});

test('removerCredencialPluggy: retorna true quando deletou alguma linha', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return { rowCount: 1 };
  });

  const removeu = await db.removerCredencialPluggy('user1@c.us');
  assert.equal(removeu, true);
  assert.ok(sqlCapturado.includes('DELETE FROM pluggy_credenciais'));
});

test('removerCredencialPluggy: retorna false quando não havia credencial', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rowCount: 0 }));

  const removeu = await db.removerCredencialPluggy('user1@c.us');
  assert.equal(removeu, false);
});
