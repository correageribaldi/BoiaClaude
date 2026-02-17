const https = require('https');

function braveSearch(query, count = 5, opts = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      reject(new Error('BRAVE_SEARCH_API_KEY nao configurada'));
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

function googlePlacesRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'maps.googleapis.com',
      path,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString();
          const data = JSON.parse(body);
          resolve(data);
        } catch (err) {
          reject(new Error(`Erro ao parsear resposta Google Places: ${err.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout na busca Google Places'));
    });
    req.end();
  });
}

function formatarAvaliacaoGoogle(rating, total) {
  if (!rating) return '';
  if (!total) return `${rating}/5`;
  return `${rating}/5 (${total} avaliacoes)`;
}

function extrairAvaliacoesRecentes(reviews, max = 3) {
  if (!Array.isArray(reviews) || reviews.length === 0) return [];

  const ordenadas = [...reviews]
    .filter((r) => r && r.text)
    .sort((a, b) => (b.time || 0) - (a.time || 0))
    .slice(0, max);

  return ordenadas.map((r) => ({
    autor: r.author_name || 'Cliente',
    nota: r.rating || null,
    texto: r.text || '',
    tempoRelativo: r.relative_time_description || '',
  }));
}

async function buscarDetalhesGooglePlace(placeId, apiKey) {
  if (!placeId) return null;

  const params = new URLSearchParams({
    place_id: placeId,
    language: 'pt-BR',
    reviews_sort: 'newest',
    fields: 'place_id,name,formatted_address,formatted_phone_number,rating,user_ratings_total,reviews,url,geometry',
    key: apiKey,
  });

  const path = `/maps/api/place/details/json?${params.toString()}`;
  const data = await googlePlacesRequest(path);

  if (!data || data.status !== 'OK' || !data.result) {
    return null;
  }

  return data.result;
}

async function pesquisarWeb(query, maxResultados = 5) {
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.error('[SEARCH] BRAVE_SEARCH_API_KEY nao configurada. Pesquisa desabilitada.');
    return null;
  }

  try {
    console.log(`[SEARCH] Buscando: "${query}"`);
    const data = await braveSearch(query, maxResultados + 3);

    if (!data || !data.web || !data.web.results || data.web.results.length === 0) {
      console.log('[SEARCH] Nenhum resultado encontrado pela API.');
      return null;
    }

    console.log(`[SEARCH] API retornou ${data.web.results.length} resultados brutos.`);

    const dominiosProibidos = ['facebook.com/login', 'instagram.com/accounts'];
    const resultadosFiltrados = data.web.results
      .filter((r) => {
        const url = r.url.toLowerCase();
        if (dominiosProibidos.some((d) => url.includes(d))) return false;
        return true;
      })
      .slice(0, maxResultados)
      .map((r) => ({
        titulo: r.title,
        descricao: r.description || r.extra_snippets?.[0] || 'Sem descricao disponivel',
        url: r.url,
      }));

    console.log(`[SEARCH] ${resultadosFiltrados.length} resultados apos filtro.`);
    return resultadosFiltrados.length > 0 ? resultadosFiltrados : null;
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

async function pesquisarLocal(query, lat, lng, maxResultados = 5) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    console.error('[LOCAL] GOOGLE_MAPS_API_KEY nao configurada. Busca local desabilitada.');
    return null;
  }

  try {
    const params = new URLSearchParams({
      query,
      location: `${lat},${lng}`,
      radius: '8000',
      language: 'pt-BR',
      region: 'br',
      key: apiKey,
    });

    console.log(`[LOCAL] Google Places Text Search: "${query}" (lat: ${lat}, lng: ${lng})`);

    const path = `/maps/api/place/textsearch/json?${params.toString()}`;
    const data = await googlePlacesRequest(path);

    if (!data || (data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) {
      console.error(`[LOCAL] Google Places retornou status invalido: ${data?.status || 'desconhecido'}`);
      return null;
    }

    if (!Array.isArray(data.results) || data.results.length === 0) {
      return null;
    }

    const base = data.results.slice(0, maxResultados);

    const resultados = await Promise.all(base.map(async (place) => {
      const placeId = place.place_id || null;
      const details = placeId ? await buscarDetalhesGooglePlace(placeId, apiKey) : null;

      const nome = details?.name || place.name || '';
      const endereco = details?.formatted_address || place.formatted_address || place.vicinity || '';
      const telefone = details?.formatted_phone_number || '';
      const rating = details?.rating || place.rating || null;
      const totalAvaliacoes = details?.user_ratings_total || place.user_ratings_total || null;
      const reviews = extrairAvaliacoesRecentes(details?.reviews || [], 3);

      const latPlace = details?.geometry?.location?.lat || place.geometry?.location?.lat || null;
      const lngPlace = details?.geometry?.location?.lng || place.geometry?.location?.lng || null;

      let mapsLink = '';
      if (placeId) {
        mapsLink = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
      } else if (latPlace != null && lngPlace != null) {
        mapsLink = `https://maps.google.com/?q=${latPlace},${lngPlace}`;
      } else {
        mapsLink = `https://maps.google.com/?q=${encodeURIComponent(nome)}`;
      }

      return {
        titulo: nome,
        descricao: Array.isArray(place.types) ? place.types.slice(0, 3).join(', ') : '',
        url: details?.url || '',
        endereco,
        telefone,
        avaliacao: formatarAvaliacaoGoogle(rating, totalAvaliacoes),
        mapsLink,
        avaliacoesRecentes: reviews,
      };
    }));

    console.log(`[LOCAL] ${resultados.length} resultados via Google Places.`);
    return resultados.length > 0 ? resultados : null;
  } catch (err) {
    console.error('[LOCAL] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb, pesquisarLocal };
