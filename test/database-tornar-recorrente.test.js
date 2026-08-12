// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Cliente falso de transação: registra tudo que passou por ele e devolve a
// transação pedida. `tx` null simula lançamento inexistente.
function mockClient(t, tx) {
  const log = [];
  const client = {
    query: async (sql, params) => {
      log.push({ sql, params });
      if (sql.includes('FROM transacoes')) return { rows: tx ? [tx] : [] };
      if (sql.includes('INSERT INTO recorrencias')) return { rows: [{ id: 555 }] };
      return { rows: [] };
    },
    release: () => { log.push({ sql: 'RELEASE', params: null }); },
  };
  t.mock.method(db.pool, 'connect', async () => client);
  return log;
}

const achar = (log, trecho) => log.find(c => c.sql.includes(trecho));

const TX_CARTAO = {
  id: 900, tipo: 'despesa', valor: 59.9, descricao: 'Spotify', categoria: 'Lazer',
  data: '2026-08-10', recorrencia_id: null, cartao_id: 42, conta_id: null,
};
const TX_CONTA = {
  id: 901, tipo: 'despesa', valor: 2500, descricao: 'Aluguel', categoria: 'Moradia',
  data: '2026-08-05', recorrencia_id: null, cartao_id: null, conta_id: 99,
};

test('tornarTransacaoRecorrente: regra herda valor, descrição, categoria, tipo e o cartão de origem', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CARTAO);

  const r = await db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal' });

  const insert = achar(log, 'INSERT INTO recorrencias');
  assert.ok(insert, 'a regra não foi criada');
  const [uid, tipo, valor, descricao, categoria, freq, diaMes, diaSemana, dataInicio, dataFim, cartaoId, contaId] = insert.params;
  assert.equal(uid, 'user1@c.us');
  assert.equal(tipo, 'despesa');
  assert.equal(valor, 59.9);
  assert.equal(descricao, 'Spotify');
  assert.equal(categoria, 'Lazer');
  assert.equal(freq, 'mensal');
  assert.equal(diaMes, 10, 'dia do mês sai da data do lançamento');
  assert.equal(diaSemana, null);
  assert.equal(dataInicio, '2026-08-10');
  assert.equal(dataFim, null, 'sem "X vezes" a regra é indeterminada');
  assert.equal(cartaoId, 42, 'a fixa paga no cartão precisa nascer com o cartão');
  assert.equal(contaId, null);
  assert.equal(r.recorrencia_id, 555);
});

test('tornarTransacaoRecorrente: lançamento de conta herda conta_id e nunca cartao_id', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'mensal' });

  const insert = achar(log, 'INSERT INTO recorrencias');
  assert.equal(insert.params[10], null, 'cartao_id');
  assert.equal(insert.params[11], 99, 'conta_id');
  assert.equal(insert.params[6], 5, 'dia do mês = dia do lançamento');
});

test('tornarTransacaoRecorrente: vincula a transação de origem à regra criada', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CARTAO);

  await db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal' });

  const update = achar(log, 'UPDATE transacoes SET recorrencia_id');
  assert.ok(update, 'a transação de origem ficou solta da regra');
  assert.deepEqual(update.params, [555, 900, 'user1@c.us']);
  assert.ok(achar(log, 'COMMIT'), 'criar a regra e vincular precisam ser atômicos');
});

test('tornarTransacaoRecorrente: NÃO materializa ocorrências futuras — só passa a projetar', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CARTAO);

  await db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal', vezes: 12 });

  // Materializar 12 lançamentos que o usuário nunca fez poluiria saldo e
  // "atrasadas". O sistema já materializa sozinho no dia (lembretes.js) e no
  // mês corrente (/api/transactions).
  const insertsTx = log.filter(c => c.sql.includes('INSERT INTO transacoes'));
  assert.equal(insertsTx.length, 0, 'nenhuma transação futura pode ser criada aqui');
});

test('tornarTransacaoRecorrente: "X vezes" conta o próprio lançamento como 1ª ocorrência', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA); // data 2026-08-05

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'mensal', vezes: 12 });

  // 12 vezes a partir de agosto/2026 = última em julho/2027 (11 meses depois).
  assert.equal(achar(log, 'INSERT INTO recorrencias').params[9], '2027-07-05');
});

test('tornarTransacaoRecorrente: semanal deriva dia_semana e virada de ano no data_fim', async (t) => {
  mockResolverIdentidade(t);
  const tx = { ...TX_CONTA, data: '2026-12-24' }; // quinta-feira
  const log = mockClient(t, tx);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'semanal', vezes: 4 });

  const insert = achar(log, 'INSERT INTO recorrencias');
  assert.equal(insert.params[5], 'semanal');
  assert.equal(insert.params[6], null, 'semanal não usa dia_mes');
  assert.equal(insert.params[7], new Date('2026-12-24T12:00:00').getDay());
  assert.equal(insert.params[9], '2027-01-14', 'data_fim atravessa o ano corretamente');
});

test('tornarTransacaoRecorrente: lançamento já ligado a uma regra é recusado sem criar nada', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, { ...TX_CARTAO, recorrencia_id: 7 });

  const r = await db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal' });

  assert.equal(r.erro, 'ja_recorrente');
  assert.equal(r.recorrencia_id, 7);
  assert.equal(achar(log, 'INSERT INTO recorrencias'), undefined, 'não pode criar regra duplicada');
  assert.ok(achar(log, 'ROLLBACK'));
});

test('tornarTransacaoRecorrente: transação inexistente retorna nao_encontrada', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, null);

  const r = await db.tornarTransacaoRecorrente('user1@c.us', 12345, { frequencia: 'mensal' });

  assert.equal(r.erro, 'nao_encontrada');
  assert.equal(achar(log, 'INSERT INTO recorrencias'), undefined);
  assert.ok(achar(log, 'ROLLBACK'));
});

test('tornarTransacaoRecorrente: trava a linha (FOR UPDATE) contra clique duplo', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CARTAO);

  await db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal' });

  // Sem o lock, dois cliques criariam duas regras para o mesmo lançamento e o
  // mês seria contado em dobro.
  assert.ok(achar(log, 'FROM transacoes').sql.includes('FOR UPDATE'));
});

test('tornarTransacaoRecorrente: vezes inválido é rejeitado antes de tocar o banco', async (t) => {
  mockResolverIdentidade(t);
  let conectou = false;
  t.mock.method(db.pool, 'connect', async () => { conectou = true; throw new Error('não deveria conectar'); });

  await assert.rejects(
    () => db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal', vezes: 1 }),
    /repetições inválido/
  );
  assert.equal(conectou, false);
});

// ── Janela de dias e faixa de valor na criação ───────────────────────────────
//
// Recorrência nasce sempre de um lançamento, e os dois eixos com que o próximo
// lançamento importado vai reconhecê-la (janela + faixa) são preenchidos no
// mesmo modal. São opcionais: sem eles, a regra nasce como sempre nasceu.

const IDX = { diaInicial: 12, diaLimite: 13, valorMin: 14, valorMax: 15 };

test('tornarTransacaoRecorrente: grava janela de dias e faixa de valor da regra', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA); // 2026-08-05, R$ 2.500

  await db.tornarTransacaoRecorrente('user1@c.us', 901, {
    frequencia: 'mensal', diaInicial: 1, diaLimite: 5, valorMin: 1500, valorMax: 2500,
  });

  const p = achar(log, 'INSERT INTO recorrencias').params;
  assert.equal(p[IDX.diaInicial], 1);
  assert.equal(p[IDX.diaLimite], 5);
  assert.equal(p[IDX.valorMin], 1500);
  assert.equal(p[IDX.valorMax], 2500);
});

test('tornarTransacaoRecorrente: sem janela e sem faixa as quatro colunas ficam NULL', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'mensal' });

  const p = achar(log, 'INSERT INTO recorrencias').params;
  // NULL é "regra sem janela/sem faixa" — o comportamento anterior às colunas.
  for (const idx of Object.values(IDX)) assert.equal(p[idx], null);
});

test('tornarTransacaoRecorrente: meia janela não é gravada (só um dos lados)', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'mensal', diaInicial: 1 });

  const p = achar(log, 'INSERT INTO recorrencias').params;
  assert.equal(p[IDX.diaInicial], null, 'meia janela é pior que nenhuma: o fallback derivado é coerente');
  assert.equal(p[IDX.diaLimite], null);
});

test('tornarTransacaoRecorrente: faixa aberta de um lado só é gravada', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, { frequencia: 'mensal', valorMax: 3000 });

  const p = achar(log, 'INSERT INTO recorrencias').params;
  assert.equal(p[IDX.valorMin], null);
  assert.equal(p[IDX.valorMax], 3000, 'só o teto já muda o encerramento do balde');
});

test('tornarTransacaoRecorrente: regra semanal não grava janela de dias', async (t) => {
  mockResolverIdentidade(t);
  const log = mockClient(t, TX_CONTA);

  await db.tornarTransacaoRecorrente('user1@c.us', 901, {
    frequencia: 'semanal', diaInicial: 1, diaLimite: 5, valorMax: 3000,
  });

  const p = achar(log, 'INSERT INTO recorrencias').params;
  assert.equal(p[IDX.diaInicial], null, 'semanal casa pelo dia da semana — janela de mês seria dado morto');
  assert.equal(p[IDX.diaLimite], null);
  assert.equal(p[IDX.valorMax], 3000, 'a faixa continua valendo para semanal');
});

test('tornarTransacaoRecorrente: faixa invertida é recusada antes de tocar o banco', async (t) => {
  mockResolverIdentidade(t);
  let conectou = false;
  t.mock.method(db.pool, 'connect', async () => { conectou = true; throw new Error('não deveria conectar'); });

  await assert.rejects(
    () => db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal', valorMin: 2500, valorMax: 1500 }),
    /Faixa de valor inválida/
  );
  assert.equal(conectou, false);
});

test('tornarTransacaoRecorrente: janela invertida é recusada antes de tocar o banco', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'connect', async () => { throw new Error('não deveria conectar'); });

  await assert.rejects(
    () => db.tornarTransacaoRecorrente('user1@c.us', 900, { frequencia: 'mensal', diaInicial: 20, diaLimite: 5 }),
    /Janela de dias inválida/
  );
});

// ── normalizarRegraCasamento: a validação compartilhada pelos dois caminhos ──

test('normalizarRegraCasamento: campos ausentes viram NULL (regra sem janela/faixa)', () => {
  assert.deepEqual(
    db.normalizarRegraCasamento({}),
    { diaInicial: null, diaLimite: null, valorMin: null, valorMax: null }
  );
  assert.deepEqual(
    db.normalizarRegraCasamento({ diaInicial: '', diaLimite: '', valorMin: '', valorMax: '' }),
    { diaInicial: null, diaLimite: null, valorMin: null, valorMax: null }
  );
});

test('normalizarRegraCasamento: dia fora de 1–31 é descartado, não grampeado', () => {
  const r = db.normalizarRegraCasamento({ diaInicial: 0, diaLimite: 40, frequencia: 'mensal' });
  assert.equal(r.diaInicial, null);
  assert.equal(r.diaLimite, null);
});

test('normalizarRegraCasamento: valor zero ou negativo não vira faixa', () => {
  const r = db.normalizarRegraCasamento({ valorMin: 0, valorMax: -10 });
  assert.equal(r.valorMin, null);
  assert.equal(r.valorMax, null);
});

test('normalizarRegraCasamento: string do formulário vira número', () => {
  const r = db.normalizarRegraCasamento({ diaInicial: '1', diaLimite: '5', valorMin: '1500.50', valorMax: '2500', frequencia: 'mensal' });
  assert.deepEqual(r, { diaInicial: 1, diaLimite: 5, valorMin: 1500.5, valorMax: 2500 });
});

// ── Guard de origem exclusiva na edição ──────────────────────────────────────

test('atualizarTransacao: conta_id não gruda em lançamento de cartão', async (t) => {
  mockResolverIdentidade(t);
  let sql = null;
  t.mock.method(db.pool, 'query', async (q) => {
    sql = q;
    return { rows: [{ id: 900, tipo: 'despesa', valor: 59.9, descricao: 'Spotify', categoria: 'Lazer', data: '2026-08-10', status: 'pago', cartao_id: 42, conta_id: null }] };
  });

  await db.atualizarTransacao('user1@c.us', 900, 'conta_id', 99);

  // Bug de saldo em dobro já corrigido retroativamente em initTables: as duas
  // origens preenchidas ao mesmo tempo. O painel enviava conta_id ao editar
  // qualquer transação, inclusive as de cartão.
  assert.match(sql, /conta_id = CASE WHEN cartao_id IS NULL THEN \$1::int ELSE NULL END/);
});

test('atualizarTransacao: demais campos seguem com SET direto', async (t) => {
  mockResolverIdentidade(t);
  let sql = null;
  t.mock.method(db.pool, 'query', async (q) => { sql = q; return { rows: [] }; });

  await db.atualizarTransacao('user1@c.us', 900, 'valor', 12.3);

  assert.match(sql, /SET valor = \$1/);
});
