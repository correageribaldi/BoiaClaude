// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'f'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const pluggy = require('../src/pluggy');

// ── mapearTipoTransacaoPluggy / mapearStatusTransacaoPluggy (funções puras) ────

test('mapearTipoTransacaoPluggy: CREDIT vira receita', () => {
  assert.equal(pluggy.mapearTipoTransacaoPluggy('CREDIT'), 'receita');
});

test('mapearTipoTransacaoPluggy: DEBIT vira despesa', () => {
  assert.equal(pluggy.mapearTipoTransacaoPluggy('DEBIT'), 'despesa');
});

test('mapearTipoTransacaoPluggy: valor desconhecido cai em despesa (fallback seguro)', () => {
  assert.equal(pluggy.mapearTipoTransacaoPluggy('ALGO_NOVO'), 'despesa');
});

test('mapearStatusTransacaoPluggy: PENDING vira pendente', () => {
  assert.equal(pluggy.mapearStatusTransacaoPluggy('PENDING'), 'pendente');
});

test('mapearStatusTransacaoPluggy: POSTED vira pago', () => {
  assert.equal(pluggy.mapearStatusTransacaoPluggy('POSTED'), 'pago');
});

test('mapearStatusTransacaoPluggy: valor desconhecido cai em pago (histórico real, fallback seguro)', () => {
  assert.equal(pluggy.mapearStatusTransacaoPluggy('ALGO_NOVO'), 'pago');
});

// ── interpretarErroItem (função pura) ──────────────────────────────────────────

test('interpretarErroItem: executionStatus INVALID_CREDENTIALS', () => {
  const r = pluggy.interpretarErroItem({ status: 'LOGIN_ERROR', executionStatus: 'INVALID_CREDENTIALS' });
  assert.equal(r.status, 'LOGIN_ERROR');
  assert.match(r.mensagem, /Credencial do banco expirada/);
});

test('interpretarErroItem: status LOGIN_ERROR sem executionStatus', () => {
  const r = pluggy.interpretarErroItem({ status: 'LOGIN_ERROR' });
  assert.match(r.mensagem, /Credencial do banco expirada/);
});

test('interpretarErroItem: WAITING_USER_INPUT (MFA pendente)', () => {
  const r = pluggy.interpretarErroItem({ status: 'WAITING_USER_INPUT' });
  assert.equal(r.status, 'WAITING_USER_INPUT');
  assert.match(r.mensagem, /Confirmação pendente/);
});

test('interpretarErroItem: WAITING_USER_ACTION (MFA pendente, variante)', () => {
  const r = pluggy.interpretarErroItem({ status: 'WAITING_USER_ACTION' });
  assert.match(r.mensagem, /Confirmação pendente/);
});

test('interpretarErroItem: status desconhecido cai no genérico', () => {
  const r = pluggy.interpretarErroItem({ status: 'OUTDATED' });
  assert.equal(r.status, 'OUTDATED');
  assert.match(r.mensagem, /Erro na conexão com o banco/);
});

test('interpretarErroItem: item null (falha ao buscar detalhes) cai no genérico sem quebrar', () => {
  const r = pluggy.interpretarErroItem(null);
  assert.equal(r.status, 'ERROR');
  assert.match(r.mensagem, /Erro na conexão com o banco/);
});

// ── decidirAcaoWebhook (função pura) ────────────────────────────────────────────

test('decidirAcaoWebhook: item/created e item/updated sincronizam', () => {
  assert.equal(pluggy.decidirAcaoWebhook('item/created'), 'sincronizar');
  assert.equal(pluggy.decidirAcaoWebhook('item/updated'), 'sincronizar');
});

test('decidirAcaoWebhook: item/error trata erro', () => {
  assert.equal(pluggy.decidirAcaoWebhook('item/error'), 'erro');
});

test('decidirAcaoWebhook: transactions/deleted deleta', () => {
  assert.equal(pluggy.decidirAcaoWebhook('transactions/deleted'), 'deletar');
});

test('decidirAcaoWebhook: eventos não tratados neste marco são ignorados', () => {
  assert.equal(pluggy.decidirAcaoWebhook('item/waiting_user_input'), 'ignorar');
  assert.equal(pluggy.decidirAcaoWebhook('connector/status_updated'), 'ignorar');
  assert.equal(pluggy.decidirAcaoWebhook('payment_intent/completed'), 'ignorar');
  assert.equal(pluggy.decidirAcaoWebhook(undefined), 'ignorar');
});

// ── processarWebhookEvent — só o caminho transactions/deleted, que não toca
// rede/Redis (delega só para db.removerTransacoesPluggyPorIds, mockável).
// Os caminhos sincronizar/erro chamam a API Pluggy de verdade via
// buscarApiKeyDoUsuario/buscarItemPluggy (binding léxico interno do módulo,
// não mockável por fora) — cobertos indiretamente pelos testes de
// interpretarErroItem/decidirAcaoWebhook acima e pelos testes de
// database-pluggy-transacoes.test.js para a parte de persistência.

test('processarWebhookEvent: transactions/deleted chama removerTransacoesPluggyPorIds com os ids do payload', async (t) => {
  let idsRecebidos = null;
  t.mock.method(db, 'removerTransacoesPluggyPorIds', async (ids) => { idsRecebidos = ids; return ids.length; });

  await pluggy.processarWebhookEvent('user1@c.us', {
    event: 'transactions/deleted',
    itemId: 'item-123',
    transactionIds: ['tx-1', 'tx-2'],
  });

  assert.deepEqual(idsRecebidos, ['tx-1', 'tx-2']);
});

test('processarWebhookEvent: transactions/deleted sem transactionIds no payload não quebra', async (t) => {
  let idsRecebidos = 'nao chamado';
  t.mock.method(db, 'removerTransacoesPluggyPorIds', async (ids) => { idsRecebidos = ids; return 0; });

  await pluggy.processarWebhookEvent('user1@c.us', { event: 'transactions/deleted', itemId: 'item-123' });

  assert.deepEqual(idsRecebidos, []);
});

test('processarWebhookEvent: payload sem itemId não processa nada', async (t) => {
  let chamou = false;
  t.mock.method(db, 'removerTransacoesPluggyPorIds', async () => { chamou = true; return 0; });

  await pluggy.processarWebhookEvent('user1@c.us', { event: 'transactions/deleted' });

  assert.equal(chamou, false);
});
