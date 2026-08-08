// ─── Cliente Pluggy — Marco 1 (validação de credenciais) ──────────────────────
//
// Escopo deste marco: só a chamada de autenticação server-side (POST /auth),
// usada para validar a credencial que o usuário cola no painel antes de
// gravá-la. Conexão bancária real (Connect Token, Item, Transaction, Webhooks)
// é Marco 2+ — ver spec técnica registrada em
// .claude/memory/checkpoint_2026-08-08_pluggy-spec.md.
//
// Segue o mesmo padrão de chamada HTTP já usado no projeto (https nativo,
// sem lib externa) — ver src/pagamento.js:43-66.

const https = require('https');

const PLUGGY_AUTH_URL = 'https://api.pluggy.ai/auth';

function httpsPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
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
    req.write(data);
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
    resposta = await httpsPostJson(PLUGGY_AUTH_URL, { clientId, clientSecret });
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

module.exports = { gerarApiKey };
