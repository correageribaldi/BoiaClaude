// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('calcularSaldosPorConta: exclui transação de cartão do cálculo por conta (defesa mesmo com dados limpos)', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;

  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return { rows: [{ id: 1, nome: 'Conta Principal', tipo: null, saldo: 0 }] };
  });

  await db.calcularSaldosPorConta('user1@c.us');

  // Bug de produção: essa query não tinha NENHUMA exclusão de cartao_id —
  // mesmo depois do fix da migração (Bug 1), continuaria vulnerável a
  // qualquer transação que algum dia tivesse os dois campos preenchidos por
  // outro motivo. Camada de defesa, mesmo raciocínio de calcularSaldos.
  assert.ok(
    sqlCapturado.includes('AND t.cartao_id IS NULL'),
    'query de saldo por conta deve excluir transações de cartão'
  );
});
