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
    // Melhorar query para locais: adicionar termos que trazem resultados mais úteis
    const queryMelhorada = query + ' endereço telefone';
    console.log(`[SEARCH] Buscando: "${queryMelhorada}"`);
    const data = await braveSearch(queryMelhorada, maxResultados * 2); // Buscar mais para filtrar

    if (!data || !data.web || !data.web.results || data.web.results.length === 0) {
      console.log('[SEARCH] Nenhum resultado encontrado.');
      return null;
    }

    // Filtrar resultados ruins (sites genéricos, agregadores, etc.)
    const dominiosRuins = ['wikipedia.org', 'facebook.com', 'instagram.com', 'youtube.com', 'twitter.com'];
    const resultadosFiltrados = data.web.results
      .filter(r => {
        const url = r.url.toLowerCase();
        // Remove resultados de domínios ruins
        if (dominiosRuins.some(d => url.includes(d))) return false;
        // Remove resultados sem descrição útil
        if (!r.description || r.description.length < 20) return false;
        return true;
      })
      .slice(0, maxResultados)
      .map(r => ({
        titulo: r.title,
        descricao: r.description || r.meta_url?.hostname || '',
        url: r.url,
      }));

    console.log(`[SEARCH] ${resultadosFiltrados.length} resultados filtrados encontrados.`);
    return resultadosFiltrados.length > 0 ? resultadosFiltrados : null;
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb };
