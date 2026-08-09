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

// Teto de segurança contra paginação que nunca convirja (formato de cursor
// inesperado, bug da API, etc) — nunca deveria ser atingido em uso normal.
const LIMITE_TRANSACOES_POR_SYNC = 5000;

// buscarTransacoesNovas(apiKey, accountId, desde?) -> Transaction[]
//
// GET /v2/transactions — endpoint atual (não-deprecated); o antigo
// GET /transactions (page-based) está marcado deprecated na doc, disponível
// só até 2026-12-31. Paginação é cursor-based (campo "next" na resposta,
// não page/pageSize). "desde" filtra por data (parâmetro "from") — usado no
// sync incremental para não rebuscar os mesmos 365 dias de histórico a cada
// item/updated.
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
  let proximaUrl = desde ? `${baseUrl}&from=${encodeURIComponent(desde)}` : baseUrl;

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
      proximaUrl = `${baseUrl}${desde ? `&from=${encodeURIComponent(desde)}` : ''}&after=${encodeURIComponent(next)}`;
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

  // Accounts atualizadas (com balance real) — só busca se houver alguma conta
  // bancária mapeada, para não gastar uma chamada de API à toa em Items que só
  // têm cartão. Usado para calibrar saldo_inicial logo abaixo.
  const temContaBancaria = contasMapeadas.some((m) => m.tipo === 'conta');
  const accountsPorId = new Map();
  if (temContaBancaria) {
    for (const account of await buscarAccountsPluggy(apiKey, itemId)) {
      if (account?.id) accountsPorId.set(account.id, account);
    }
  }

  let total = 0;

  for (const mapa of contasMapeadas) {
    const transacoesPluggy = await buscarTransacoesNovas(apiKey, mapa.pluggy_account_id, desde);

    for (const tx of transacoesPluggy) {
      if (!tx?.id) continue;
      const tipo = mapearTipoTransacaoPluggy(tx.type);
      const categoria = await db.resolverCategoriaPluggy(usuarioId, tx.category, tipo);

      await db.upsertTransacaoPluggy(usuarioId, {
        pluggyTransactionId: tx.id,
        tipo,
        valor: Math.abs(Number(tx.amount) || 0),
        descricao: tx.description || 'Transação Pluggy',
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
  mapearTipoTransacaoPluggy,
  mapearStatusTransacaoPluggy,
  interpretarErroItem,
  decidirAcaoWebhook,
  sincronizarItem,
  tratarErroItem,
  processarWebhookEvent,
};
