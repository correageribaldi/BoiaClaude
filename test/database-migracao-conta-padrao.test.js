// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

// Simula um banco em memória mínimo o suficiente para exercitar as queries de
// migração de "Conta Principal" dentro de initTables(), sem depender de um
// Postgres real. Todas as outras queries de DDL/ALTER executadas por
// initTables() são apenas no-op (retornam rows vazias).
function criarBancoFake({ usuarios, contas, transacoes }) {
  let proximoContaId = contas.length
    ? Math.max(...contas.map((c) => c.id)) + 1
    : 1;

  return async function fakeQuery(sql) {
    const normalizado = sql.replace(/\s+/g, ' ').trim();

    if (normalizado.startsWith('INSERT INTO contas') && normalizado.includes('FROM usuarios u')) {
      // SELECT u.usuario_id, 'Conta Principal', 0, TRUE FROM usuarios u
      // LEFT JOIN contas c ON ... WHERE c.id IS NULL
      const usuariosComContaPadrao = new Set(
        contas.filter((c) => c.padrao).map((c) => c.usuario_id)
      );
      for (const u of usuarios) {
        if (usuariosComContaPadrao.has(u.usuario_id)) continue;
        const jaTemNomeIgual = contas.some(
          (c) => c.usuario_id === u.usuario_id && c.nome === 'Conta Principal'
        );
        if (jaTemNomeIgual) continue; // ON CONFLICT (usuario_id, nome) DO NOTHING
        contas.push({
          id: proximoContaId++,
          usuario_id: u.usuario_id,
          nome: 'Conta Principal',
          saldo_inicial: 0,
          padrao: true,
        });
      }
      return { rows: [] };
    }

    if (normalizado.startsWith('UPDATE transacoes t') && normalizado.includes('SET conta_id = c.id')) {
      // Bug de produção corrigido: a query real agora exige
      // "t.conta_id IS NULL AND t.cartao_id IS NULL" — antes só checava
      // conta_id IS NULL, e grudava conta_id em transações de cartão.
      for (const t of transacoes) {
        if (t.conta_id !== null) continue;
        if (t.cartao_id) continue; // reflete o "AND t.cartao_id IS NULL" do fix
        const contaPadrao = contas.find((c) => c.usuario_id === t.usuario_id && c.padrao);
        if (contaPadrao) t.conta_id = contaPadrao.id;
      }
      return { rows: [] };
    }

    if (normalizado.startsWith('UPDATE transacoes SET conta_id = NULL')) {
      // Correção retroativa (mesmo bug): desfaz o vínculo indevido em
      // qualquer transação que tenha os dois campos preenchidos.
      for (const t of transacoes) {
        if (t.cartao_id && t.conta_id !== null) t.conta_id = null;
      }
      return { rows: [] };
    }

    // Qualquer outro CREATE TABLE / ALTER TABLE / CREATE INDEX da initTables: no-op.
    return { rows: [] };
  };
}

test('initTables: cria Conta Principal para usuário sem conta e sem transação', async (t) => {
  const usuarios = [{ usuario_id: 'user-sem-transacao@c.us' }];
  const contas = [];
  const transacoes = [];

  t.mock.method(db.pool, 'query', criarBancoFake({ usuarios, contas, transacoes }));

  await db.initTables();

  const contasDoUsuario = contas.filter((c) => c.usuario_id === 'user-sem-transacao@c.us');
  assert.equal(contasDoUsuario.length, 1);
  assert.equal(contasDoUsuario[0].padrao, true);
  assert.equal(contasDoUsuario[0].nome, 'Conta Principal');
});

test('initTables: vincula transação órfã (conta_id NULL) à Conta Principal recém-criada', async (t) => {
  const usuarios = [{ usuario_id: '555194596116@c.us' }];
  const contas = [];
  const transacoes = [
    { id: 4921, usuario_id: '555194596116@c.us', descricao: 'HCO', categoria: 'Salário', conta_id: null, cartao_id: null },
  ];

  t.mock.method(db.pool, 'query', criarBancoFake({ usuarios, contas, transacoes }));

  await db.initTables();

  const contaPadrao = contas.find((c) => c.usuario_id === '555194596116@c.us' && c.padrao);
  assert.ok(contaPadrao, 'conta padrão deveria ter sido criada');

  const transacao = transacoes.find((t) => t.id === 4921);
  assert.equal(transacao.conta_id, contaPadrao.id);
});

test('initTables: usuário que já tem conta padrão não gera nova conta nem duplicata', async (t) => {
  const usuarios = [{ usuario_id: 'user-existente@c.us' }];
  const contas = [
    { id: 10, usuario_id: 'user-existente@c.us', nome: 'Conta Principal', saldo_inicial: 500, padrao: true },
  ];
  const transacoes = [];

  t.mock.method(db.pool, 'query', criarBancoFake({ usuarios, contas, transacoes }));

  await db.initTables();

  const contasDoUsuario = contas.filter((c) => c.usuario_id === 'user-existente@c.us');
  assert.equal(contasDoUsuario.length, 1, 'não deve duplicar a conta padrão existente');
  assert.equal(contasDoUsuario[0].id, 10);
  assert.equal(contasDoUsuario[0].saldo_inicial, 500, 'não deve sobrescrever saldo_inicial existente');
});

// ── Bug de produção: migração contaminava transações de cartão ────────────────

test('initTables: NÃO vincula conta_id em transação de cartão (bug de produção corrigido)', async (t) => {
  const usuarios = [{ usuario_id: 'user-cartao@c.us' }];
  const contas = [
    { id: 83, usuario_id: 'user-cartao@c.us', nome: 'Conta Principal', saldo_inicial: 0, padrao: true },
  ];
  // Transação de cartão legítima: conta_id NULL, cartao_id preenchido — é
  // exatamente esse padrão que a query antiga (sem "AND t.cartao_id IS NULL")
  // contaminava a cada boot do servidor.
  const transacoes = [
    { id: 1, usuario_id: 'user-cartao@c.us', descricao: 'Compra no cartão', conta_id: null, cartao_id: 50 },
  ];

  t.mock.method(db.pool, 'query', criarBancoFake({ usuarios, contas, transacoes }));

  await db.initTables();

  assert.equal(transacoes[0].conta_id, null, 'transação de cartão não deveria ganhar conta_id');
  assert.equal(transacoes[0].cartao_id, 50, 'cartao_id original preservado');
});

test('initTables: migração é idempotente — rodar 2x seguidas não recontamina nada', async (t) => {
  const usuarios = [{ usuario_id: 'user-cartao@c.us' }];
  const contas = [
    { id: 83, usuario_id: 'user-cartao@c.us', nome: 'Conta Principal', saldo_inicial: 0, padrao: true },
  ];
  const transacoes = [
    { id: 1, usuario_id: 'user-cartao@c.us', descricao: 'Compra no cartão', conta_id: null, cartao_id: 50 },
    { id: 2, usuario_id: 'user-cartao@c.us', descricao: 'PIX recebido', conta_id: null, cartao_id: null },
  ];

  const fakeQuery = criarBancoFake({ usuarios, contas, transacoes });
  t.mock.method(db.pool, 'query', fakeQuery);

  await db.initTables();
  await db.initTables(); // segunda rodada — simula reinício do servidor

  const txCartao = transacoes.find((t) => t.id === 1);
  const txConta = transacoes.find((t) => t.id === 2);

  assert.equal(txCartao.conta_id, null, 'transação de cartão continua sem conta_id após 2 boots');
  assert.equal(txConta.conta_id, 83, 'transação sem cartão continua vinculada à conta padrão');
});

test('initTables: correção retroativa desfaz contaminação pré-existente (dado herdado de antes do fix)', async (t) => {
  const usuarios = [{ usuario_id: 'user-federico@c.us' }];
  const contas = [
    { id: 83, usuario_id: 'user-federico@c.us', nome: 'Conta Principal', saldo_inicial: 0, padrao: true },
  ];
  // Estado herdado do bug: 3 transações de cartão já contaminadas com
  // conta_id da conta padrão, gravadas antes deste fix existir.
  const transacoes = [
    { id: 1, usuario_id: 'user-federico@c.us', descricao: 'Fatura Nubank', conta_id: 83, cartao_id: 50 },
    { id: 2, usuario_id: 'user-federico@c.us', descricao: 'Compra mercado', conta_id: 83, cartao_id: 50 },
    { id: 3, usuario_id: 'user-federico@c.us', descricao: 'PIX recebido', conta_id: 83, cartao_id: null },
  ];

  t.mock.method(db.pool, 'query', criarBancoFake({ usuarios, contas, transacoes }));

  await db.initTables();

  assert.equal(transacoes[0].conta_id, null, 'transação de cartão contaminada deve ser limpa');
  assert.equal(transacoes[1].conta_id, null, 'transação de cartão contaminada deve ser limpa');
  assert.equal(transacoes[2].conta_id, 83, 'transação legítima de conta (sem cartão) não deve ser tocada');
});
