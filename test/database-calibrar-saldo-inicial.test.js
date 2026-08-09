// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Gap descoberto em produção: saldo_inicial=0 fixo (decisão do Marco 2) não
// reconcilia com o saldo real da Pluggy, porque ela só traz uma janela de
// histórico (até 365 dias), não desde a abertura da conta. calibrarSaldoInicialConta
// recalcula saldo_inicial para que calcularSaldosPorConta volte a bater.

test('calibrarSaldoInicialConta: saldo_inicial = balance real - líquido já importado (sem transferências)', async (t) => {
  mockResolverIdentidade(t);
  let paramsUpdate = null;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('AS liquido')) {
      // Cenário sintético (números fictícios, não os do Federico): receita
      // 2000 - despesa 1800 = líquido 200 já importado para a conta.
      return { rows: [{ liquido: 200 }] };
    }
    if (sql.includes('UPDATE contas SET saldo_inicial')) {
      paramsUpdate = params;
      return { rows: [] };
    }
    throw new Error(`Query inesperada: ${sql}`);
  });

  // balance real reportado pela Pluggy = 500. saldo_inicial deve ficar em
  // 500 - 200 = 300, para que saldo_inicial(300) + líquido(200) = 500 quando
  // calcularSaldosPorConta somar de novo.
  const novoSaldoInicial = await db.calibrarSaldoInicialConta('user1@c.us', 84, 500);

  assert.equal(novoSaldoInicial, 300);
  assert.deepEqual(paramsUpdate, [84, 300, 'user1@c.us']);
});

test('calibrarSaldoInicialConta: considera transferências na fórmula (não fica sutilmente errada)', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('AS liquido')) {
      // Transações: líquido 200. + transferência recebida 50 - transferência
      // enviada 30 = líquido total 220 (a query soma tudo numa única
      // subquery composta — simula o resultado final já agregado).
      return { rows: [{ liquido: 220 }] };
    }
    return { rows: [] };
  });

  const novoSaldoInicial = await db.calibrarSaldoInicialConta('user1@c.us', 84, 500);
  assert.equal(novoSaldoInicial, 280); // 500 - 220
});

test('calibrarSaldoInicialConta: é idempotente — rodar de novo com o mesmo líquido dá o mesmo resultado', async (t) => {
  mockResolverIdentidade(t);
  const chamadasUpdate = [];

  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('AS liquido')) return { rows: [{ liquido: 200 }] };
    if (sql.includes('UPDATE contas SET saldo_inicial')) {
      chamadasUpdate.push(params[1]);
      return { rows: [] };
    }
    return { rows: [] };
  });

  await db.calibrarSaldoInicialConta('user1@c.us', 84, 500);
  await db.calibrarSaldoInicialConta('user1@c.us', 84, 500);

  assert.deepEqual(chamadasUpdate, [300, 300], 'rodar 2x com os mesmos dados converge para o mesmo valor, não acumula');
});

test('calibrarSaldoInicialConta: resolve pelo usuário principal (contas compartilhadas)', async (t) => {
  let queryParams = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('contatos_compartilhados')) {
      return { rows: [{ usuario_principal_id: 'principal@c.us' }] };
    }
    if (sql.includes('AS liquido')) { queryParams = params; return { rows: [{ liquido: 0 }] }; }
    return { rows: [] };
  });

  await db.calibrarSaldoInicialConta('5511988887777@c.us', 84, 500);
  assert.equal(queryParams[0], 'principal@c.us');
});
