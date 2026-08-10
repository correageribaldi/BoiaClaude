// Consumo de LIMITADOR (semana ISO + mês) e mecanismo anti-repetição de alerta.
//
// A diferença central em relação ao modelo antigo (teto por subcategoria): o
// consumo soma TODAS as categorias do grupo. "Mercado" pode ser Supermercado +
// Compras + Alimentos e bebidas, e o teto vale para o conjunto.
//
// O pool é mockado: cada teste devolve as linhas que o Postgres devolveria e
// verifica os PARÂMETROS enviados (as datas de corte da janela e o id do
// limitador), que é onde mora a regra de negócio.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'b'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// limitador: { id, nome, semanal, mensal } | null (categoria fora de limitador)
// gastos:    { semana, mes } — já somados de todas as categorias do grupo
function mockLimitador(t, limitador, gastos) {
  const chamadas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });
    // transacoes ANTES de limitador_categorias: a query de gastos referencia as
    // duas tabelas (o grupo entra como subselect do IN).
    if (sql.includes('FROM transacoes')) {
      return { rows: [{ gastos_semana: gastos.semana, gastos_mes: gastos.mes }] };
    }
    if (sql.includes('FROM limitador_categorias')) {
      return { rows: limitador ? [limitador] : [] };
    }
    return { rows: [] };
  });
  return chamadas;
}

test('verificarLimitadorDaCategoria: calcula semana e mês em janelas independentes', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockLimitador(
    t,
    { id: 7, nome: 'Mercado', mensal: 2000, semanal: 500 },
    { semana: 410, mes: 1700 }
  );

  const info = await db.verificarLimitadorDaCategoria('u1@c.us', 'Supermercado', { dataRef: '2026-08-05' });

  assert.equal(info.limitador, 'Mercado', 'o aviso fala o nome do GRUPO, não o da subcategoria');
  assert.equal(info.id, 7);
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

test('verificarLimitadorDaCategoria: soma o GRUPO inteiro, não só a categoria consultada', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockLimitador(
    t,
    { id: 7, nome: 'Mercado', mensal: 0, semanal: 500 },
    { semana: 430, mes: 0 }
  );

  await db.verificarLimitadorDaCategoria('u1@c.us', 'Compras', { dataRef: '2026-08-05' });

  const qGastos = chamadas.find((c) => c.sql.includes('FROM transacoes'));
  // O filtro é pelo conjunto de categorias do limitador — se fosse
  // "t.categoria = $2" o teto de Mercado ignoraria metade do mercado dele.
  assert.match(
    qGastos.sql,
    /categoria IN \(SELECT categoria FROM limitador_categorias WHERE limitador_id = \$2\)/
  );
  assert.equal(qGastos.params[1], 7, 'a soma é feita pelo id do limitador, não pelo nome da categoria');
  assert.ok(!qGastos.params.includes('Compras'), 'a categoria consultada não pode restringir a soma');
});

test('verificarLimitadorDaCategoria: teto só semanal devolve mes null (e vice-versa)', async (t) => {
  mockResolverIdentidade(t);
  mockLimitador(t, { id: 3, nome: 'Combustível', mensal: 0, semanal: 75 }, { semana: 80, mes: 300 });
  const soSemanal = await db.verificarLimitadorDaCategoria('u1@c.us', 'Postos de gasolina', { dataRef: '2026-08-05' });
  assert.equal(soSemanal.mes, null, 'sem teto mensal não deve inventar janela mensal');
  assert.equal(soSemanal.semana.percentual, 107);
  assert.equal(soSemanal.semana.faixa, 100);
  assert.equal(soSemanal.semana.restante, -5, 'estouro vira restante negativo');

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  mockLimitador(t, { id: 4, nome: 'Lazer', mensal: 200, semanal: 0 }, { semana: 190, mes: 190 });
  const soMensal = await db.verificarLimitadorDaCategoria('u1@c.us', 'Serviços digitais', { dataRef: '2026-08-05' });
  assert.equal(soMensal.semana, null);
  assert.equal(soMensal.mes.percentual, 95);
});

test('verificarLimitadorDaCategoria: categoria fora de limitador, ou limitador sem teto, devolve null', async (t) => {
  mockResolverIdentidade(t);

  // O caso comum: 41 subcategorias, poucos limitadores.
  mockLimitador(t, null, { semana: 0, mes: 0 });
  assert.equal(await db.verificarLimitadorDaCategoria('u1@c.us', 'Apostas'), null);

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  mockLimitador(t, { id: 9, nome: 'SemTeto', mensal: 0, semanal: 0 }, { semana: 0, mes: 0 });
  assert.equal(
    await db.verificarLimitadorDaCategoria('u1@c.us', 'Farmácia'),
    null,
    'limitador com os dois tetos zerados = sem controle'
  );
});

test('verificarLimitadorDaCategoria: virada de semana zera a janela semanal sem mexer na mensal', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = mockLimitador(t, { id: 7, nome: 'Mercado', mensal: 2000, semanal: 500 }, { semana: 0, mes: 1700 });

  // 2026-08-10 é a segunda seguinte: semana nova, mesmo mês.
  const info = await db.verificarLimitadorDaCategoria('u1@c.us', 'Supermercado', { dataRef: '2026-08-10' });
  const qGastos = chamadas.find((c) => c.sql.includes('FROM transacoes'));

  assert.deepEqual(qGastos.params.slice(2), ['2026-08-10', '2026-08-16', '2026-08-01', '2026-08-31']);
  assert.equal(info.semana.percentual, 0, 'semana nova começa do zero');
  assert.equal(info.mes.percentual, 85, 'mês continua acumulando');
});

test('listarConsumoLimitadores: uma query só, com as categorias de cada grupo', async (t) => {
  mockResolverIdentidade(t);
  let queries = 0;
  t.mock.method(db.pool, 'query', async (sql) => {
    queries++;
    assert.ok(sql.includes('FROM limitadores'), 'deve partir dos limitadores, não das transações');
    return {
      rows: [
        {
          id: 7, nome: 'Mercado', mensal: 2000, semanal: 500,
          categorias: ['Supermercado', 'Compras'], gastos_semana: 410, gastos_mes: 1700,
        },
        {
          id: 3, nome: 'Combustível', mensal: 0, semanal: 75,
          categorias: ['Postos de gasolina'], gastos_semana: 20, gastos_mes: 300,
        },
      ],
    };
  });

  const consumo = await db.listarConsumoLimitadores('u1@c.us', { dataRef: '2026-08-05' });

  assert.equal(queries, 1, 'não pode virar N+1');
  assert.equal(consumo.length, 2);
  assert.deepEqual(consumo[0].categorias, ['Supermercado', 'Compras']);
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
  assert.equal(await db.registrarFaixaAlertada('u1@c.us', 7, 'semana', '2026-W32', 80), true);

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rowCount: 0, rows: [] }));
  assert.equal(
    await db.registrarFaixaAlertada('u1@c.us', 7, 'semana', '2026-W32', 80),
    false,
    'mesma faixa na mesma janela não avisa de novo'
  );
});

test('registrarFaixaAlertada: SQL só promove a faixa (nunca rebaixa), por LIMITADOR e parametrizado', async (t) => {
  mockResolverIdentidade(t);
  let capturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    capturada = { sql, params };
    return { rowCount: 1, rows: [{ id: 1 }] };
  });

  await db.registrarFaixaAlertada('u1@c.us', 7, 'mes', '2026-08', 100);

  assert.match(capturada.sql, /ON CONFLICT \(usuario_id, limitador_id, janela, periodo_chave\)/);
  assert.match(capturada.sql, /WHERE limitador_alertas\.faixa < EXCLUDED\.faixa/);
  assert.deepEqual(capturada.params, ['u1@c.us', 7, 'mes', '2026-08', 100]);
  assert.ok(!/'u1@c\.us'/.test(capturada.sql), 'nenhum valor interpolado direto no SQL');
});

test('registrarFaixaAlertada: faixa 0 (abaixo de 60%) nem toca no banco', async (t) => {
  mockResolverIdentidade(t);
  let tocou = false;
  t.mock.method(db.pool, 'query', async () => { tocou = true; return { rowCount: 1, rows: [] }; });

  assert.equal(await db.registrarFaixaAlertada('u1@c.us', 7, 'semana', '2026-W32', 0), false);
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
  await db.registrarFaixaAlertada('u1@c.us', 7, 'semana', semanaAtual, 100);
  await db.registrarFaixaAlertada('u1@c.us', 7, 'semana', semanaSeguinte, 60);

  assert.notEqual(chaves[0], chaves[1]);
  assert.equal(chaves[1], '2026-W33');
});

// ── O rateio 50/30/20 não foi afetado ────────────────────────────────────────
//
// valor_limite continua existindo em limites_categoria, agora com UM sentido
// só: a fatia de orçamento da categoria. Era esta coluna servindo a dois
// conceitos (rateio e teto) que fazia o slider do painel redefinir em silêncio
// tetos digitados noutra tela.

test('salvarLimitesBatch: grava só o rateio, sem tocar em nada de teto', async (t) => {
  mockResolverIdentidade(t);
  let capturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => { capturada = { sql, params }; return { rows: [] }; });

  await db.salvarLimitesBatch('u1@c.us', [{ categoria: 'Mercado', valor_limite: 2000, parent: 'Variáveis' }]);

  assert.match(capturada.sql, /INSERT INTO limites_categoria/);
  assert.match(capturada.sql, /DO UPDATE SET valor_limite = \$3/);
  assert.ok(!capturada.sql.includes('valor_limite_semanal'), 'a coluna de teto semanal saiu do caminho do rateio');
  assert.ok(!capturada.sql.includes('limitador'), 'rateio não escreve em limitador nenhum');
  assert.deepEqual(capturada.params, ['u1@c.us', 'Mercado', 2000, 'Variáveis']);
});

test('definirLimite: continua gravando a fatia de orçamento da categoria', async (t) => {
  mockResolverIdentidade(t);
  let capturada = null;
  t.mock.method(db.pool, 'query', async (sql, params) => { capturada = { sql, params }; return { rows: [{ id: 8 }] }; });

  await db.definirLimite('u1@c.us', 'Lazer', 300);

  assert.match(capturada.sql, /DO UPDATE SET valor_limite = \$3/);
  assert.ok(!capturada.sql.includes('valor_limite_semanal'));
});

test('listarLimitesComSub: hierarquia principal/sub intacta para o slider 50/30/20', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCategoriasPrincipais', async () => [{ nome: 'Variáveis' }]);
  t.mock.method(db.pool, 'query', async (sql) => {
    assert.ok(!sql.includes('valor_limite_semanal'), 'a coluna aposentada saiu do SELECT');
    return {
      rows: [
        { categoria: 'Variáveis', valor_limite: 3000, parent: null },
        { categoria: 'Supermercado', valor_limite: 900, parent: 'Variáveis' },
        { categoria: 'Compras', valor_limite: 400, parent: 'Variáveis' },
      ],
    };
  });

  const grupos = await db.listarLimitesComSub('u1@c.us');
  const variaveis = grupos.find((g) => g.categoria === 'Variáveis');

  assert.equal(variaveis.valor_limite, 3000);
  assert.deepEqual(variaveis.subs.map((s) => s.categoria), ['Supermercado', 'Compras']);
  assert.equal(variaveis.subs[0].valor_limite, 900, 'a fatia de cada sub continua vindo');
});
