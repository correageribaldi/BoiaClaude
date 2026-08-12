// ── Setup: env ANTES de carregar database ────────────────────────────────────
// Sem senha na URL (só usuário) — a Pool nunca chega a conectar de verdade
// nestes testes (pool.query é mockado abaixo), então isso não muda nada do
// comportamento testado.
process.env.DATABASE_URL = 'postgres://mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Mock de db.pool.query (função de fora de transação — não usa client
// dedicado). Responde à SELECT de frequência e à UPDATE conforme o texto do
// SQL, do mesmo jeito que os outros testes de src/database.js já fazem.
function mockPool(t, { frequencia = 'mensal' } = {}) {
  const log = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    log.push({ sql, params });
    if (sql.includes('SELECT frequencia FROM recorrencias')) {
      return { rows: frequencia === null ? [] : [{ frequencia }] };
    }
    if (sql.includes('UPDATE recorrencias')) {
      return {
        rows: [{
          id: params[4], dia_inicial: params[0], dia_limite: params[1],
          valor_min: params[2], valor_max: params[3],
        }],
      };
    }
    return { rows: [] };
  });
  return log;
}

const achar = (log, trecho) => log.filter(c => c.sql.includes(trecho));

// ── Atomicidade do par ────────────────────────────────────────────────────
//
// O alerta que motiva esta rota: janela (dia_inicial/dia_limite) e faixa
// (valor_min/valor_max) são pares, e gravar campo a campo (como
// atualizarRecorrencia faz para os campos escalares) abriria uma janela onde
// um request concorrente lê a regra com só metade do par atualizado.

test('atualizarJanelaFaixaRecorrencia: grava os quatro campos numa única instrução UPDATE', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  const r = await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, {
    diaInicial: 1, diaLimite: 5, valorMin: 1500, valorMax: 2500,
  });

  const updates = achar(log, 'UPDATE recorrencias');
  assert.equal(updates.length, 1, 'janela e faixa precisam gravar numa instrução só, nunca duas');
  assert.deepEqual(updates[0].params, [1, 5, 1500, 2500, 10, 'user1@c.us']);
  assert.equal(r.dia_inicial, 1);
  assert.equal(r.dia_limite, 5);
  assert.equal(r.valor_min, 1500);
  assert.equal(r.valor_max, 2500);
});

test('atualizarJanelaFaixaRecorrencia: janela invertida é rejeitada antes de qualquer UPDATE', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  await assert.rejects(
    () => db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, { diaInicial: 20, diaLimite: 5 }),
    /Janela de dias inválida/
  );
  assert.equal(achar(log, 'UPDATE recorrencias').length, 0, 'dado inválido não pode chegar a gravar nada');
});

test('atualizarJanelaFaixaRecorrencia: faixa invertida é rejeitada antes de qualquer UPDATE', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  await assert.rejects(
    () => db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, { valorMin: 2500, valorMax: 1500 }),
    /Faixa de valor inválida/
  );
  assert.equal(achar(log, 'UPDATE recorrencias').length, 0);
});

test('atualizarJanelaFaixaRecorrencia: limpar a faixa grava NULL nos dois lados (volta ao "sem faixa")', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  const r = await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, {
    diaInicial: 1, diaLimite: 5, valorMin: null, valorMax: null,
  });

  const update = achar(log, 'UPDATE recorrencias')[0];
  assert.equal(update.params[2], null);
  assert.equal(update.params[3], null);
  assert.equal(r.valor_min, null);
  assert.equal(r.valor_max, null);
});

test('atualizarJanelaFaixaRecorrencia: limpar a janela grava NULL nos dois lados (volta ao dia_mes ± padrão)', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, {
    diaInicial: null, diaLimite: null, valorMin: 1500, valorMax: 2500,
  });

  const update = achar(log, 'UPDATE recorrencias')[0];
  assert.equal(update.params[0], null);
  assert.equal(update.params[1], null);
});

test('atualizarJanelaFaixaRecorrencia: regra semanal não grava janela de dias (dado morto)', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'semanal' });

  const r = await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, {
    diaInicial: 1, diaLimite: 5, valorMax: 3000,
  });

  const update = achar(log, 'UPDATE recorrencias')[0];
  assert.equal(update.params[0], null, 'semanal casa pelo dia da semana — janela de mês seria dado morto');
  assert.equal(update.params[1], null);
  assert.equal(update.params[3], 3000, 'a faixa continua valendo para regra semanal');
  assert.equal(r.dia_inicial, null);
});

test('atualizarJanelaFaixaRecorrencia: regra inexistente ou de outro usuário devolve null sem tentar o UPDATE', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: null });

  const r = await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 999, { valorMax: 100 });

  assert.equal(r, null);
  assert.equal(achar(log, 'UPDATE recorrencias').length, 0);
});

test('atualizarJanelaFaixaRecorrencia: consulta a regra e grava sob o mesmo usuário nas duas queries', async (t) => {
  mockResolverIdentidade(t);
  const log = mockPool(t, { frequencia: 'mensal' });

  await db.atualizarJanelaFaixaRecorrencia('user1@c.us', 10, { valorMax: 100 });

  const select = achar(log, 'SELECT frequencia FROM recorrencias')[0];
  const update = achar(log, 'UPDATE recorrencias')[0];
  assert.ok(select, 'a regra precisa ser consultada antes de gravar (pra saber a frequência)');
  assert.equal(select.params[1], 'user1@c.us');
  assert.equal(update.params[5], 'user1@c.us', 'as duas queries usam o mesmo usuário resolvido');
});
