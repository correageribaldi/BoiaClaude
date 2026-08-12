// ── Setup: env ANTES de carregar database ────────────────────────────────────
//
// Sem DATABASE_URL de propósito: nenhum teste deste arquivo abre conexão —
// db.pool.query e db.pool.connect são mockados em todos eles.
process.env.PLUGGY_ENCRYPTION_KEY = 'c'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

// Consolidar fecha o mês de uma recorrência pelo total REAL que entrou, em vez
// do valor previsto na regra. Nasce do caso em que o previsto é R$ 1.850 e o
// mês fecha com R$ 1.500 + R$ 350 — ou só com R$ 1.500.
//
// Todos os dados aqui são SINTÉTICOS.

const USUARIO = 'user1@c.us';

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Client falso de transação (BEGIN/COMMIT/ROLLBACK) para consolidarRecorrenciaMes.
function mockClient(t, opcoes = {}) {
  const { regraExiste = true, soma = 0, quantidade = 0, projecoesRemovidas = 0, falharNoInsert = false } = opcoes;
  const chamadas = [];
  const client = {
    query: async (sql, params) => {
      chamadas.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM recorrencias WHERE id')) return { rows: regraExiste ? [{ id: params[0] }] : [] };
      if (sql.includes('SUM(valor)')) return { rows: [{ total: soma, quantidade }] };
      if (sql.includes('DELETE FROM transacoes')) return { rowCount: projecoesRemovidas, rows: [] };
      if (sql.includes('INSERT INTO recorrencias_consolidacoes')) {
        if (falharNoInsert) throw new Error('falha simulada ao gravar consolidação');
        return { rows: [] };
      }
      throw new Error(`Query inesperada: ${sql}`);
    },
    release: () => { chamadas.push({ sql: 'RELEASE' }); },
  };
  t.mock.method(db.pool, 'connect', async () => client);
  return chamadas;
}

const sqlDe = (chamadas, trecho) => chamadas.find((c) => c.sql.includes(trecho));

// ── Efeito do Consolidar ─────────────────────────────────────────────────────

test('consolidar grava a SOMA REAL do mês, não o valor previsto da regra', async (t) => {
  mockResolverIdentidade(t);
  // Regra prevê R$ 1.850; entraram R$ 1.500 + R$ 350 em duas transações.
  const chamadas = mockClient(t, { soma: 1850, quantidade: 2 });

  const r = await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  assert.equal(r.valor_total, 1850);
  assert.equal(r.quantidade, 2);
  assert.equal(r.competencia, '2026-09');

  const insert = sqlDe(chamadas, 'INSERT INTO recorrencias_consolidacoes');
  assert.deepEqual(insert.params, [USUARIO, 42, '2026-09', 1850, 2]);
});

test('consolidar com o mês incompleto grava o que entrou (R$ 1.500 de R$ 1.850 previstos)', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 1500, quantidade: 1 });

  const r = await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  assert.equal(r.valor_total, 1500);
  assert.deepEqual(sqlDe(chamadas, 'INSERT INTO recorrencias_consolidacoes').params[3], 1500);
});

test('consolidar soma SÓ lançamentos reais — projeção não entra no total', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 1500, quantidade: 1 });

  await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  const soma = sqlDe(chamadas, 'SUM(valor)');
  assert.match(soma.sql, /projetada = FALSE/, 'somar a projeção contaria o previsto como realizado');
});

test('consolidar apaga a projeção remanescente do mês (e só a do mês)', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 1500, quantidade: 1, projecoesRemovidas: 1 });

  const r = await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  const del = sqlDe(chamadas, 'DELETE FROM transacoes');
  assert.match(del.sql, /projetada = TRUE/, 'nunca apaga lançamento real');
  assert.match(del.sql, /TO_CHAR\(data, 'YYYY-MM'\) = \$3/);
  assert.deepEqual(del.params, [USUARIO, 42, '2026-09']);
  assert.equal(r.projecoes_removidas, 1);
});

test('consolidar o mesmo mês de novo atualiza o total em vez de empilhar linha', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 1850, quantidade: 2 });

  await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  const insert = sqlDe(chamadas, 'INSERT INTO recorrencias_consolidacoes');
  assert.match(insert.sql, /ON CONFLICT \(recorrencia_id, competencia\)/);
  assert.match(insert.sql, /DO UPDATE SET valor_total = EXCLUDED.valor_total/);
});

test('consolidar roda em transação e faz COMMIT no fim', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 100, quantidade: 1 });

  await db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  assert.equal(chamadas[0].sql, 'BEGIN');
  assert.ok(chamadas.some((c) => c.sql === 'COMMIT'));
  assert.equal(chamadas[chamadas.length - 1].sql, 'RELEASE');
});

test('consolidar faz ROLLBACK se a gravação falhar — mês não fica meio fechado', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { soma: 100, quantidade: 1, falharNoInsert: true });

  await assert.rejects(() => db.consolidarRecorrenciaMes(USUARIO, 42, '2026-09'));

  assert.ok(chamadas.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(!chamadas.some((c) => c.sql === 'COMMIT'));
});

test('consolidar recusa recorrência de outro usuário', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockClient(t, { regraExiste: false });

  const r = await db.consolidarRecorrenciaMes(USUARIO, 999, '2026-09');

  assert.equal(r.erro, 'nao_encontrada');
  assert.ok(!chamadas.some((c) => c.sql.includes('DELETE FROM transacoes')), 'nada é apagado');
  assert.ok(chamadas.some((c) => c.sql === 'ROLLBACK'));
});

test('consolidar recusa competência fora do formato YYYY-MM', async (t) => {
  mockResolverIdentidade(t);
  await assert.rejects(() => db.consolidarRecorrenciaMes(USUARIO, 42, '2026-9'), /Competência inválida/);
  await assert.rejects(() => db.consolidarRecorrenciaMes(USUARIO, 42, ''), /Competência inválida/);
});

// ── Reversibilidade ──────────────────────────────────────────────────────────

test('desconsolidar apaga a linha e devolve o mês para acumulação', async (t) => {
  mockResolverIdentidade(t);
  let params = null;
  t.mock.method(db.pool, 'query', async (sql, p) => {
    params = p;
    assert.match(sql, /DELETE FROM recorrencias_consolidacoes/);
    return { rowCount: 1 };
  });

  const r = await db.desconsolidarRecorrenciaMes(USUARIO, 42, '2026-09');

  assert.equal(r.desfeita, true);
  assert.deepEqual(params, [USUARIO, 42, '2026-09']);
});

test('desconsolidar mês que não estava consolidado devolve desfeita = false', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rowCount: 0 }));

  const r = await db.desconsolidarRecorrenciaMes(USUARIO, 42, '2026-09');
  assert.equal(r.desfeita, false);
});

// ── faltaDaOcorrencia: a conta que substituiu "já tem transação?" ────────────

const REGRA = {
  id: 42, valor: 1850, frequencia: 'mensal', dia_mes: 5, dia_inicial: 1, dia_limite: 10,
};
const OCORRENCIA = { recorrencia_id: 42, valor: 1850, data: '2026-09-05', tipo: 'receita' };

test('faltaDaOcorrencia: mês sem nenhuma entrada projeta o previsto cheio (comportamento de sempre)', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 0, { hoje: '2026-09-03' }), 1850);
});

test('faltaDaOcorrencia: mês parcial dentro da janela projeta só a diferença', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 1500, { hoje: '2026-09-06' }), 350);
});

test('faltaDaOcorrencia: mês completo não projeta nada', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 1850, { hoje: '2026-09-06' }), 0);
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 2000, { hoje: '2026-09-06' }), 0);
});

test('faltaDaOcorrencia: parcial com a janela já vencida não espera mais o resto', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 1500, { hoje: '2026-09-20' }), 0);
});

test('faltaDaOcorrencia: mês passado com entrada parcial não fica esperando', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 1500, { hoje: '2026-11-02' }), 0);
});

test('faltaDaOcorrencia: mês futuro com entrada parcial ainda espera a diferença', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 1500, { hoje: '2026-08-20' }), 350);
});

test('faltaDaOcorrencia: mês consolidado não projeta nada, mesmo sem nenhuma entrada', () => {
  assert.equal(db.faltaDaOcorrencia(OCORRENCIA, REGRA, 0, { consolidado: true, hoje: '2026-09-03' }), 0);
});
