const https = require('https');

const apiKey = 'BSAXaHJfWhOssWzVMrWDfP2rBQxpkue';
const query = 'pizzarias em São Paulo';

console.log('=== TESTE DA BRAVE SEARCH API ===');
console.log(`Buscando: "${query}"`);
console.log(`API Key: ${apiKey}\n`);

const params = new URLSearchParams({
  q: query,
  count: '5',
  country: 'BR',
  search_lang: 'pt-br',
  ui_lang: 'pt-BR',
});

const options = {
  hostname: 'api.search.brave.com',
  path: `/res/v1/web/search?${params.toString()}`,
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Subscription-Token': apiKey,
  },
};

console.log('Fazendo requisição para:', `https://${options.hostname}${options.path}\n`);

const req = https.request(options, (res) => {
  console.log(`Status Code: ${res.statusCode}`);
  console.log(`Headers:`, JSON.stringify(res.headers, null, 2));
  console.log('');

  const chunks = [];
  let stream = res;

  if (res.headers['content-encoding'] === 'gzip') {
    const zlib = require('zlib');
    stream = res.pipe(zlib.createGunzip());
  }

  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString();
      const data = JSON.parse(body);

      console.log('=== RESPOSTA DA API ===');
      if (data.web && data.web.results) {
        console.log(`✅ Sucesso! Encontrados ${data.web.results.length} resultados:\n`);
        data.web.results.forEach((r, i) => {
          console.log(`${i + 1}. ${r.title}`);
          console.log(`   ${r.description || 'Sem descrição'}`);
          console.log(`   ${r.url}\n`);
        });
      } else {
        console.log('❌ Nenhum resultado encontrado');
        console.log('Resposta completa:', JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.error('❌ Erro ao parsear resposta:', err.message);
      console.log('Body:', Buffer.concat(chunks).toString());
    }
  });
});

req.on('error', (err) => {
  console.error('❌ Erro na requisição:', err.message);
});

req.setTimeout(10000, () => {
  req.destroy();
  console.error('❌ Timeout na requisição (10s)');
});

req.end();
