// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

// Mock de resolverUsuarioPrincipal: por padrão, retorna o próprio usuarioId
// (sem contatos compartilhados vinculados) para isolar os testes de contas.
function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('criarConta: insere e retorna a conta criada', async (t) => {
  mockResolverIdentidade(t);
  let queryCapturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queryCapturada = { sql, params };
    return {
      rows: [{ id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false }],
    };
  });

  const conta = await db.criarConta('user1@c.us', 'Poupança', 'poupanca');

  assert.equal(conta.nome, 'Poupança');
  assert.equal(conta.tipo, 'poupanca');
  assert.ok(queryCapturada.sql.includes('INSERT INTO contas'));
  assert.deepEqual(queryCapturada.params, ['user1@c.us', 'Poupança', 'poupanca']);
});

test('criarConta: violação de UNIQUE(usuario_id, nome) retorna erro amigável', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => {
    const err = new Error('duplicate key value violates unique constraint "contas_usuario_id_nome_key"');
    err.code = '23505';
    throw err;
  });

  await assert.rejects(
    () => db.criarConta('user1@c.us', 'Conta Principal', null),
    (err) => {
      assert.ok(err.message.includes('Conta Principal'));
      assert.ok(err.message.toLowerCase().includes('já tem'));
      return true;
    }
  );
});

test('criarConta: erro de banco não relacionado a UNIQUE é repropagado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => {
    const err = new Error('connection refused');
    err.code = '08006';
    throw err;
  });

  await assert.rejects(
    () => db.criarConta('user1@c.us', 'Poupança', null),
    (err) => {
      assert.equal(err.message, 'connection refused');
      return true;
    }
  );
});

test('buscarContasPorNome: 0 resultados retorna array vazio', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const contas = await db.buscarContasPorNome('user1@c.us', 'inexistente');
  assert.deepEqual(contas, []);
});

test('buscarContasPorNome: 1 resultado retorna array com 1 item', async (t) => {
  mockResolverIdentidade(t);
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ id: 2, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false }] };
  });

  const contas = await db.buscarContasPorNome('user1@c.us', 'poup');
  assert.equal(contas.length, 1);
  assert.equal(contas[0].nome, 'Poupança');
  assert.deepEqual(paramsCapturados, ['user1@c.us', '%poup%']);
});

test('buscarContasPorNome: múltiplos resultados retorna todos', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({
    rows: [
      { id: 1, nome: 'Conta Corrente', tipo: 'corrente', saldo_inicial: 0, ativo: true, padrao: true },
      { id: 2, nome: 'Conta Investimento', tipo: 'investimento', saldo_inicial: 0, ativo: true, padrao: false },
    ],
  }));

  const contas = await db.buscarContasPorNome('user1@c.us', 'conta');
  assert.equal(contas.length, 2);
});

test('calcularSaldosPorConta: retorna saldo por conta ativa do usuário', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return {
      rows: [
        { id: 1, nome: 'Conta Principal', tipo: null, saldo: 1500.5 },
        { id: 2, nome: 'Poupança', tipo: 'poupanca', saldo: 300 },
      ],
    };
  });

  const saldos = await db.calcularSaldosPorConta('user1@c.us');

  assert.equal(saldos.length, 2);
  assert.equal(saldos[0].nome, 'Conta Principal');
  assert.equal(saldos[0].saldo, 1500.5);
  assert.equal(saldos[1].saldo, 300);
  assert.ok(sqlCapturado.includes('FROM contas c'));
  assert.ok(sqlCapturado.includes("c.ativo = TRUE"));
});

test('calcularSaldosPorConta: sem contas retorna array vazio', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const saldos = await db.calcularSaldosPorConta('user1@c.us');
  assert.deepEqual(saldos, []);
});
