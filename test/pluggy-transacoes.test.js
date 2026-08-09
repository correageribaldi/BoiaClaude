// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'f'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('https');

const db = require('../src/database');
const pluggy = require('../src/pluggy');

// ── buscarTransacoesNovas — paginação via https.request mockado ────────────────
//
// https.request é uma propriedade de um módulo core (singleton no processo) —
// diferente de funções internas do próprio pluggy.js chamadas por binding
// léxico (não mockáveis de fora, ver Marco 1/3), mockar https.request AQUI
// funciona porque pluggy.js lê essa propriedade dinamicamente a cada chamada,
// e o require('https') deste teste aponta para o mesmo objeto compartilhado.
//
// Simula o formato de "next" confirmado com chamada real em produção (ver
// src/pluggy.js): path relativo completo começando com "?", ex.
// "?accountId=X&after=BASE64" — não token isolado, não URL absoluta.
function instalarMockHttps(t, paginas) {
  const requestsFeitos = [];
  let indice = 0;

  t.mock.method(https, 'request', (options, callback) => {
    requestsFeitos.push({ hostname: options.hostname, path: options.path });
    const pagina = paginas[Math.min(indice, paginas.length - 1)];
    indice++;

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = pagina.statusCode ?? 200;
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(pagina.body)));
        res.emit('end');
      });
    };
    return req;
  });

  return requestsFeitos;
}

test('buscarTransacoesNovas: cursor "next" relativo (formato real) monta a URL certa na segunda página, sem duplicar accountId', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    {
      body: {
        results: [{ id: 'tx-1', type: 'DEBIT', amount: 50, date: '2026-08-01', status: 'POSTED' }],
        // Base64 sintético (decodifica para "fake-cursor-2") — sem relação
        // com nenhum cursor real observado em produção.
        next: '?accountId=acc-123&after=ZmFrZS1jdXJzb3ItMg%3D%3D',
      },
    },
    {
      body: {
        results: [{ id: 'tx-2', type: 'CREDIT', amount: 100, date: '2026-08-02', status: 'POSTED' }],
        next: null,
      },
    },
  ]);

  const transacoes = await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-123');

  assert.equal(transacoes.length, 2, 'deveria juntar os resultados das duas páginas');
  assert.deepEqual(transacoes.map(t2 => t2.id), ['tx-1', 'tx-2']);

  assert.equal(requestsFeitos.length, 2, 'deveria ter seguido a paginação (2 chamadas)');
  assert.equal(requestsFeitos[0].path, '/v2/transactions?accountId=acc-123');
  // Bug corrigido: a segunda chamada usava baseUrl + "&after=" + encodeURIComponent(next
  // inteiro), gerando um "after" cujo valor era a própria query string re-encodada
  // (400 da Pluggy). Correto: usar o "next" direto como path+query.
  assert.equal(requestsFeitos[1].path, '/v2/transactions?accountId=acc-123&after=ZmFrZS1jdXJzb3ItMg%3D%3D');
});

test('buscarTransacoesNovas: cursor "next" como URL absoluta é usado direto', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    { body: { results: [{ id: 'tx-1', type: 'DEBIT', amount: 10, date: '2026-08-01', status: 'POSTED' }], next: 'https://api.pluggy.ai/v2/transactions?accountId=acc-999&after=xyz' } },
    { body: { results: [], next: null } },
  ]);

  await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-999');

  assert.equal(requestsFeitos[1].hostname, 'api.pluggy.ai');
  assert.equal(requestsFeitos[1].path, '/v2/transactions?accountId=acc-999&after=xyz');
});

test('buscarTransacoesNovas: cursor "next" como token isolado (nunca observado, fallback defensivo)', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    { body: { results: [], next: 'token-bare-sem-prefixo' } },
    { body: { results: [], next: null } },
  ]);

  await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-111');

  assert.equal(requestsFeitos[1].path, '/v2/transactions?accountId=acc-111&after=token-bare-sem-prefixo');
});

test('buscarTransacoesNovas: sem "next" para na primeira página', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    { body: { results: [{ id: 'tx-unica', type: 'DEBIT', amount: 5, date: '2026-08-01', status: 'POSTED' }], next: null } },
  ]);

  const transacoes = await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-222');

  assert.equal(transacoes.length, 1);
  assert.equal(requestsFeitos.length, 1);
});

test('buscarTransacoesNovas: "desde" vira parâmetro "createdAtFrom" (não "from") na primeira chamada', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    { body: { results: [], next: null } },
  ]);

  await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-333', '2026-08-01');

  // Bug de produção: "from" não existe no endpoint /v2/transactions — a
  // Pluggy rejeita com 400 "property from should not exist". Nome correto,
  // confirmado com chamada real, é "createdAtFrom".
  assert.equal(requestsFeitos[0].path, '/v2/transactions?accountId=acc-333&createdAtFrom=2026-08-01');
});

test('buscarTransacoesNovas: paginação com "desde" usa "createdAtFrom" no fallback bare também', async (t) => {
  const requestsFeitos = instalarMockHttps(t, [
    { body: { results: [], next: 'token-bare-sem-prefixo' } },
    { body: { results: [], next: null } },
  ]);

  await pluggy.buscarTransacoesNovas('api-key-fake', 'acc-444', '2026-08-01');

  assert.equal(
    requestsFeitos[1].path,
    '/v2/transactions?accountId=acc-444&createdAtFrom=2026-08-01&after=token-bare-sem-prefixo'
  );
});

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
