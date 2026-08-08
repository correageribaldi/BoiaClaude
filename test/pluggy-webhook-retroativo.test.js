// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'h'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const pluggy = require('../src/pluggy');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── webhookJaRegistrado (função pura) ───────────────────────────────────────────

test('webhookJaRegistrado: lista vazia nunca está registrado', () => {
  assert.equal(pluggy.webhookJaRegistrado([], 'https://x.com/webhook/pluggy/abc'), false);
});

test('webhookJaRegistrado: URL igual e ativo (sem disabledAt) conta como registrado', () => {
  const existentes = [{ url: 'https://x.com/webhook/pluggy/abc', event: 'all' }];
  assert.equal(pluggy.webhookJaRegistrado(existentes, 'https://x.com/webhook/pluggy/abc'), true);
});

test('webhookJaRegistrado: URL igual mas desabilitado (disabledAt presente) não conta', () => {
  const existentes = [{ url: 'https://x.com/webhook/pluggy/abc', disabledAt: '2026-01-01T00:00:00Z' }];
  assert.equal(pluggy.webhookJaRegistrado(existentes, 'https://x.com/webhook/pluggy/abc'), false);
});

test('webhookJaRegistrado: URL diferente não conta, mesmo com outros ativos', () => {
  const existentes = [{ url: 'https://x.com/webhook/pluggy/outro-token' }];
  assert.equal(pluggy.webhookJaRegistrado(existentes, 'https://x.com/webhook/pluggy/abc'), false);
});

test('webhookJaRegistrado: múltiplos webhooks, um deles bate', () => {
  const existentes = [
    { url: 'https://x.com/webhook/pagamento' },
    { url: 'https://x.com/webhook/pluggy/abc' },
  ];
  assert.equal(pluggy.webhookJaRegistrado(existentes, 'https://x.com/webhook/pluggy/abc'), true);
});

// ── garantirWebhookRegistrado — só o caminho que não toca rede/Redis ────────────
// (a chamada real à API — listarWebhooksPluggy/criarWebhookPluggy via
// buscarApiKeyDoUsuario — é binding léxico interno do módulo, não mockável
// por fora; coberta indiretamente por webhookJaRegistrado acima).

test('garantirWebhookRegistrado: sem PAINEL_BASE_URL lança erro antes de tentar rede', async (t) => {
  const anterior = process.env.PAINEL_BASE_URL;
  delete process.env.PAINEL_BASE_URL;
  t.mock.method(db, 'obterOuCriarWebhookTokenPluggy', async () => 'token-fake-123');

  try {
    await assert.rejects(
      () => pluggy.garantirWebhookRegistrado('user1@c.us'),
      /PAINEL_BASE_URL/
    );
  } finally {
    if (anterior === undefined) delete process.env.PAINEL_BASE_URL;
    else process.env.PAINEL_BASE_URL = anterior;
  }
});

// ── buscarPluggyItemDoUsuario (database.js) — proteção contra IDOR ─────────────

test('buscarPluggyItemDoUsuario: encontra o item quando pertence ao usuário', async (t) => {
  mockResolverIdentidade(t);
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ id: 1, usuario_id: 'user1@c.us', status: 'UPDATED', ultimo_sync_em: null }] };
  });

  const item = await db.buscarPluggyItemDoUsuario('user1@c.us', 'item-123');

  assert.equal(item.id, 1);
  assert.deepEqual(paramsCapturados, ['item-123', 'user1@c.us']);
});

test('buscarPluggyItemDoUsuario: item de outro usuário retorna null (não vaza pertencimento)', async (t) => {
  mockResolverIdentidade(t);
  // A query já filtra por usuario_id = uid — simula "não encontrado" porque
  // o item existe mas pertence a outro usuário.
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const item = await db.buscarPluggyItemDoUsuario('user1@c.us', 'item-de-outro-usuario');
  assert.equal(item, null);
});

test('buscarPluggyItemDoUsuario: resolve pelo usuário principal (contas compartilhadas)', async (t) => {
  let queryParams = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('contatos_compartilhados')) {
      return { rows: [{ usuario_principal_id: 'principal@c.us' }] };
    }
    queryParams = params;
    return { rows: [] };
  });

  await db.buscarPluggyItemDoUsuario('5511988887777@c.us', 'item-123');
  assert.equal(queryParams[1], 'principal@c.us');
});
