// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Testa o executor de tools do agente-financeiro para a tool transferir, que deve
// reusar 100% a lógica já existente em handlers.js (handleTransferencia) e
// database.js (criarTransferencia).

const db = require('../src/database');
const agente = require('../src/agente-financeiro');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

function mockFluxoAtivoDB(t) {
  t.mock.method(db, 'salvarFluxoAtivoDB', async () => {});
  t.mock.method(db, 'buscarFluxoAtivoDB', async () => null);
  t.mock.method(db, 'limparFluxoAtivoDB', async () => {});
}

test('TOOLS do agente inclui transferir', () => {
  const nomes = agente.TOOLS.map(t => t.function.name);
  assert.ok(nomes.includes('transferir'));
});

test('executeTool("transferir"): reusa handleTransferencia e retorna { ok, msg }', async (t) => {
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

  const result = await agente.executeTool('user1@c.us', 'transferir', {
    valor: 100, conta_origem: 'conta corrente', conta_destino: 'poupança',
  });

  assert.equal(result.ok, true);
  assert.ok(result.msg.includes('100'));
  assert.ok(result.msg.toLowerCase().includes('registrada'));
});

test('executeTool("transferir"): sem parâmetros retorna pergunta do fluxo multi-turn', async (t) => {
  mockResolverIdentidade(t);
  mockFluxoAtivoDB(t);

  const result = await agente.executeTool('user2@c.us', 'transferir', {});

  assert.equal(result.ok, true);
  assert.ok(result.msg.toLowerCase().includes('valor'));
});
