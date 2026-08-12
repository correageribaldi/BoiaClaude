// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Captura o INSERT da próxima chamada e devolve os params
function capturarInsert(t, tabela, rowsRetorno) {
  const capturado = { sql: null, params: null };
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes(`INSERT INTO ${tabela}`)) {
      capturado.sql = sql;
      capturado.params = params;
      return { rows: rowsRetorno };
    }
    return { rows: [] };
  });
  return capturado;
}

test('criarRecorrencia: cartão preenchido grava cartao_id e zera conta_id', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'recorrencias', [{ id: 7 }]);

  // Cliente manda os dois (form com conta padrão selecionada + cartão escolhido).
  // A origem é exclusiva: cartão vence, conta tem de sair NULL — senão a fixa
  // conta duas vezes (direto na conta e de novo na fatura).
  await db.criarRecorrencia(
    'user1@c.us', 'despesa', 120.5, 'Netflix', 'Lazer', 'mensal', 10, null,
    '2026-08-10', null, 42, 99
  );

  assert.ok(cap.params, 'INSERT em recorrencias não foi executado');
  const [, , , , , , , , , , cartaoId, contaId] = cap.params;
  assert.equal(cartaoId, 42);
  assert.equal(contaId, null);
});

test('criarRecorrencia: sem cartão preserva conta_id', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'recorrencias', [{ id: 8 }]);

  await db.criarRecorrencia(
    'user1@c.us', 'despesa', 2500, 'Aluguel', 'Moradia', 'mensal', 5, null,
    '2026-08-05', null, null, 99
  );

  const [, , , , , , , , , , cartaoId, contaId] = cap.params;
  assert.equal(cartaoId, null);
  assert.equal(contaId, 99);
});

test('criarRecorrencia: regra antiga (sem origem) continua gravando os dois NULL', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'recorrencias', [{ id: 9 }]);

  // Call site legado, com 10 argumentos posicionais — não pode quebrar.
  await db.criarRecorrencia(
    'user1@c.us', 'receita', 5000, 'Salário', 'Salário', 'mensal', 1, null,
    '2026-08-01', null
  );

  const [, , , , , , , , , , cartaoId, contaId] = cap.params;
  assert.equal(cartaoId, null);
  assert.equal(contaId, null);
});

test('criarRecorrencia: janela e faixa vêm no último argumento e viram colunas', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'recorrencias', [{ id: 10 }]);

  await db.criarRecorrencia(
    'user1@c.us', 'receita', 1850, 'Salário', 'Salário', 'mensal', 5, null,
    '2026-08-05', null, null, 99,
    { diaInicial: 1, diaLimite: 5, valorMin: 1500, valorMax: 2500 }
  );

  const [, , , , , , , , , , , , diaInicial, diaLimite, valorMin, valorMax] = cap.params;
  assert.equal(diaInicial, 1);
  assert.equal(diaLimite, 5);
  assert.equal(valorMin, 1500);
  assert.equal(valorMax, 2500);
});

test('criarRecorrencia: chamador antigo (sem o argumento) grava as quatro colunas NULL', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'recorrencias', [{ id: 11 }]);

  // É o caso do agente do WhatsApp e da importação de extrato: eles não sabem
  // que janela e faixa existem, e a regra criada tem de continuar valendo.
  await db.criarRecorrencia(
    'user1@c.us', 'despesa', 120.5, 'Netflix', 'Lazer', 'mensal', 10, null,
    '2026-08-10', null
  );

  assert.deepEqual(cap.params.slice(12), [null, null, null, null]);
});

test('adicionarTransacaoComRecorrencia: propaga cartao_id da regra e deixa conta_id NULL', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'transacoes', [{ id: 1, numero_usuario: 31 }]);

  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'despesa', 120.5, 'Netflix', 'Lazer', '2026-09-10', 'pendente',
    7, 42, null
  );

  assert.ok(cap.sql.includes('conta_id'), 'INSERT precisa gravar conta_id explicitamente');
  const cartaoId = cap.params[8];
  const contaId  = cap.params[9];
  assert.equal(cartaoId, 42);
  assert.equal(contaId, null);
});

test('adicionarTransacaoComRecorrencia: propaga conta_id da regra e deixa cartao_id NULL', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'transacoes', [{ id: 2, numero_usuario: 32 }]);

  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'despesa', 2500, 'Aluguel', 'Moradia', '2026-09-05', 'pendente',
    8, null, 99
  );

  const cartaoId = cap.params[8];
  const contaId  = cap.params[9];
  assert.equal(cartaoId, null);
  assert.equal(contaId, 99);
});

test('adicionarTransacaoComRecorrencia: cartão e conta juntos nunca chegam ao banco', async (t) => {
  mockResolverIdentidade(t);
  const cap = capturarInsert(t, 'transacoes', [{ id: 3, numero_usuario: 33 }]);

  // Bug de produção da mesma classe já existiu em transacoes (as duas colunas
  // preenchidas ao mesmo tempo, saldo contado em dobro). A normalização tem de
  // acontecer mesmo quando o chamador manda os dois.
  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'despesa', 80, 'Spotify', 'Lazer', '2026-09-12', 'pendente',
    9, 42, 99
  );

  const cartaoId = cap.params[8];
  const contaId  = cap.params[9];
  assert.equal(cartaoId, 42);
  assert.equal(contaId, null);
});

test('calcularOcorrenciasNoPerodo: ocorrência herda a origem da regra', () => {
  const regras = [
    { id: 1, tipo: 'despesa', valor: 120.5, descricao: 'Netflix', categoria: 'Lazer',
      frequencia: 'mensal', dia_mes: 10, dia_semana: null,
      data_inicio: '2026-01-10', data_fim: null, cartao_id: 42, conta_id: null },
    { id: 2, tipo: 'despesa', valor: 2500, descricao: 'Aluguel', categoria: 'Moradia',
      frequencia: 'mensal', dia_mes: 5, dia_semana: null,
      data_inicio: '2026-01-05', data_fim: null, cartao_id: null, conta_id: 99 },
    { id: 3, tipo: 'receita', valor: 5000, descricao: 'Salário', categoria: 'Salário',
      frequencia: 'mensal', dia_mes: 1, dia_semana: null,
      data_inicio: '2026-01-01', data_fim: null },
  ];

  const ocorrencias = db.calcularOcorrenciasNoPerodo(
    regras, new Date(2026, 8, 1), new Date(2026, 8, 30)
  );

  const netflix = ocorrencias.find(o => o.recorrencia_id === 1);
  const aluguel = ocorrencias.find(o => o.recorrencia_id === 2);
  const salario = ocorrencias.find(o => o.recorrencia_id === 3);

  assert.equal(netflix.cartao_id, 42);
  assert.equal(netflix.conta_id, null);
  assert.equal(aluguel.cartao_id, null);
  assert.equal(aluguel.conta_id, 99);
  // Regra criada antes da coluna existir: origem genérica, sem campo no objeto.
  assert.equal(salario.cartao_id, null);
  assert.equal(salario.conta_id, null);
});
