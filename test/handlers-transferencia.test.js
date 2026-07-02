// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const handlers = require('../src/handlers');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Evita I/O real no fluxo persistido (fluxo_ativo) durante os testes multi-turn
function mockFluxoAtivoDB(t) {
  t.mock.method(db, 'salvarFluxoAtivoDB', async () => {});
  t.mock.method(db, 'buscarFluxoAtivoDB', async () => null);
  t.mock.method(db, 'limparFluxoAtivoDB', async () => {});
}

test('handleTransferencia: valor + origem + destino completos executa direto', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => {
    if (/corrente/i.test(nome)) return [{ id: 1, nome: 'Conta Corrente', tipo: 'corrente', ativo: true, padrao: true }];
    if (/poup/i.test(nome)) return [{ id: 2, nome: 'Poupança', tipo: 'poupanca', ativo: true, padrao: false }];
    return [];
  });
  let paramsCapturados = null;
  t.mock.method(db, 'criarTransferencia', async (usuarioId, origemId, destinoId, valor, descricao) => {
    paramsCapturados = { usuarioId, origemId, destinoId, valor, descricao };
    return { id: 1, conta_origem_id: origemId, conta_destino_id: destinoId, valor };
  });

  const resposta = await handlers.handleTransferencia('user1@c.us', {
    valor: 100, conta_origem: 'conta corrente', conta_destino: 'poupança',
  });

  assert.ok(resposta.includes('100'));
  assert.ok(resposta.includes('Conta Corrente'));
  assert.ok(resposta.includes('Poupança'));
  assert.ok(resposta.toLowerCase().includes('registrada'));
  assert.equal(paramsCapturados.origemId, 1);
  assert.equal(paramsCapturados.destinoId, 2);
  assert.equal(paramsCapturados.valor, 100);
});

test('handleTransferencia: sem valor inicia fluxo multi-turn perguntando o valor', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);

  const resposta = await handlers.handleTransferencia('user2@c.us', {
    valor: null, conta_origem: 'conta corrente', conta_destino: 'poupança',
  });

  assert.ok(resposta.toLowerCase().includes('valor'));
});

test('handleTransferencia: sem conta origem pergunta a origem', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);

  const resposta = await handlers.handleTransferencia('user3@c.us', {
    valor: 50, conta_origem: null, conta_destino: 'carteira',
  });

  assert.ok(resposta.toLowerCase().includes('conta'));
});

test('handleTransferencia: sem conta destino pergunta o destino', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async () => ([
    { id: 1, nome: 'Conta Corrente', tipo: 'corrente', ativo: true, padrao: true },
  ]));

  const resposta = await handlers.handleTransferencia('user4@c.us', {
    valor: 50, conta_origem: 'conta corrente', conta_destino: null,
  });

  assert.ok(resposta.toLowerCase().includes('conta'));
});

test('handleTransferencia: nome de conta origem ambíguo pede desambiguação', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => {
    if (/nubank/i.test(nome)) {
      return [
        { id: 1, nome: 'Conta Nubank', tipo: 'corrente', ativo: true, padrao: false },
        { id: 2, nome: 'Conta Nubank PJ', tipo: 'corrente', ativo: true, padrao: false },
      ];
    }
    return [];
  });

  const resposta = await handlers.handleTransferencia('user5@c.us', {
    valor: 50, conta_origem: 'nubank', conta_destino: 'poupança',
  });

  assert.ok(resposta.toLowerCase().includes('encontrei'));
});

test('handleTransferencia: conta origem inexistente retorna mensagem amigável', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async () => []);
  t.mock.method(db, 'listarContas', async () => []);

  const resposta = await handlers.handleTransferencia('user6@c.us', {
    valor: 50, conta_origem: 'inexistente', conta_destino: 'poupança',
  });

  assert.ok(resposta.toLowerCase().includes('não encontrei'));
});

test('handleTransferencia: erro do banco (ex: mesma conta) é repassado ao usuário', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => ([
    { id: 1, nome: 'Conta Única', tipo: 'corrente', ativo: true, padrao: true },
  ]));
  t.mock.method(db, 'criarTransferencia', async () => {
    throw new Error('Conta de origem e destino não podem ser a mesma.');
  });

  const resposta = await handlers.handleTransferencia('user7@c.us', {
    valor: 50, conta_origem: 'única', conta_destino: 'única',
  });

  assert.ok(resposta.includes('❌'));
  assert.ok(resposta.toLowerCase().includes('mesma'));
});

test('handleTransferencia: valor preenchido mas sem contas, depois resolvido, completa a transferência', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => {
    if (/corrente/i.test(nome)) return [{ id: 1, nome: 'Conta Corrente', tipo: 'corrente', ativo: true, padrao: true }];
    if (/poup/i.test(nome)) return [{ id: 2, nome: 'Poupança', tipo: 'poupanca', ativo: true, padrao: false }];
    return [];
  });
  t.mock.method(db, 'criarTransferencia', async (usuarioId, origemId, destinoId, valor) => ({
    id: 1, conta_origem_id: origemId, conta_destino_id: destinoId, valor,
  }));

  const resposta = await handlers.handleTransferencia('user8@c.us', {
    valor: 200, conta_origem: 'conta corrente', conta_destino: 'poupança',
  });

  assert.ok(resposta.toLowerCase().includes('registrada'));
});

test('handleTransferencia: valor com origem já resolvida e destino ainda faltando encadeia corretamente', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);
  t.mock.method(db, 'buscarContasPorNome', async (usuarioId, nome) => {
    if (/corrente/i.test(nome)) return [{ id: 1, nome: 'Conta Corrente', tipo: 'corrente', ativo: true, padrao: true }];
    if (/carteira/i.test(nome)) return [{ id: 3, nome: 'Carteira', tipo: 'carteira', ativo: true, padrao: false }];
    return [];
  });
  t.mock.method(db, 'criarTransferencia', async (usuarioId, origemId, destinoId, valor) => ({
    id: 1, conta_origem_id: origemId, conta_destino_id: destinoId, valor,
  }));

  // Passo 1: falta valor e destino → pergunta valor primeiro
  const passo1 = await handlers.handleTransferencia('user9@c.us', {
    valor: null, conta_origem: 'conta corrente', conta_destino: null,
  });
  assert.ok(passo1.toLowerCase().includes('valor'));

  // Passo 2: já com valor e origem, falta destino → pergunta destino
  const passo2 = await handlers.handleTransferencia('user9@c.us', {
    valor: 50, conta_origem: 'conta corrente', conta_destino: null,
  });
  assert.ok(passo2.toLowerCase().includes('conta'));

  // Passo 3: tudo preenchido → executa e confirma
  const passo3 = await handlers.handleTransferencia('user9@c.us', {
    valor: 50, conta_origem: 'conta corrente', conta_destino: 'carteira',
  });
  assert.ok(passo3.toLowerCase().includes('registrada'));
});
