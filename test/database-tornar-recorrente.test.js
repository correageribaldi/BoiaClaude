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
