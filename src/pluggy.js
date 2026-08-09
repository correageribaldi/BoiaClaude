// ─── Cliente Pluggy — Marco 1 (credenciais) + Marco 2 (conexão) ───────────────
//
// Marco 1: autenticação server-side (gerarApiKey), usada para validar a
// credencial que o usuário cola no painel.
// Marco 2: geração de Connect Token para o widget, e orquestração da conexão
// de um Item novo (busca detalhes na Pluggy, cria conta/cartão espelho no
// Cronos com saldo_inicial=0 — sync de transações real é Marco 3).
//
// Segue o mesmo padrão de chamada HTTP já usado no projeto (https nativo,
// sem lib externa) — ver src/pagamento.js:43-66.

const https = require('https');
const db = require('./database');

// Lazy require: ./queue abre conexão TCP real ao Redis assim que importado
// (top-level, dentro do módulo). Se carregássemos isso no topo deste arquivo,
// qualquer require('./pluggy') — inclusive em testes que não usam Redis, como
// os que só testam gerarApiKey — abriria essa conexão e, sem Redis disponível,
// entraria em retry infinito do ioredis e travaria o processo. Só resolve de
// fato quando uma função que precisa de cache (obterApiKey) é chamada.
function obterRedis() {
  return require('./queue').connection;
}

const PLUGGY_API_BASE = 'https://api.pluggy.ai';
const PLUGGY_AUTH_URL = `${PLUGGY_API_BASE}/auth`;

// API Key dura 2h na Pluggy — cacheamos por usuário com margem de segurança
// para nunca usar uma key vencida (evita 401 inesperado no meio de uma
// operação de vários passos como conectarItem).
const API_KEY_CACHE_TTL_SEGUNDOS = 110 * 60;

// Taxonomia de categorias da Pluggy é fixa e global (não muda por usuário/
// client, ~130 entradas) — cache longo e com chave GLOBAL (não por usuário),
// para que o primeiro usuário que sincronizar já beneficie todos os outros.
const CATEGORIAS_CACHE_TTL_SEGUNDOS = 7 * 24 * 60 * 60; // 7 dias
const CATEGORIAS_CACHE_KEY = 'pluggy:categorias';

function httpsRequestJson(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 10000,
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsedBody;
        try { parsedBody = JSON.parse(raw); } catch { parsedBody = null; }
        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout ao chamar API Pluggy')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// gerarApiKey(clientId, clientSecret) -> apiKey (string)
//
// Lança Error com mensagem amigável (segura de expor ao usuário final) em caso
// de credencial inválida ou falha de rede. Nunca loga clientSecret nem o corpo
// da resposta — só status code e mensagens curadas, para não vazar segredo em log.
async function gerarApiKey(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new Error('Client ID e Client Secret são obrigatórios');
  }

  let resposta;
  try {
    resposta = await httpsRequestJson('POST', PLUGGY_AUTH_URL, { clientId, clientSecret });
  } catch (err) {
    console.error('[PLUGGY] Erro de rede ao autenticar:', err.message);
    throw new Error('Não foi possível conectar à Pluggy no momento. Tente novamente em instantes.');
  }

  const { statusCode, body } = resposta;

  if (statusCode === 401) {
    throw new Error('Client ID ou Client Secret inválidos.');
  }
  if (statusCode < 200 || statusCode >= 300 || !body?.apiKey) {
    console.error('[PLUGGY] Resposta inesperada ao autenticar. status:', statusCode);
    throw new Error('Não foi possível validar a credencial Pluggy no momento. Tente novamente em instantes.');
  }

  return body.apiKey;
}

// obterApiKey: mesma gerarApiKey, mas com cache em Redis por usuário (evita
// gerar uma API Key nova — e gastar rate limit da Pluggy — a cada chamada).
// Falha de Redis nunca quebra o fluxo: cache é otimização, não dependência.
async function obterApiKey(clientId, clientSecret, clientUserId) {
  const chaveCache = `pluggy:apikey:${clientUserId}`;
  const redis = obterRedis();

  try {
    const cacheado = await redis.get(chaveCache);
    if (cacheado) return cacheado;
  } catch (err) {
    console.error('[PLUGGY] Redis indisponível para leitura de cache (seguindo sem cache):', err.message);
  }

  const apiKey = await gerarApiKey(clientId, clientSecret);

  try {
    await redis.set(chaveCache, apiKey, 'EX', API_KEY_CACHE_TTL_SEGUNDOS);
  } catch (err) {
    console.error('[PLUGGY] Redis indisponível para gravar cache (seguindo sem cache):', err.message);
  }

  return apiKey;
}

// gerarConnectToken(clientId, clientSecret, clientUserId, webhookUrl?) -> connectToken (string)
//
// clientUserId é o usuario_id do Cronos (resolvido pelo principal) — a Pluggy
// devolve esse valor em todo evento de webhook do Item criado com esse token,
// dando rastreabilidade de qual usuário Cronos é dono de qual Item.
//
// webhookUrl (opcional, Marco 3): registra o webhook já na criação do Item,
// via options.webhookUrl do próprio /connect_token — confirmado em
// docs.pluggy.ai/reference/connect-token-create ("Url to be notified of this
// specific item changes"). Mais simples que uma chamada separada a
// POST /webhooks (também existe, mas exigiria um segundo round-trip e não traz
// vantagem aqui: cada usuário só tem uma URL de webhook, fixa, para todos os
// seus Items). Sem webhookUrl, o Item é criado normalmente mas nunca notifica
// — não há outro jeito de saber quando sincronizar.
async function gerarConnectToken(clientId, clientSecret, clientUserId, webhookUrl = null) {
  const apiKey = await obterApiKey(clientId, clientSecret, clientUserId);

  const options = { clientUserId };
  if (webhookUrl) options.webhookUrl = webhookUrl;

  let resposta;
  try {
    resposta = await httpsRequestJson(
      'POST',
      `${PLUGGY_API_BASE}/connect_token`,
      { options },
      { 'X-API-KEY': apiKey }
    );
  } catch (err) {
    console.error('[PLUGGY] Erro de rede ao gerar Connect Token:', err.message);
    throw new Error('Não foi possível iniciar a conexão com a Pluggy no momento. Tente novamente em instantes.');
  }

  if (resposta.statusCode < 200 || resposta.statusCode >= 300 || !resposta.body?.accessToken) {
    console.error('[PLUGGY] Falha ao gerar Connect Token. status:', resposta.statusCode);
    throw new Error('Não foi possível iniciar a conexão com a Pluggy no momento. Tente novamente em instantes.');
  }

  return resposta.body.accessToken;
}

async function buscarItemPluggy(apiKey, itemId) {
  const resposta = await httpsRequestJson(
    'GET',
    `${PLUGGY_API_BASE}/items/${encodeURIComponent(itemId)}`,
    null,
    { 'X-API-KEY': apiKey }
  );
  if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
    console.error('[PLUGGY] Falha ao buscar item. status:', resposta.statusCode);
    throw new Error('Não foi possível confirmar a conexão com a Pluggy. Tente novamente em instantes.');
  }
  return resposta.body || {};
}

async function buscarAccountsPluggy(apiKey, itemId) {
  const resposta = await httpsRequestJson(
    'GET',
    `${PLUGGY_API_BASE}/accounts?itemId=${encodeURIComponent(itemId)}`,
    null,
    { 'X-API-KEY': apiKey }
  );
  if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
    console.error('[PLUGGY] Falha ao buscar contas do item. status:', resposta.statusCode);
    throw new Error('Não foi possível buscar as contas conectadas. Tente novamente em instantes.');
  }
  // Endpoints de listagem da Pluggy costumam paginar em {results: [...]} —
  // aceita também array direto por segurança, caso o formato real divirja.
  const corpo = resposta.body;
  return Array.isArray(corpo) ? corpo : (corpo?.results || []);
}

// Account.subtype -> tipo aceito pelo CHECK constraint de contas.tipo no Cronos
// (src/database.js — CHECK(tipo IN ('corrente','poupanca','carteira','investimento','outro'))).
// subtype desconhecido cai em 'outro', que é sempre uma opção válida.
function mapearTipoContaCronos(subtype) {
  if (subtype === 'CHECKING_ACCOUNT') return 'corrente';
  if (subtype === 'SAVINGS_ACCOUNT') return 'poupanca';
  return 'outro';
}

function rotuloTipoConta(subtype) {
  if (subtype === 'CHECKING_ACCOUNT') return 'Conta corrente';
  if (subtype === 'SAVINGS_ACCOUNT') return 'Poupança';
  return 'Conta';
}

// Busca a credencial do usuário e resolve a API Key (via cache) num só passo
// — usado por toda função que precisa falar com a API Pluggy em nome de um
// usuário (conectarItem, sincronizarItem, tratarErroItem).
async function buscarApiKeyDoUsuario(usuarioId) {
  const credencial = await db.buscarCredencialPluggy(usuarioId);
  if (!credencial) {
    throw new Error('Nenhuma credencial Pluggy configurada. Configure em Configurações antes de conectar um banco.');
  }
  return obterApiKey(credencial.clientId, credencial.clientSecret, usuarioId);
}

// ─── Webhook a nível de aplicação (client) — registro retroativo ─────────────
//
// Achado em produção (Marco 3.1): Items conectados ANTES do Marco 3 existir
// nunca tiveram webhookUrl passado na criação (isso só entrou no options do
// /connect_token a partir do Marco 3) — ficam UPDATED do lado da Pluggy, mas
// o Cronos nunca é notificado, então nunca sincroniza. Não existe endpoint
// para adicionar/alterar o webhookUrl de um Item já criado (confirmado —
// webhookUrl só é aceito na criação do Item/Connect Token).
//
// Solução: POST /webhooks (Create Webhook) registra uma subscription a nível
// de CLIENT (API Key), não vinculada a nenhum Item específico — confirmado
// na doc ("client-level Webhook configuration", sem campo de filtro por
// clientUserId ou itemId). Como cada usuário Cronos tem seu próprio
// client_id/client_secret (1 aplicação Pluggy por usuário), esse webhook já
// nasce escopado a esse usuário — cobre todos os Items dele, inclusive os
// criados antes deste código existir, dali em diante (webhook nunca reenvia
// eventos passados — o histórico já existente é puxado pelo sync manual).
//
// Nível de confiança: alto mas não validado com uma chamada real ainda —
// baseado em três fontes cruzadas da doc (webhooks-create, webhooks-list,
// texto de docs/webhooks sobre "client-level Webhook configuration").
// Confirmar observando se pluggy_items.ultimo_sync_em do Item retroativo se
// move sozinho no próximo ciclo de auto-sync da Pluggy.

async function listarWebhooksPluggy(apiKey) {
  const resposta = await httpsRequestJson('GET', `${PLUGGY_API_BASE}/webhooks`, null, { 'X-API-KEY': apiKey });
  if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
    console.error('[PLUGGY] Falha ao listar webhooks. status:', resposta.statusCode);
    throw new Error('Não foi possível consultar os webhooks já registrados na Pluggy.');
  }
  const body = resposta.body;
  return Array.isArray(body) ? body : (body?.results || []);
}

async function criarWebhookPluggy(apiKey, url, event = 'all') {
  const resposta = await httpsRequestJson('POST', `${PLUGGY_API_BASE}/webhooks`, { url, event }, { 'X-API-KEY': apiKey });
  if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
    console.error('[PLUGGY] Falha ao criar webhook client-level. status:', resposta.statusCode);
    throw new Error('Não foi possível registrar o webhook na Pluggy.');
  }
  return resposta.body;
}

// Função pura: um webhook conta como "já registrado" se existe um com a
// mesma URL e não desabilitado. Extraída para ser testável sem I/O — mesma
// razão de interpretarErroItem/decidirAcaoWebhook (Marco 3).
function webhookJaRegistrado(webhooksExistentes, url) {
  return webhooksExistentes.some((w) => w.url === url && !w.disabledAt);
}

// garantirWebhookRegistrado: garante que existe (cria se faltar) um webhook
// client-level apontando para a URL do usuário. Idempotente — lista antes de
// criar, para não duplicar (múltiplos webhooks para o mesmo evento geram
// múltiplas notificações do mesmo evento, confirmado na doc). Gera o
// webhook_token mesmo que o registro na Pluggy falhe adiante — o token
// precisa existir de qualquer forma para (a) o endpoint /webhook/pluggy/:token
// validar quando algo chamar, e (b) a URL fazer sentido se o usuário preferir
// colar manualmente no dashboard da Pluggy dele (fallback quando o registro
// automático não for possível/desejado).
async function garantirWebhookRegistrado(usuarioId) {
  const webhookToken = await db.obterOuCriarWebhookTokenPluggy(usuarioId);

  const baseUrl = process.env.PAINEL_BASE_URL;
  if (!baseUrl) {
    throw new Error('PAINEL_BASE_URL não configurada — não é possível montar a URL do webhook.');
  }
  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhook/pluggy/${webhookToken}`;

  const apiKey = await buscarApiKeyDoUsuario(usuarioId);
  const existentes = await listarWebhooksPluggy(apiKey);
  const jaRegistrado = webhookJaRegistrado(existentes, webhookUrl);

  if (!jaRegistrado) {
    await criarWebhookPluggy(apiKey, webhookUrl, 'all');
  }

  return { webhookUrl, jaRegistrado };
}

// conectarItem: orquestra a criação de um Item novo a partir do itemId que o
// widget devolveu no onSuccess (client-side). Busca os detalhes reais na
// Pluggy (nunca confia em dado vindo só do frontend além do itemId), cria uma
// conta/cartão espelho por Account/CreditCard retornada, com saldo_inicial=0
// (sync de transações real acontece via webhook — ver sincronizarItem).
async function conectarItem(usuarioId, itemId) {
  if (!itemId) throw new Error('itemId é obrigatório');

  const apiKey = await buscarApiKeyDoUsuario(usuarioId);

  const item = await buscarItemPluggy(apiKey, itemId);
  const connectorNome = item?.connector?.name || 'Banco conectado';
  const status = item?.status || 'UPDATING';

  const pluggyItemDbId = await db.salvarPluggyItem(usuarioId, itemId, connectorNome, status);

  const accounts = await buscarAccountsPluggy(apiKey, itemId);

  const criadas = [];
  for (const account of accounts) {
    if (!account?.id) continue;

    if (account.type === 'CREDIT') {
      const nomeSugerido = `${connectorNome} • Cartão`;
      // Bug de produção corrigido: limite_total nunca era populado na criação
      // (ficava NULL) — creditLimit vem em creditData, direto da API.
      const limiteTotal = typeof account.creditData?.creditLimit === 'number'
        ? account.creditData.creditLimit : null;
      const cartao = await db.criarCartaoPluggy(usuarioId, pluggyItemDbId, account.id, nomeSugerido, limiteTotal);
      criadas.push({ tipo: 'cartao', ...cartao });
    } else {
      const nomeSugerido = `${connectorNome} • ${rotuloTipoConta(account.subtype)}`;
      const conta = await db.criarContaPluggy(
        usuarioId, pluggyItemDbId, account.id, nomeSugerido, mapearTipoContaCronos(account.subtype)
      );
      criadas.push({ tipo: 'conta', ...conta });
    }
  }

  return { connectorNome, status, itemId, contasCriadas: criadas };
}

// ─── Tradução de categoria (achado de produção: 100% das transações caíam em
// "Outros" porque tx.category vem em inglês, ex. "Groceries", e
// resolverCategoriaPluggy tentava fuzzy-match direto contra as categorias em
// português do usuário — nunca batia) ───────────────────────────────────────
//
// GET /categories devolve a taxonomia oficial já com a tradução pronta
// (descriptionTranslated), sem precisar manter um dicionário manual. Buscada
// 1x por sync (não por transação) e cacheada globalmente (ver
// CATEGORIAS_CACHE_KEY acima).

// Achado ao testar esta função: a conexão Redis do projeto (src/queue.js) usa
// maxRetriesPerRequest: null — exigência do BullMQ para não perder job, mas
// tem o efeito colateral de nenhuma operação (get/set) rejeitar sozinha
// quando o Redis está inacessível: fica tentando pra sempre em vez de dar
// erro. Reproduzido no teste (Promise nunca resolvia sem Redis local).
// redisComTimeout desiste depois de REDIS_TIMEOUT_MS e cai no catch — sem
// isso, o comentário "Falha de Redis nunca quebra o fluxo" já em obterApiKey
// (mesmo padrão, código do Marco 2/3) seria falso na prática se o Redis de
// produção cair: travaria indefinidamente em vez de degradar sem cache. Não
// mexi em obterApiKey aqui (fora do escopo desta tarefa, código já em
// produção) — reportado como achado de robustez separado.
const REDIS_TIMEOUT_MS = 1500;
function redisComTimeout(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ao acessar Redis')), REDIS_TIMEOUT_MS)),
  ]);
}

async function buscarCategoriasPluggy(apiKey) {
  const redis = obterRedis();

  try {
    const cacheado = await redisComTimeout(redis.get(CATEGORIAS_CACHE_KEY));
    if (cacheado) return JSON.parse(cacheado);
  } catch (err) {
    console.error('[PLUGGY] Redis indisponível para leitura de cache de categorias (seguindo sem cache):', err.message);
  }

  const resposta = await httpsRequestJson('GET', `${PLUGGY_API_BASE}/categories`, null, { 'X-API-KEY': apiKey });
  if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
    console.error('[PLUGGY] Falha ao buscar categorias. status:', resposta.statusCode);
    throw new Error('Não foi possível buscar a lista de categorias da Pluggy.');
  }
  const body = resposta.body;
  const categorias = Array.isArray(body) ? body : (body?.results || []);

  try {
    await redisComTimeout(redis.set(CATEGORIAS_CACHE_KEY, JSON.stringify(categorias), 'EX', CATEGORIAS_CACHE_TTL_SEGUNDOS));
  } catch (err) {
    console.error('[PLUGGY] Redis indisponível para gravar cache de categorias (seguindo sem cache):', err.message);
  }

  return categorias;
}

// Função pura: traduz category/categoryId (inglês, vindos da Transaction)
// para o texto oficial em português (descriptionTranslated), usando a lista
// já carregada por buscarCategoriasPluggy. Prefere casar por categoryId (mais
// confiável que string — descriptions podem ter variações de grafia); cai
// para busca por description (inglês) se o id não vier. categoryId
// desconhecido (categoria nova que a Pluggy adicionou depois da última
// atualização do cache) ou lista vazia retornam null — quem chama decide o
// fallback (ver sincronizarItem: cai para tx.category bruto, que por sua vez
// cai no genérico de resolverCategoriaPluggy se não bater em nada).
function traduzirCategoriaPluggy(categoryId, categoryDescription, categoriasPluggy) {
  if (!Array.isArray(categoriasPluggy) || categoriasPluggy.length === 0) return null;

  if (categoryId) {
    const porId = categoriasPluggy.find((c) => c.id === categoryId);
    if (porId?.descriptionTranslated) return porId.descriptionTranslated;
  }
  if (categoryDescription) {
    const porDescricao = categoriasPluggy.find((c) => c.description === categoryDescription);
    if (porDescricao?.descriptionTranslated) return porDescricao.descriptionTranslated;
  }
  return null;
}

// Sobe a cadeia de parentId até achar a raiz (categoria sem parentId) —
// usado para decidir a categoria principal Cronos de destino ao auto-criar
// subcategoria a partir de uma transação Pluggy. Função pura, testável sem I/O.
// Proteção contra ciclo (não deveria existir na taxonomia real, mas defensivo
// contra dado inesperado): para se revisitar um id já visto.
function acharGrupoRaizCategoria(categoryId, categoriasPluggy) {
  if (!categoryId || !Array.isArray(categoriasPluggy)) return null;

  let atual = categoriasPluggy.find((c) => c.id === categoryId);
  if (!atual) return null;

  const visitados = new Set();
  while (atual.parentId && !visitados.has(atual.id)) {
    visitados.add(atual.id);
    const pai = categoriasPluggy.find((c) => c.id === atual.parentId);
    if (!pai) break;
    atual = pai;
  }
  return atual.id;
}

// Mapeamento grupo raiz Pluggy -> categoria principal Cronos (nomes exatos de
// CATEGORIAS_PRINCIPAIS_PADRAO/CATEGORIA_PRINCIPAL_RECEITA em src/database.js).
// null = não auto-criar subcategoria, cai no fallback genérico existente.
// "Same person transfer" (04) e "Transfers" (05): o Cronos já tem conceito
// próprio de transferência (tabela transferencias, feature separada) — não
// misturar transferência bancária real com "categoria de gasto".
const GRUPO_RAIZ_PARA_CATEGORIA_PRINCIPAL = {
  '01000000': 'Receitas',          // Income
  '02000000': 'Despesas Fixas',    // Loans and financing
  '03000000': 'Investimentos',     // Investments
  '04000000': null,                // Same person transfer
  '05000000': null,                // Transfers
  '06000000': 'Despesas Fixas',    // Legal obligations
  '07000000': 'Despesas Fixas',    // Services
  '08000000': 'Variáveis',         // Shopping
  '09000000': 'Lazer',             // Digital services
  '10000000': 'Variáveis',         // Groceries
  '11000000': 'Variáveis',         // Food and drinks
  '12000000': 'Lazer',             // Travel
  '13000000': 'Variáveis',         // Donations
  '14000000': 'Lazer',             // Gambling
  '15000000': 'Despesas Fixas',    // Taxes
  '16000000': 'Despesas Fixas',    // Bank fees
  '17000000': 'Despesas Fixas',    // Housing
  '18000000': 'Variáveis',         // Healthcare
  '19000000': 'Variáveis',         // Transportation
  '20000000': 'Despesas Fixas',    // Insurance
  '21000000': 'Lazer',             // Leisure
  '99999999': null,                // Other — fallback genérico, como hoje
};

// categoryId de uma transação -> nome da categoria principal Cronos de
// destino (ou null se não deve auto-criar subcategoria). Função pura.
function categoriaPrincipalParaGrupoRaiz(categoryId, categoriasPluggy) {
  const raizId = acharGrupoRaizCategoria(categoryId, categoriasPluggy);
  if (!raizId) return null;
  return GRUPO_RAIZ_PARA_CATEGORIA_PRINCIPAL[raizId] ?? null;
}

// Teto de segurança contra paginação que nunca convirja (formato de cursor
// inesperado, bug da API, etc) — nunca deveria ser atingido em uso normal.
const LIMITE_TRANSACOES_POR_SYNC = 5000;

// buscarTransacoesNovas(apiKey, accountId, desde?) -> Transaction[]
//
// GET /v2/transactions — endpoint atual (não-deprecated); o antigo
// GET /transactions (page-based) está marcado deprecated na doc, disponível
// só até 2026-12-31. Paginação é cursor-based (campo "next" na resposta,
// não page/pageSize). "desde" filtra por data (parâmetro "createdAtFrom" —
// NÃO "from", que a API rejeita com 400 "property from should not exist",
// bug de produção reproduzido e corrigido) — usado no sync incremental para
// não rebuscar os mesmos 365 dias de histórico a cada item/updated.
//
// Formato do cursor "next" confirmado com chamada real (produção, credencial
// do Federico, conta com histórico grande o bastante para paginar): vem como
// path relativo completo — "?accountId=X&after=BASE64" — começando com "?",
// não uma URL absoluta nem um token isolado. Monta-se direto contra
// PLUGGY_API_BASE + "/v2/transactions", sem recolar accountId/from (o "next"
// já é a query string inteira e correta devolvida pela própria Pluggy).
async function buscarTransacoesNovas(apiKey, accountId, desde = null) {
  const transacoes = [];
  const baseUrl = `${PLUGGY_API_BASE}/v2/transactions?accountId=${encodeURIComponent(accountId)}`;
  let proximaUrl = desde ? `${baseUrl}&createdAtFrom=${encodeURIComponent(desde)}` : baseUrl;

  while (proximaUrl && transacoes.length < LIMITE_TRANSACOES_POR_SYNC) {
    const resposta = await httpsRequestJson('GET', proximaUrl, null, { 'X-API-KEY': apiKey });
    if (resposta.statusCode < 200 || resposta.statusCode >= 300) {
      console.error('[PLUGGY] Falha ao buscar transações. status:', resposta.statusCode);
      throw new Error('Não foi possível buscar as transações. Tente novamente em instantes.');
    }

    const body = resposta.body;
    const results = Array.isArray(body) ? body : (body?.results || []);
    transacoes.push(...results);

    const next = body?.next || null;
    if (!next) {
      proximaUrl = null;
    } else if (String(next).startsWith('http')) {
      proximaUrl = next;
    } else if (String(next).startsWith('?')) {
      // Formato real confirmado — path relativo já pronto, junta direto na
      // origin (nunca recolar em cima de baseUrl, que duplicaria accountId/
      // from e faria o "after" virar valor de outro "after", corrompido).
      proximaUrl = `${PLUGGY_API_BASE}/v2/transactions${next}`;
    } else {
      // Fallback defensivo — token bare, formato nunca observado em produção
      // até agora. Mantido caso a Pluggy mude de novo.
      proximaUrl = `${baseUrl}${desde ? `&createdAtFrom=${encodeURIComponent(desde)}` : ''}&after=${encodeURIComponent(next)}`;
    }
  }

  return transacoes;
}

// Transaction.type -> tipo do Cronos. Função pura, testável sem I/O.
function mapearTipoTransacaoPluggy(type) {
  return type === 'CREDIT' ? 'receita' : 'despesa';
}

// Transaction.status -> status do Cronos. PENDING = fatura aberta/parcela
// futura, POSTED (ou qualquer outro valor) = já liquidada — assume 'pago'
// como fallback seguro por ser histórico bancário real, já aconteceu.
function mapearStatusTransacaoPluggy(status) {
  return status === 'PENDING' ? 'pendente' : 'pago';
}

// sincronizarItem: busca transações novas de todas as contas/cartões
// mapeados de um Item e grava em transacoes (dedup + categoria resolvida).
// Chamado a partir de item/created (primeiro sync, até 365 dias de histórico)
// e item/updated (sync incremental, usa ultimo_sync_em como "desde").
async function sincronizarItem(usuarioId, itemId) {
  const apiKey = await buscarApiKeyDoUsuario(usuarioId);

  const item = await buscarItemPluggy(apiKey, itemId);
  await db.atualizarStatusPluggyItem(itemId, item?.status || 'UPDATED', null);

  const mapaItem = await db.buscarPluggyItemPorItemId(itemId);
  if (!mapaItem) {
    // Webhook chegou antes do callback do widget persistir o Item (corrida
    // rara) — não há pluggy_contas_map ainda para sincronizar. Auto-corrige
    // no próximo item/updated (a Pluggy reenvia periodicamente).
    return { transacoesSincronizadas: 0 };
  }

  const desde = mapaItem.ultimo_sync_em
    ? new Date(mapaItem.ultimo_sync_em).toISOString().slice(0, 10)
    : null;

  const contasMapeadas = await db.listarContasMapPorItem(mapaItem.id);

  // Accounts atualizadas (balance, e para cartão também creditData) — só
  // busca se houver alguma conta/cartão mapeado (sempre verdade se chegou
  // até aqui, mas evita uma chamada à toa em teoria). Usado para calibrar
  // saldo_inicial (conta bancária) e limite/usado/disponível (cartão) abaixo.
  const accountsPorId = new Map();
  // Categorias oficiais da Pluggy (para traduzir tx.category/categoryId antes
  // do fuzzy-match) — buscada 1x por sync, não por transação (evita centenas/
  // milhares de chamadas de API desnecessárias; ver buscarCategoriasPluggy
  // para o cache global de mais alto nível, entre syncs).
  let categoriasPluggy = [];
  if (contasMapeadas.length > 0) {
    for (const account of await buscarAccountsPluggy(apiKey, itemId)) {
      if (account?.id) accountsPorId.set(account.id, account);
    }
    try {
      categoriasPluggy = await buscarCategoriasPluggy(apiKey);
    } catch (err) {
      console.error('[PLUGGY] Falha ao buscar categorias da Pluggy (seguindo sem tradução):', err.message);
    }
  }

  let total = 0;

  for (const mapa of contasMapeadas) {
    const transacoesPluggy = await buscarTransacoesNovas(apiKey, mapa.pluggy_account_id, desde);

    for (const tx of transacoesPluggy) {
      if (!tx?.id) continue;
      const tipo = mapearTipoTransacaoPluggy(tx.type);
      // Uma variável só para a descrição: é a mesma string que vai ser GRAVADA
      // e a que alimenta a chave de estabelecimento do aprendizado. Se as duas
      // divergissem, o usuário corrigiria um lançamento e o aprendizado nunca
      // bateria com os próximos (falha silenciosa).
      const descricao = tx.description || 'Transação Pluggy';
      // Traduz para português oficial antes do fuzzy-match; sem tradução
      // disponível (categoryId novo/desconhecido, ou categoria ausente — exige
      // plano Pro), cai no texto bruto, que por sua vez cai no fallback
      // genérico dentro de resolverCategoriaPluggy se não bater em nada.
      const categoriaTraduzida = traduzirCategoriaPluggy(tx.categoryId, tx.category, categoriasPluggy) || tx.category;
      // Categoria principal Cronos de destino, para auto-criar subcategoria
      // se não houver match com o que o usuário já tem — null para
      // transferências (grupos 04/05, feature própria do Cronos) ou
      // categoryId desconhecido, cai no fallback genérico de sempre.
      const categoriaPrincipalDestino = categoriaPrincipalParaGrupoRaiz(tx.categoryId, categoriasPluggy);
      // descricao no fim: aprendizado do usuário para aquele estabelecimento
      // tem prioridade sobre a categoria que a Pluggy sugere.
      const categoria = await db.resolverCategoriaPluggy(usuarioId, categoriaTraduzida, tipo, categoriaPrincipalDestino, descricao);

      await db.upsertTransacaoPluggy(usuarioId, {
        pluggyTransactionId: tx.id,
        tipo,
        valor: Math.abs(Number(tx.amount) || 0),
        descricao,
        categoria,
        data: String(tx.date || '').slice(0, 10),
        status: mapearStatusTransacaoPluggy(tx.status),
        contaId: mapa.tipo === 'conta' ? mapa.cronos_conta_id : null,
        cartaoId: mapa.tipo === 'cartao' ? mapa.cronos_cartao_id : null,
      });
      total++;
    }

    // Calibra saldo_inicial só de conta bancária (BANK) — cartão fica de fora,
    // saldo de cartão é semântica diferente (fatura/ciclo), item já adiado.
    // Recalcula do zero a cada sync (idempotente, sempre converge para o
    // balance real da Pluggy) — não é um ajuste incremental que acumularia erro.
    if (mapa.tipo === 'conta') {
      const account = accountsPorId.get(mapa.pluggy_account_id);
      if (account && typeof account.balance === 'number') {
        try {
          await db.calibrarSaldoInicialConta(usuarioId, mapa.cronos_conta_id, account.balance);
        } catch (err) {
          console.error('[PLUGGY] Falha ao calibrar saldo_inicial da conta:', err.message);
        }
      }
    } else if (mapa.tipo === 'cartao') {
      // Números REAIS da API (balance = usado, creditData.creditLimit/
      // availableCreditLimit) — nunca calculados a partir de transacoes
      // (calcularUsoCartao é para cartão manual, sem relação com o ciclo de
      // fatura real da Pluggy). Idempotente, mesma lógica de calibração acima.
      const account = accountsPorId.get(mapa.pluggy_account_id);
      if (account) {
        const limiteTotal = typeof account.creditData?.creditLimit === 'number'
          ? account.creditData.creditLimit : null;
        const valorUsado = typeof account.balance === 'number' ? account.balance : null;
        const disponivel = typeof account.creditData?.availableCreditLimit === 'number'
          ? account.creditData.availableCreditLimit : null;
        try {
          await db.atualizarCartaoPluggyDados(usuarioId, mapa.cronos_cartao_id, { limiteTotal, valorUsado, disponivel });
        } catch (err) {
          console.error('[PLUGGY] Falha ao atualizar dados do cartão:', err.message);
        }
      }
    }
  }

  await db.marcarPluggyItemSincronizado(mapaItem.id);
  return { transacoesSincronizadas: total };
}

// interpretarErroItem: decide status + mensagem amigável a partir do Item
// retornado pela Pluggy num evento item/error. Função pura (sem I/O) —
// extraída de tratarErroItem justamente para ser testável sem mockar rede.
function interpretarErroItem(item) {
  if (item?.executionStatus === 'INVALID_CREDENTIALS' || item?.status === 'LOGIN_ERROR') {
    return {
      status: item?.status || 'LOGIN_ERROR',
      mensagem: 'Credencial do banco expirada ou inválida. Reconecte em Configurações.',
    };
  }
  if (item?.status === 'WAITING_USER_INPUT' || item?.status === 'WAITING_USER_ACTION') {
    return {
      status: item.status,
      mensagem: 'Confirmação pendente (autenticação de dois fatores). Reconecte para concluir.',
    };
  }
  return {
    status: item?.status || 'ERROR',
    mensagem: 'Erro na conexão com o banco. Tente reconectar em Configurações.',
  };
}

// tratarErroItem: item/error — busca o Item para saber o motivo exato
// (credencial inválida vs MFA pendente vs outro) e grava uma mensagem
// amigável em pluggy_items.erro_mensagem para a UI exibir. Se a busca falhar
// (rede fora, credencial já removida), ainda assim grava um status/mensagem
// genéricos — silêncio total seria pior que uma mensagem menos específica.
async function tratarErroItem(usuarioId, itemId) {
  let resultado = interpretarErroItem(null);

  try {
    const apiKey = await buscarApiKeyDoUsuario(usuarioId);
    const item = await buscarItemPluggy(apiKey, itemId);
    resultado = interpretarErroItem(item);
  } catch (err) {
    console.error('[PLUGGY] Erro ao detalhar item/error:', err.message);
  }

  await db.atualizarStatusPluggyItem(itemId, resultado.status, resultado.mensagem);
}

// decidirAcaoWebhook: mapeia o "event" do payload para a ação a tomar. Função
// pura — separada de processarWebhookEvent para ser testável sem I/O.
function decidirAcaoWebhook(event) {
  if (event === 'item/created' || event === 'item/updated') return 'sincronizar';
  if (event === 'item/error') return 'erro';
  if (event === 'transactions/deleted') return 'deletar';
  return 'ignorar';
}

// processarWebhookEvent: roteamento dos eventos tratados neste marco. Eventos
// não listados (waiting_user_input, connector/status_updated, payment_*) caem
// em 'ignorar' — o endpoint HTTP já respondeu 2XX antes de nos chamar, então
// não processá-los não gera retry desnecessário da Pluggy.
async function processarWebhookEvent(usuarioId, payload) {
  const { event, itemId } = payload || {};
  if (!itemId) return;

  const acao = decidirAcaoWebhook(event);

  if (acao === 'sincronizar') {
    await sincronizarItem(usuarioId, itemId);
  } else if (acao === 'erro') {
    await tratarErroItem(usuarioId, itemId);
  } else if (acao === 'deletar') {
    const ids = Array.isArray(payload?.transactionIds) ? payload.transactionIds : [];
    await db.removerTransacoesPluggyPorIds(ids);
  }
}

module.exports = {
  gerarApiKey,
  gerarConnectToken,
  garantirWebhookRegistrado,
  webhookJaRegistrado,
  conectarItem,
  buscarTransacoesNovas,
  buscarCategoriasPluggy,
  traduzirCategoriaPluggy,
  acharGrupoRaizCategoria,
  categoriaPrincipalParaGrupoRaiz,
  mapearTipoTransacaoPluggy,
  mapearStatusTransacaoPluggy,
  interpretarErroItem,
  decidirAcaoWebhook,
  sincronizarItem,
  tratarErroItem,
  processarWebhookEvent,
};
