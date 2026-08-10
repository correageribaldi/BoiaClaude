// Cálculo de consumo de teto (semana ISO + mês) e mecanismo anti-repetição de
// alerta. O pool é mockado: cada teste devolve as linhas que o Postgres
// devolveria e verifica os PARÂMETROS enviados (as datas de corte da janela),
// que é onde mora a regra de negócio.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'b'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// limites: { mensal, semanal, parent } | null (categoria sem teto cadastrado)
// gastos:  { semana, mes }
function mockLimites(t, limites, gastos) {
  const chamadas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });
    if (sql.includes('FROM limites_categoria')) {
      return { rows: limites ? [limites] : [] };
    }
    if (sql.includes('FROM transacoes')) {
      return { rows: [{ gastos_semana: gastos.semana, gastos_mes: gastos.mes }] };
    }
    return { rows: [] };
  });
  return chamadas;
}

test('verificarLimitesCategoria: calcula semana e mês em janelas independentes', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockLimites(
    t,
    { mensal: 2000, semanal: 500, parent: 'Variáveis' },
    { semana: 410, mes: 1700 }
  );

  const info = await db.verificarLimitesCategoria('u1@c.us', 'Mercado', { dataRef: '2026-08-05' });

  assert.equal(info.categoria, 'Mercado');
  assert.deepEqual(
    { limite: info.semana.limite, gastos: info.semana.gastos, pct: info.semana.percentual, faixa: info.semana.faixa },
    { limite: 500, gastos: 410, pct: 82, faixa: 80 }
  );
  assert.deepEqual(
    { limite: info.mes.limite, gastos: info.mes.gastos, pct: info.mes.percentual, faixa: info.mes.faixa },
    { limite: 2000, gastos: 1700, pct: 85, faixa: 80 }
  );
  assert.equal(info.semana.restante, 90);
  assert.equal(info.mes.restante, 300);

  // Os cortes enviados ao Postgres são o coração da regra: 2026-08-05 é quarta.
  const qGastos = chamadas.find((c) => c.sql.includes('FROM transacoes'));
  assert.deepEqual(qGastos.params.slice(2), ['2026-08-03', '2026-08-09', '2026-08-01', '2026-08-31']);
});

test('verificarLimitesCategoria: teto só semanal devolve mes null (e vice-versa)', async (t) => {
  mockResolverIdentidade(t);
  mockLimites(t, { mensal: 0, semanal: 75, parent: 'Variáveis' }, { semana: 80, mes: 300 });
  const soSemanal = await db.verificarLimitesCategoria('u1@c.us', 'Combustível', { dataRef: '2026-08-05' });
  assert.equal(soSemanal.mes, null, 'sem teto mensal não deve inventar janela mensal');
  assert.equal(soSemanal.semana.percentual, 107);
  assert.equal(soSemanal.semana.faixa, 100);
  assert.equal(soSemanal.semana.restante, -5, 'estouro vira restante negativo');
});

test('verificarLimitesCategoria: só semanal e só mensal não se contaminam', async (t) => {
  mockResolverIdentidade(t);
  mockLimites(t, { mensal: 200, semanal: 0, parent: 'Lazer' }, { semana: 190, mes: 190 });
  const soMensal = await db.verificarLimitesCategoria('u1@c.us', 'Lazer diversos', { dataRef: '2026-08-05' });
  assert.equal(soMensal.semana, null);
  assert.equal(soMensal.mes.percentual, 95);
});

test('verificarLimitesCategoria: categoria sem linha, sem teto ou principal devolve null', async (t) => {
  mockResolverIdentidade(t);

  mockLimites(t, null, { semana: 0, mes: 0 });
  assert.equal(await db.verificarLimitesCategoria('u1@c.us', 'Inexistente'), null);

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  mockLimites(t, { mensal: 0, semanal: 0, parent: 'Variáveis' }, { semana: 0, mes: 0 });
  assert.equal(await db.verificarLimitesCategoria('u1@c.us', 'SemTeto'), null, 'teto zerado = sem controle');

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  mockLimites(t, { mensal: 1000, semanal: 0, parent: null }, { semana: 0, mes: 0 });
  assert.equal(
    await db.verificarLimitesCategoria('u1@c.us', 'Variáveis'),
    null,
    'categoria principal não entra no controle de subcategoria'
  );
});

test('verificarLimitesCategoria: virada de semana zera a janela semanal sem mexer na mensal', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockLimites(t, { mensal: 2000, semanal: 500, parent: 'Variáveis' }, { semana: 0, mes: 1700 });

  // 2026-08-10 é a segunda seguinte: semana nova, mesmo mês.
  const info = await db.verificarLimitesCategoria('u1@c.us', 'Mercado', { dataRef: '2026-08-10' });
  const qGastos = chamadas.find((c) => c.sql.includes('FROM transacoes'));

  assert.deepEqual(qGastos.params.slice(2), ['2026-08-10', '2026-08-16', '2026-08-01', '2026-08-31']);
  assert.equal(info.semana.percentual, 0, 'semana nova começa do zero');
  assert.equal(info.mes.percentual, 85, 'mês continua acumulando');
});

test('verificarLimiteSub: preserva o formato antigo, agora derivado da janela mensal', async (t) => {
  mockResolverIdentidade(t);
  mockLimites(t, { mensal: 800, semanal: 200, parent: 'Lazer' }, { semana: 100, mes: 600 });

  const info = await db.verificarLimiteSub('u1@c.us', 'Restaurantes', { dataRef: '2026-08-05' });

  assert.deepEqual(info, {
    categoria: 'Restaurantes',
    limite: 800,
    limiteEfetivo: 800,
    gastos: 600,
    restante: 200,
    percentual: 75,
    proporcional: false,
    diasMes: 31,
    diasUsuario: 31,
  });
});

test('listarConsumoLimites: uma query só para todas as categorias com teto', async (t) => {
  mockResolverIdentidade(t);
  let queries = 0;
  t.mock.method(db.pool, 'query', async (sql) => {
    queries++;
    assert.ok(sql.includes('FROM limites_categoria'), 'deve partir dos limites, não das transações');
    return {
      rows: [
        { categoria: 'Mercado', parent: 'Variáveis', mensal: 2000, semanal: 500, gastos_semana: 410, gastos_mes: 1700 },
        { categoria: 'Combustível', parent: 'Variáveis', mensal: 0, semanal: 75, gastos_semana: 20, gastos_mes: 300 },
      ],
    };
  });

  const consumo = await db.listarConsumoLimites('u1@c.us', { dataRef: '2026-08-05' });

  assert.equal(queries, 1, 'não pode virar N+1 (usuário pode ter dezenas de subcategorias)');
  assert.equal(consumo.length, 2);
  assert.equal(consumo[0].semana.percentual, 82);
  assert.equal(consumo[0].mes.percentual, 85);
  assert.equal(consumo[1].mes, null, 'sem teto mensal, só a barra semanal aparece');
  assert.equal(consumo[1].semana.percentual, 27);
});

// ── Anti-repetição ───────────────────────────────────────────────────────────

test('registrarFaixaAlertada: avisa ao SUBIR de faixa, cala quando não subiu', async (t) => {
  mockResolverIdentidade(t);

  // O "subiu ou não" é decidido pelo WHERE do UPDATE no Postgres: rowCount 1
  // quando inseriu/subiu, 0 quando a faixa gravada já era >= a nova.
  t.mock.method(db.pool, 'query', async () => ({ rowCount: 1, rows: [{ id: 1 }] }));
  assert.equal(await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'semana', '2026-W32', 80), true);

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rowCount: 0, rows: [] }));
  assert.equal(
    await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'semana', '2026-W32', 80),
    false,
    'mesma faixa na mesma janela não avisa de novo'
  );
});

test('registrarFaixaAlertada: SQL só promove a faixa (nunca rebaixa) e é parametrizado', async (t) => {
  mockResolverIdentidade(t);
  let capturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    capturada = { sql, params };
    return { rowCount: 1, rows: [{ id: 1 }] };
  });

  await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'mes', '2026-08', 100);

  assert.match(capturada.sql, /ON CONFLICT \(usuario_id, categoria, janela, periodo_chave\)/);
  assert.match(capturada.sql, /WHERE limites_alertas\.faixa < EXCLUDED\.faixa/);
  assert.deepEqual(capturada.params, ['u1@c.us', 'Mercado', 'mes', '2026-08', 100]);
  assert.ok(!/'u1@c\.us'/.test(capturada.sql), 'nenhum valor interpolado direto no SQL');
});

test('registrarFaixaAlertada: faixa 0 (abaixo de 60%) nem toca no banco', async (t) => {
  mockResolverIdentidade(t);
  let tocou = false;
  t.mock.method(db.pool, 'query', async () => { tocou = true; return { rowCount: 1, rows: [] }; });

  assert.equal(await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'semana', '2026-W32', 0), false);
  assert.equal(tocou, false);
});

test('registrarFaixaAlertada: janela nova gera chave nova (reset sem rotina de limpeza)', async (t) => {
  mockResolverIdentidade(t);
  const chaves = [];
  t.mock.method(db.pool, 'query', async (_sql, params) => {
    chaves.push(params[3]);
    return { rowCount: 1, rows: [{ id: 1 }] };
  });

  const semanaAtual = db.janelasDeControle('2026-08-09').semana.chave;
  const semanaSeguinte = db.janelasDeControle('2026-08-10').semana.chave;
  await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'semana', semanaAtual, 100);
  await db.registrarFaixaAlertada('u1@c.us', 'Mercado', 'semana', semanaSeguinte, 60);

  assert.notEqual(chaves[0], chaves[1]);
  assert.equal(chaves[1], '2026-W33');
});
