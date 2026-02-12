const https = require('https');

function braveSearch(query, count = 5) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      reject(new Error('BRAVE_SEARCH_API_KEY não configurada'));
      return;
    }

    const params = new URLSearchParams({
      q: query,
      count: String(count),
      country: 'BR',
      search_lang: 'pt',
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

    const req = https.request(options, (res) => {
      const chunks = [];

      // Handle gzip
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
          resolve(data);
        } catch (err) {
          reject(new Error(`Erro ao parsear resposta: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout na busca'));
    });
    req.end();
  });
}

async function pesquisarWeb(query, maxResultados = 5) {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.error('[SEARCH] BRAVE_SEARCH_API_KEY não configurada. Pesquisa desabilitada.');
    return null;
  }

  try {
    console.log(`[SEARCH] Buscando: "${query}"`);
    const data = await braveSearch(query, maxResultados);

    if (!data || !data.web || !data.web.results || data.web.results.length === 0) {
      console.log('[SEARCH] Nenhum resultado encontrado.');
      return null;
    }

    const resultados = data.web.results.slice(0, maxResultados).map(r => ({
      titulo: r.title,
      descricao: r.description || r.meta_url?.hostname || '',
      url: r.url,
    }));

    console.log(`[SEARCH] ${resultados.length} resultados encontrados.`);
    return resultados;
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb };
