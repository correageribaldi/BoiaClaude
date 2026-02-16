const https = require('https');

function braveSearch(query, count = 5, opts = {}) {
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
      search_lang: 'pt-br',
      ui_lang: 'pt-BR',
    });

    if (opts.result_filter) {
      params.set('result_filter', opts.result_filter);
    }

    const headers = {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    };

    if (opts.lat != null && opts.lng != null) {
      headers['X-Loc-Lat'] = String(opts.lat);
      headers['X-Loc-Long'] = String(opts.lng);
    }

    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?${params.toString()}`,
      method: 'GET',
      headers,
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

async function pesquisarLocal(query, lat, lng, maxResultados = 5) {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.error('[LOCAL] BRAVE_SEARCH_API_KEY não configurada. Pesquisa desabilitada.');
    return null;
  }

  try {
    const queryLocal = `${query} perto de mim`;
    console.log(`[LOCAL] Buscando: "${queryLocal}" (lat: ${lat}, lng: ${lng})`);

    const data = await braveSearch(queryLocal, maxResultados + 5, {
      lat,
      lng,
      result_filter: 'locations,web',
    });

    const resultados = [];

    // Extrair POIs do bloco locations (quando disponível)
    if (data.locations && data.locations.results) {
      console.log(`[LOCAL] ${data.locations.results.length} locais encontrados via locations.`);
      for (const loc of data.locations.results) {
        resultados.push({
          titulo: loc.title || loc.name,
          descricao: loc.description || '',
          url: loc.url || '',
          endereco: loc.postal_address || loc.address || '',
          telefone: loc.phone || '',
          avaliacao: loc.rating?.ratingValue ? `${loc.rating.ratingValue}/5` : '',
          mapsLink: `https://maps.google.com/?q=${lat},${lng}&query=${encodeURIComponent(loc.title || loc.name)}`,
        });
      }
    }

    // Complementar com resultados web se necessário
    if (resultados.length < maxResultados && data.web && data.web.results) {
      const dominiosProibidos = ['facebook.com/login', 'instagram.com/accounts'];
      for (const r of data.web.results) {
        if (resultados.length >= maxResultados) break;
        const url = r.url.toLowerCase();
        if (dominiosProibidos.some(d => url.includes(d))) continue;
        // Evitar duplicatas
        if (resultados.some(res => res.titulo === r.title)) continue;
        resultados.push({
          titulo: r.title,
          descricao: r.description || r.extra_snippets?.[0] || '',
          url: r.url,
          endereco: '',
          telefone: '',
          avaliacao: '',
          mapsLink: `https://maps.google.com/?q=${encodeURIComponent(r.title)}`,
        });
      }
    }

    console.log(`[LOCAL] ${resultados.length} resultados totais.`);
    return resultados.length > 0 ? resultados.slice(0, maxResultados) : null;
  } catch (err) {
    console.error('[LOCAL] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb, pesquisarLocal };
