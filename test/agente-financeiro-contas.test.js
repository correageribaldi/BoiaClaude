// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Testa o executor de tools do agente-financeiro para as tools de Conta
// (criar_conta, listar_contas, saldo_conta), que devem reusar 100% a lógica
// já existente em handlers.js (handleNovaConta, handleListarContas, handleSaldoConta)
// e em database.js (criarConta, listarContas, buscarContasPorNome, calcularSaldosPorConta).

const db = require('../src/database');

const agente = require('../src/agente-financeiro');
const handlers = require('../src/handlers');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('criar_conta (via handleNovaConta): cria conta quando nome é informado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'criarConta', async (usuarioId, nome, tipo) => ({
    id: 1, nome, tipo, saldo_inicial: 0, ativo: true, padrao: false,
  }));

  const resposta = await handlers.handleNovaConta('user1@c.us', { nome: 'Reserva', tipo: null });

  assert.ok(resposta.includes('Reserva'));
  assert.ok(resposta.toLowerCase().includes('criada'));
});

test('criar_conta (via handleNovaConta): sem nome, inicia fluxo perguntando o nome', async (t) => {
  mockResolverIdentidade(t);
  const resposta = await handlers.handleNovaConta('user2@c.us', { nome: null, tipo: null });

  assert.ok(resposta.toLowerCase().includes('nome'));
});

test('listar_contas (via handleListarContas): lista contas com saldo', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarContas', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false },
  ]));
  t.mock.method(db, 'calcularSaldosPorConta', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo: 500 },
  ]));

  const resposta = await handlers.handleListarContas('user3@c.us');

  assert.ok(resposta.includes('Poupança'));
  assert.ok(resposta.includes('500'));
});

test('listar_contas (via handleListarContas): sem contas cadastradas', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarContas', async () => []);

  const resposta = await handlers.handleListarContas('user4@c.us');

  assert.ok(resposta.toLowerCase().includes('não tem contas'));
});

test('saldo_conta (via handleSaldoConta): sem nome, mostra saldo de todas as contas', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'calcularSaldosPorConta', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo: 500 },
    { id: 2, nome: 'Carteira', tipo: 'carteira', saldo: 50 },
  ]));

  const resposta = await handlers.handleSaldoConta('user5@c.us', { conta_nome: null });

  assert.ok(resposta.includes('Poupança'));
  assert.ok(resposta.includes('Carteira'));
});

test('saldo_conta (via handleSaldoConta): nome resolve para conta única', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'buscarContasPorNome', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false },
  ]));
  t.mock.method(db, 'calcularSaldosPorConta', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo: 500 },
  ]));

  const resposta = await handlers.handleSaldoConta('user6@c.us', { conta_nome: 'poupança' });

  assert.ok(resposta.includes('Poupança'));
  assert.ok(resposta.includes('500'));
});

test('saldo_conta (via handleSaldoConta): nome ambíguo pede desambiguação', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'buscarContasPorNome', async () => ([
    { id: 1, nome: 'Conta Nubank', tipo: 'corrente', saldo_inicial: 0, ativo: true, padrao: false },
    { id: 2, nome: 'Conta Nubank PJ', tipo: 'corrente', saldo_inicial: 0, ativo: true, padrao: false },
  ]));

  const resposta = await handlers.handleSaldoConta('user7@c.us', { conta_nome: 'nubank' });

  assert.ok(resposta.toLowerCase().includes('encontrei'));
  assert.ok(resposta.includes('Conta Nubank'));
});

test('saldo_conta (via handleSaldoConta): nome não encontrado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'buscarContasPorNome', async () => []);
  t.mock.method(db, 'listarContas', async () => []);

  const resposta = await handlers.handleSaldoConta('user8@c.us', { conta_nome: 'inexistente' });

  assert.ok(resposta.toLowerCase().includes('não encontrei'));
});

test('TOOLS do agente inclui criar_conta, listar_contas e saldo_conta', () => {
  const nomes = agente.TOOLS.map(t => t.function.name);
  assert.ok(nomes.includes('criar_conta'));
  assert.ok(nomes.includes('listar_contas'));
  assert.ok(nomes.includes('saldo_conta'));
});

test('executeTool("criar_conta"): reusa handleNovaConta e retorna { ok, msg }', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'criarConta', async (usuarioId, nome, tipo) => ({
    id: 1, nome, tipo, saldo_inicial: 0, ativo: true, padrao: false,
  }));

  const result = await agente.executeTool('user9@c.us', 'criar_conta', { nome: 'Viagem', tipo: null });

  assert.equal(result.ok, true);
  assert.ok(result.msg.includes('Viagem'));
});

test('executeTool("listar_contas"): reusa handleListarContas e retorna { ok, msg }', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarContas', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false },
  ]));
  t.mock.method(db, 'calcularSaldosPorConta', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo: 500 },
  ]));

  const result = await agente.executeTool('user10@c.us', 'listar_contas', {});

  assert.equal(result.ok, true);
  assert.ok(result.msg.includes('Poupança'));
});

test('executeTool("saldo_conta"): reusa handleSaldoConta e retorna { ok, msg }', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'buscarContasPorNome', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 0, ativo: true, padrao: false },
  ]));
  t.mock.method(db, 'calcularSaldosPorConta', async () => ([
    { id: 1, nome: 'Poupança', tipo: 'poupanca', saldo: 500 },
  ]));

  const result = await agente.executeTool('user11@c.us', 'saldo_conta', { conta_nome: 'poupança' });

  assert.equal(result.ok, true);
  assert.ok(result.msg.includes('500'));
});
