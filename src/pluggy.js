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

// gerarConnectToken(clientId, clientSecret, clientUserId) -> connectToken (string)
//
// clientUserId é o usuario_id do Cronos (resolvido pelo principal) — a Pluggy
// devolve esse valor em todo evento de webhook do Item criado com esse token,
// dando rastreabilidade de qual usuário Cronos é dono de qual Item.
async function gerarConnectToken(clientId, clientSecret, clientUserId) {
  const apiKey = await obterApiKey(clientId, clientSecret, clientUserId);

  let resposta;
  try {
    resposta = await httpsRequestJson(
      'POST',
      `${PLUGGY_API_BASE}/connect_token`,
      { options: { clientUserId } },
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

// conectarItem: orquestra a criação de um Item novo a partir do itemId que o
// widget devolveu no onSuccess (client-side). Busca os detalhes reais na
// Pluggy (nunca confia em dado vindo só do frontend além do itemId), cria uma
// conta/cartão espelho por Account/CreditCard retornada, com saldo_inicial=0
// (sync de transações — e portanto saldo real — é Marco 3).
async function conectarItem(usuarioId, itemId) {
  if (!itemId) throw new Error('itemId é obrigatório');

  const credencial = await db.buscarCredencialPluggy(usuarioId);
  if (!credencial) {
    throw new Error('Nenhuma credencial Pluggy configurada. Configure em Configurações antes de conectar um banco.');
  }

  const apiKey = await obterApiKey(credencial.clientId, credencial.clientSecret, usuarioId);

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
      const cartao = await db.criarCartaoPluggy(usuarioId, pluggyItemDbId, account.id, nomeSugerido);
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

module.exports = {
  gerarApiKey,
  gerarConnectToken,
  conectarItem,
};
