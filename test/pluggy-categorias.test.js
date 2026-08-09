// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'j'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('https');

const pluggy = require('../src/pluggy');
const { connection: redisConnection } = require('../src/queue');

// require('../src/queue') acima já dispara uma tentativa de conexão TCP real
// em background (o construtor do IORedis conecta sozinho, mesmo sem eu nunca
// chamar .get()/.set()) — sem Redis local, fica em retry loop indefinido
// (maxRetriesPerRequest:null) e o handle aberto impede este processo de
// teste de terminar sozinho no final (reproduzido: arquivo trava >20s até
// ser morto externamente, mesmo com todos os testes individuais passando).
// node --test roda cada arquivo em processo isolado, então isso não vaza
// para outros arquivos — mas precisa ser fechado aqui mesmo assim.
test.after(() => {
  redisConnection.disconnect();
});

// Amostra real da taxonomia oficial da Pluggy (dado público da própria
// plataforma, não é segredo nem dado privado de usuário — confirmado via
// GET /categories).
const CATEGORIAS_AMOSTRA = [
  { id: '01000000', description: 'Income', descriptionTranslated: 'Receitas' },
  { id: '03000000', description: 'Investments', descriptionTranslated: 'Investimentos' },
  { id: '05000000', description: 'Transfers', descriptionTranslated: 'Transferências' },
  { id: '08000000', description: 'Shopping', descriptionTranslated: 'Compras' },
  { id: '10000000', description: 'Groceries', descriptionTranslated: 'Supermercado' },
  { id: '11000000', description: 'Food and drinks', descriptionTranslated: 'Comidas e bebidas' },
  { id: '11010000', description: 'Eating out', descriptionTranslated: 'Restaurantes, bares e lanchonetes', parentId: '11000000' },
];

function mockRedisSemCache(t) {
  t.mock.method(redisConnection, 'get', async () => null);
  t.mock.method(redisConnection, 'set', async () => 'OK');
}

// ── traduzirCategoriaPluggy (função pura) ──────────────────────────────────────

test('traduzirCategoriaPluggy: Groceries -> Supermercado (match por categoryId)', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('10000000', 'Groceries', CATEGORIAS_AMOSTRA), 'Supermercado');
});

test('traduzirCategoriaPluggy: Shopping -> Compras', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('08000000', 'Shopping', CATEGORIAS_AMOSTRA), 'Compras');
});

test('traduzirCategoriaPluggy: Eating out -> Restaurantes, bares e lanchonetes', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('11010000', 'Eating out', CATEGORIAS_AMOSTRA), 'Restaurantes, bares e lanchonetes');
});

test('traduzirCategoriaPluggy: Transfers -> Transferências', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('05000000', 'Transfers', CATEGORIAS_AMOSTRA), 'Transferências');
});

test('traduzirCategoriaPluggy: sem categoryId, casa por description (inglês)', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy(null, 'Groceries', CATEGORIAS_AMOSTRA), 'Supermercado');
});

test('traduzirCategoriaPluggy: categoryId desconhecido (categoria nova da Pluggy) retorna null — não trava o sync', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('99999999-nao-mapeado', 'Categoria Nova', CATEGORIAS_AMOSTRA), null);
});

test('traduzirCategoriaPluggy: categoryId e description ambos ausentes retorna null', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy(null, null, CATEGORIAS_AMOSTRA), null);
});

test('traduzirCategoriaPluggy: lista de categorias vazia (cache nunca carregado) retorna null, não quebra', () => {
  assert.equal(pluggy.traduzirCategoriaPluggy('10000000', 'Groceries', []), null);
});

// ── acharGrupoRaizCategoria (função pura) ───────────────────────────────────────

test('acharGrupoRaizCategoria: categoria já raiz (sem parentId) retorna ela mesma', () => {
  assert.equal(pluggy.acharGrupoRaizCategoria('10000000', CATEGORIAS_AMOSTRA), '10000000');
});

test('acharGrupoRaizCategoria: categoria leaf sobe até a raiz via parentId', () => {
  // Eating out (11010000) -> Food and drinks (11000000, raiz)
  assert.equal(pluggy.acharGrupoRaizCategoria('11010000', CATEGORIAS_AMOSTRA), '11000000');
});

test('acharGrupoRaizCategoria: categoryId desconhecido retorna null', () => {
  assert.equal(pluggy.acharGrupoRaizCategoria('id-que-nao-existe', CATEGORIAS_AMOSTRA), null);
});

test('acharGrupoRaizCategoria: categoryId ausente retorna null', () => {
  assert.equal(pluggy.acharGrupoRaizCategoria(null, CATEGORIAS_AMOSTRA), null);
});

// ── categoriaPrincipalParaGrupoRaiz (função pura) ───────────────────────────────

test('categoriaPrincipalParaGrupoRaiz: Groceries (raiz 10000000) -> Variáveis', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('10000000', CATEGORIAS_AMOSTRA), 'Variáveis');
});

test('categoriaPrincipalParaGrupoRaiz: Eating out (sobe até 11000000, Food and drinks) -> Variáveis', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('11010000', CATEGORIAS_AMOSTRA), 'Variáveis');
});

test('categoriaPrincipalParaGrupoRaiz: Income (01000000) -> Receitas', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('01000000', CATEGORIAS_AMOSTRA), 'Receitas');
});

test('categoriaPrincipalParaGrupoRaiz: Investments (03000000) -> Investimentos', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('03000000', CATEGORIAS_AMOSTRA), 'Investimentos');
});

test('categoriaPrincipalParaGrupoRaiz: Transfers (05000000) -> null (não auto-cria, feature própria do Cronos)', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('05000000', CATEGORIAS_AMOSTRA), null);
});

test('categoriaPrincipalParaGrupoRaiz: categoryId desconhecido -> null (fallback genérico)', () => {
  assert.equal(pluggy.categoriaPrincipalParaGrupoRaiz('id-que-nao-existe', CATEGORIAS_AMOSTRA), null);
});

// ── buscarCategoriasPluggy — via https.request mockado ──────────────────────────

function instalarMockHttps(t, respostas) {
  const requestsFeitos = [];
  let indice = 0;

  t.mock.method(https, 'request', (options, callback) => {
    requestsFeitos.push({ hostname: options.hostname, path: options.path });
    const resposta = respostas[Math.min(indice, respostas.length - 1)];
    indice++;

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = resposta.statusCode ?? 200;
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(resposta.body)));
        res.emit('end');
      });
    };
    return req;
  });

  return requestsFeitos;
}

test('buscarCategoriasPluggy: busca da API e retorna a lista', async (t) => {
  mockRedisSemCache(t);
  const requestsFeitos = instalarMockHttps(t, [{ body: CATEGORIAS_AMOSTRA }]);

  const categorias = await pluggy.buscarCategoriasPluggy('api-key-fake');

  assert.equal(categorias.length, CATEGORIAS_AMOSTRA.length);
  assert.equal(categorias[0].descriptionTranslated, 'Receitas');
  assert.equal(requestsFeitos[0].path, '/categories');
  assert.equal(requestsFeitos[0].hostname, 'api.pluggy.ai');
});

test('buscarCategoriasPluggy: aceita resposta paginada ({results: [...]}) além de array direto', async (t) => {
  mockRedisSemCache(t);
  instalarMockHttps(t, [{ body: { results: CATEGORIAS_AMOSTRA, total: CATEGORIAS_AMOSTRA.length } }]);

  const categorias = await pluggy.buscarCategoriasPluggy('api-key-fake');
  assert.equal(categorias.length, CATEGORIAS_AMOSTRA.length);
});

test('buscarCategoriasPluggy: usa cache quando disponível, não chama a API de novo', async (t) => {
  t.mock.method(redisConnection, 'get', async () => JSON.stringify(CATEGORIAS_AMOSTRA));
  let chamouApi = false;
  t.mock.method(https, 'request', () => { chamouApi = true; throw new Error('não deveria chamar a API com cache disponível'); });

  const categorias = await pluggy.buscarCategoriasPluggy('api-key-fake');

  assert.equal(chamouApi, false);
  assert.equal(categorias.length, CATEGORIAS_AMOSTRA.length);
});

test('buscarCategoriasPluggy: erro da API lança mensagem clara, não quebra com stack técnico', async (t) => {
  mockRedisSemCache(t);
  instalarMockHttps(t, [{ statusCode: 500, body: { message: 'erro interno' } }]);

  await assert.rejects(
    () => pluggy.buscarCategoriasPluggy('api-key-fake'),
    /Não foi possível buscar a lista de categorias/
  );
});
