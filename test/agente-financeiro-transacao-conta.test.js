// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Testa o executor de tools do agente-financeiro (registrar_transacao) com o novo
// parâmetro opcional conta_nome (Marco 4). Deve reusar resolverContaPorNome
// (exportado de handlers.js no Marco 3) e NUNCA bloquear o registro da transação
// por causa de conta não encontrada ou ambígua — sempre cai no fallback de
// conta padrão (contaId = null) e apenas avisa na resposta.

const db = require('../src/database');

const agente = require('../src/agente-financeiro');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('registrar_transacao: conta explícita reconhecida — resolve contaId e passa pra db.adicionarTransacao', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'despesa');
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => {
    if (/poup/i.test(nome)) return [{ id: 2, nome: 'Poupança', tipo: 'poupanca', ativo: true, padrao: false }];
    return [];
  });

  let paramsCapturados = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria, data, status, cartaoId, contaId) => {
    paramsCapturados = { tipo, valor, cartaoId, contaId };
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user1@c.us', 'registrar_transacao', {
    tipo: 'despesa', valor: 50, descricao: 'Mercado', categoria: 'Alimentação',
    status: 'pago', conta_nome: 'poupança',
  });

  assert.equal(result.ok, true);
  assert.equal(paramsCapturados.contaId, 2);
  assert.ok(!result.msg.includes('obs:'));
});

test('registrar_transacao: sem menção de conta — cai na conta padrão (contaId null), comportamento inalterado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'despesa');
  const buscarContasSpy = t.mock.method(db, 'buscarContasPorNome', async () => []);

  let paramsCapturados = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria, data, status, cartaoId, contaId) => {
    paramsCapturados = { tipo, valor, cartaoId, contaId };
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user2@c.us', 'registrar_transacao', {
    tipo: 'despesa', valor: 30, descricao: 'Gasolina', categoria: 'Transporte',
    status: 'pago', conta_nome: null,
  });

  assert.equal(result.ok, true);
  assert.equal(paramsCapturados.contaId, null);
  assert.equal(buscarContasSpy.mock.calls.length, 0, 'não deve tentar resolver conta quando conta_nome não foi informado');
  assert.ok(!result.msg.includes('obs:'));
});

test('registrar_transacao: nome de conta não encontrado — não bloqueia, cai no fallback e avisa na resposta', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'receita');
  t.mock.method(db, 'buscarContasPorNome', async () => []);
  t.mock.method(db, 'listarContas', async () => ([
    { id: 1, nome: 'Conta Principal', tipo: 'corrente', ativo: true, padrao: true },
  ]));

  let paramsCapturados = null;
  let chamou = false;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria, data, status, cartaoId, contaId) => {
    chamou = true;
    paramsCapturados = { contaId };
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user3@c.us', 'registrar_transacao', {
    tipo: 'receita', valor: 200, descricao: 'Freela', categoria: 'Outros',
    status: 'pago', conta_nome: 'conta que não existe',
  });

  assert.equal(result.ok, true);
  assert.ok(chamou, 'a transação DEVE ser registrada mesmo com conta não encontrada');
  assert.equal(paramsCapturados.contaId, null);
  assert.ok(result.msg.toLowerCase().includes('não encontrei a conta'));
});

test('registrar_transacao: nome de conta ambíguo — não bloqueia, cai no fallback', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarTipoCategoria', async () => 'despesa');
  t.mock.method(db, 'buscarContasPorNome', async () => ([
    { id: 1, nome: 'Conta Nubank', tipo: 'corrente', ativo: true, padrao: false },
    { id: 2, nome: 'Conta Nubank PJ', tipo: 'corrente', ativo: true, padrao: false },
  ]));

  let chamou = false;
  let paramsCapturados = null;
  t.mock.method(db, 'adicionarTransacao', async (usuarioId, tipo, valor, descricao, categoria, data, status, cartaoId, contaId) => {
    chamou = true;
    paramsCapturados = { contaId };
    return { id: 1, numero_usuario: 1 };
  });

  const result = await agente.executeTool('user4@c.us', 'registrar_transacao', {
    tipo: 'despesa', valor: 80, descricao: 'Compra', categoria: 'Outros',
    status: 'pago', conta_nome: 'nubank',
  });

  assert.equal(result.ok, true);
  assert.ok(chamou, 'ambiguidade de conta não pode travar o registro da transação');
  assert.equal(paramsCapturados.contaId, null);
});
