// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Congela "hoje" — a janela da projeção sai de dataHojeBR(), que não é injetável.
function congelarHoje(t, isoUtc) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(isoUtc) });
}

// Monta o pool falso a partir de um cenário declarativo.
//   regras   → linhas de listarRecorrencias
//   lancadas → linhas agregadas de transacoes (chave/tipo/total)
//   vinculos → pares recorrencia_id + chave que JÁ viraram transação
//   cartoes  → ids de cartão do usuário
//   faturas  → pares cartao_id + chave que já têm transação "Fatura %"
//   parcelas → { [cartaoId]: [{ valor, mes }] } — alimenta o projetarFaturasCartao
//              REAL, que é quem transforma parcela pendente em fatura por mês
function mockPool(t, cenario = {}) {
  const {
    regras = [], lancadas = [], vinculos = [], cartoes = [], faturas = [], parcelas = {},
  } = cenario;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('FROM recorrencias')) return { rows: regras };
    if (sql.includes('GROUP BY chave, tipo')) return { rows: lancadas };
    if (sql.includes('DISTINCT recorrencia_id')) return { rows: vinculos };
    if (sql.includes('FROM cartoes')) return { rows: cartoes.map(id => ({ id })) };
    if (sql.includes('DISTINCT cartao_id')) return { rows: faturas };
    // projetarFaturasCartao: parcelas pendentes futuras de UM cartão
    if (sql.includes("as mes")) return { rows: parcelas[params[0]] || [] };
    return { rows: [] };
  });
}

const REGRA_ALUGUEL = {
  id: 1, tipo: 'despesa', valor: 2000, descricao: 'Aluguel', categoria: 'Moradia',
  frequencia: 'mensal', dia_mes: 5, dia_semana: null,
  data_inicio: '2026-01-05', data_fim: null, cartao_id: null, conta_id: 99,
};
const REGRA_SALARIO = {
  id: 2, tipo: 'receita', valor: 6000, descricao: 'Salário', categoria: 'Salário',
  frequencia: 'mensal', dia_mes: 1, dia_semana: null,
  data_inicio: '2026-01-01', data_fim: null, cartao_id: null, conta_id: 99,
};

test('projetarProximosMeses: 6 meses a partir do mês corrente, recorrência mensal em todos', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  mockPool(t, { regras: [REGRA_ALUGUEL, REGRA_SALARIO] });

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  assert.equal(r.meses.length, 6);
  assert.deepEqual(r.meses.map(m => m.chave),
    ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
  for (const m of r.meses) {
    assert.equal(m.despesas.fixas, 2000, `despesa fixa em ${m.chave}`);
    assert.equal(m.receitas.fixas, 6000, `receita fixa em ${m.chave}`);
    assert.equal(m.saldo, 4000, `saldo em ${m.chave}`);
  }
  assert.equal(r.totalRecorrencias, 2);
});

test('projetarProximosMeses: virada de ano — janela atravessa dezembro sem furo', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-11-20T15:00:00Z');
  mockPool(t, { regras: [REGRA_ALUGUEL] });

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  assert.deepEqual(r.meses.map(m => m.chave),
    ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04']);
  // Fevereiro de 2027 tem 28 dias e o dia 5 existe — nenhum mês pode ficar sem
  // a ocorrência só por causa da virada.
  for (const m of r.meses) {
    assert.equal(m.despesas.fixas, 2000, `despesa fixa em ${m.chave}`);
  }
  assert.equal(r.meses[1].ano, 2026);
  assert.equal(r.meses[2].ano, 2027);
});

test('projetarProximosMeses: recorrência semanal soma todas as ocorrências do mês', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  const feira = {
    id: 3, tipo: 'despesa', valor: 150, descricao: 'Feira', categoria: 'Alimentação',
    frequencia: 'semanal', dia_mes: null, dia_semana: 6, // sábado
    data_inicio: '2026-01-03', data_fim: null, cartao_id: null, conta_id: 99,
  };
  mockPool(t, { regras: [feira] });

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  // Agosto/2026 tem 5 sábados (1, 8, 15, 22, 29); setembro/2026 tem 4.
  assert.equal(r.meses[0].despesas.fixas, 150 * 5);
  assert.equal(r.meses[1].despesas.fixas, 150 * 4);
});

test('projetarProximosMeses: parcela pendente futura já materializada NÃO é contada duas vezes', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');

  // Setembro tem a transação do aluguel já criada (materializada com
  // recorrencia_id). Ela aparece como lançada — a projeção da MESMA regra no
  // MESMO mês tem de ser suprimida, senão setembro conta R$ 4.000 de aluguel.
  mockPool(t, {
    regras: [REGRA_ALUGUEL],
    lancadas: [{ chave: '2026-09', tipo: 'despesa', total: 2000 }],
    vinculos: [{ recorrencia_id: 1, chave: '2026-09' }],
  });

  const r = await db.projetarProximosMeses('user1@c.us', 6);
  const setembro = r.meses.find(m => m.chave === '2026-09');
  const outubro  = r.meses.find(m => m.chave === '2026-10');

  assert.equal(setembro.despesas.lancadas, 2000);
  assert.equal(setembro.despesas.fixas, 0, 'a projeção da regra já materializada some');
  assert.equal(setembro.despesas.total, 2000, 'o aluguel de setembro vale 2000, não 4000');
  // O mês sem transação continua projetando normalmente.
  assert.equal(outubro.despesas.fixas, 2000);
  assert.equal(outubro.despesas.lancadas, 0);
  assert.equal(outubro.despesas.total, 2000);
});

test('projetarProximosMeses: supressão é por mês, não por regra — outros meses seguem projetando', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  mockPool(t, {
    regras: [REGRA_ALUGUEL],
    lancadas: [{ chave: '2026-08', tipo: 'despesa', total: 2000 }],
    vinculos: [{ recorrencia_id: 1, chave: '2026-08' }],
  });

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  assert.equal(r.meses[0].despesas.total, 2000);
  for (const m of r.meses.slice(1)) {
    assert.equal(m.despesas.fixas, 2000, `${m.chave} não pode perder a projeção`);
  }
});

test('projetarProximosMeses: fatura de cartão projetada entra só onde não há fatura lançada', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  mockPool(t, {
    cartoes: [42],
    // Setembro já tem a transação "Fatura Nubank" criada — ela entra como
    // lançada (o filtro de cartão abre exceção para "Fatura %").
    lancadas: [{ chave: '2026-09', tipo: 'despesa', total: 800 }],
    faturas: [{ cartao_id: 42, chave: '2026-09' }],
    parcelas: { 42: [
      { valor: 500, mes: '2026-09' }, { valor: 300, mes: '2026-09' },
      { valor: 950, mes: '2026-10' },
    ] },
  });

  const r = await db.projetarProximosMeses('user1@c.us', 6);
  const setembro = r.meses.find(m => m.chave === '2026-09');
  const outubro  = r.meses.find(m => m.chave === '2026-10');

  assert.equal(setembro.despesas.faturasCartao, 0, 'fatura já lançada não pode ser projetada de novo');
  assert.equal(setembro.despesas.total, 800);
  assert.equal(outubro.despesas.faturasCartao, 950);
  assert.equal(outubro.despesas.total, 950);
});

test('projetarProximosMeses: compra no cartão não vira despesa direta — só a fatura', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');

  let sqlLancadas = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('GROUP BY chave, tipo')) { sqlLancadas = sql; return { rows: [] }; }
    return { rows: [] };
  });

  await db.projetarProximosMeses('user1@c.us', 6);

  // Mesmo filtro de resumoMensal/calcularSaldos: a parcela no cartão sai daqui
  // e entra apenas pela projeção de fatura, senão sairia duas vezes do saldo.
  assert.match(sqlLancadas, /cartao_id IS NULL OR descricao ILIKE 'Fatura %'/);
});

test('projetarProximosMeses: sem recorrência nenhuma devolve 6 meses zerados (estado vazio do card)', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  mockPool(t, {});

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  assert.equal(r.totalRecorrencias, 0);
  assert.equal(r.meses.length, 6);
  for (const m of r.meses) {
    assert.equal(m.receitas.total, 0);
    assert.equal(m.despesas.total, 0);
    assert.equal(m.saldo, 0);
  }
});

test('projetarProximosMeses: regra com data_fim para de projetar depois do fim', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  // Financiamento em 3x a partir de agosto: agosto, setembro e outubro.
  mockPool(t, {
    regras: [{ ...REGRA_ALUGUEL, id: 4, valor: 500, descricao: 'Curso',
               data_inicio: '2026-08-05', data_fim: '2026-10-05' }],
  });

  const r = await db.projetarProximosMeses('user1@c.us', 6);

  assert.deepEqual(r.meses.map(m => m.despesas.fixas), [500, 500, 500, 0, 0, 0]);
});

test('projetarProximosMeses: quantidade de meses é limitada (não aceita valor absurdo)', async (t) => {
  mockResolverIdentidade(t);
  congelarHoje(t, '2026-08-10T15:00:00Z');
  mockPool(t, {});

  assert.equal((await db.projetarProximosMeses('user1@c.us', 999)).meses.length, 24);
  assert.equal((await db.projetarProximosMeses('user1@c.us', 0)).meses.length, 6);
  assert.equal((await db.projetarProximosMeses('user1@c.us', -3)).meses.length, 1);
});
