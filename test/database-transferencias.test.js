// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

// Mock de resolverUsuarioPrincipal: por padrão, retorna o próprio usuarioId
// (sem contatos compartilhados vinculados) para isolar os testes.
function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('criarTransferencia: insere e retorna a transferência criada', async (t) => {
  mockResolverIdentidade(t);
  let queryCapturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queryCapturada = { sql, params };
    return {
      rows: [{
        id: 1, conta_origem_id: 1, conta_destino_id: 2, valor: 100,
        descricao: null, data: '2026-07-02', criado_em: new Date(),
      }],
    };
  });

  const transferencia = await db.criarTransferencia('user1@c.us', 1, 2, 100);

  assert.equal(transferencia.conta_origem_id, 1);
  assert.equal(transferencia.conta_destino_id, 2);
  assert.equal(transferencia.valor, 100);
  assert.ok(queryCapturada.sql.includes('INSERT INTO transferencias'));
  assert.deepEqual(queryCapturada.params, ['user1@c.us', 1, 2, 100, null, null]);
});

test('criarTransferencia: mesma conta origem/destino rejeita antes de bater no banco', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  await assert.rejects(
    () => db.criarTransferencia('user1@c.us', 5, 5, 100),
    (err) => {
      assert.ok(err.message.toLowerCase().includes('mesma'));
      return true;
    }
  );
  assert.equal(chamouQuery, false, 'não deveria chamar o banco quando origem === destino');
});

test('criarTransferencia: conta inexistente (FK) retorna erro amigável', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => {
    const err = new Error('insert or update on table "transferencias" violates foreign key constraint');
    err.code = '23503';
    throw err;
  });

  await assert.rejects(
    () => db.criarTransferencia('user1@c.us', 1, 999, 100),
    (err) => {
      assert.ok(err.message.toLowerCase().includes('não existe'));
      return true;
    }
  );
});

test('criarTransferencia: erro de banco não relacionado é repropagado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => {
    const err = new Error('connection refused');
    err.code = '08006';
    throw err;
  });

  await assert.rejects(
    () => db.criarTransferencia('user1@c.us', 1, 2, 100),
    (err) => {
      assert.equal(err.message, 'connection refused');
      return true;
    }
  );
});

test('listarTransferencias: retorna histórico com nome das contas via JOIN', async (t) => {
  mockResolverIdentidade(t);
  let queryCapturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queryCapturada = { sql, params };
    return {
      rows: [
        { id: 2, valor: 50, descricao: null, data: '2026-07-02', conta_origem_id: 1, conta_origem_nome: 'Conta Corrente', conta_destino_id: 2, conta_destino_nome: 'Poupança' },
        { id: 1, valor: 100, descricao: 'Reserva', data: '2026-07-01', conta_origem_id: 1, conta_origem_nome: 'Conta Corrente', conta_destino_id: 3, conta_destino_nome: 'Carteira' },
      ],
    };
  });

  const transferencias = await db.listarTransferencias('user1@c.us', 20);

  assert.equal(transferencias.length, 2);
  assert.equal(transferencias[0].conta_origem_nome, 'Conta Corrente');
  assert.equal(transferencias[0].conta_destino_nome, 'Poupança');
  assert.ok(queryCapturada.sql.includes('JOIN contas co'));
  assert.ok(queryCapturada.sql.includes('JOIN contas cd'));
  assert.deepEqual(queryCapturada.params, ['user1@c.us', 20]);
});

test('calcularSaldosPorConta: soma transferencias recebidas e subtrai as enviadas', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    // Simula o resultado já considerando o efeito das transferências no cálculo SQL
    return {
      rows: [
        { id: 1, nome: 'Conta Corrente', tipo: 'corrente', saldo: 900 },   // 1000 - 100 (enviou)
        { id: 2, nome: 'Poupança', tipo: 'poupanca', saldo: 100 },          // 0 + 100 (recebeu)
      ],
    };
  });

  const saldos = await db.calcularSaldosPorConta('user1@c.us');

  assert.equal(saldos.length, 2);
  assert.equal(saldos[0].saldo, 900);
  assert.equal(saldos[1].saldo, 100);
  assert.ok(sqlCapturado.includes('FROM transferencias tr'));
  assert.ok(sqlCapturado.includes('tr.conta_destino_id = c.id'));
  assert.ok(sqlCapturado.includes('tr.conta_origem_id = c.id'));
});
