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
    const data = await braveSearch(query, maxResultados + 3); // Buscar alguns extras para filtrar

    if (!data || !data.web || !data.web.results || data.web.results.length === 0) {
      console.log('[SEARCH] Nenhum resultado encontrado pela API.');
      return null;
    }

    console.log(`[SEARCH] API retornou ${data.web.results.length} resultados brutos.`);

    // Filtrar apenas os piores domínios (mais permissivo agora)
    const dominiosProibidos = ['facebook.com/login', 'instagram.com/accounts'];
    const resultadosFiltrados = data.web.results
      .filter(r => {
        const url = r.url.toLowerCase();
        // Remove apenas páginas de login/cadastro
        if (dominiosProibidos.some(d => url.includes(d))) return false;
        // Permite resultados mesmo sem descrição
        return true;
      })
      .slice(0, maxResultados)
      .map(r => ({
        titulo: r.title,
        descricao: r.description || r.extra_snippets?.[0] || 'Sem descrição disponível',
        url: r.url,
      }));

    console.log(`[SEARCH] ${resultadosFiltrados.length} resultados após filtro.`);
    return resultadosFiltrados.length > 0 ? resultadosFiltrados : null;
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb };
