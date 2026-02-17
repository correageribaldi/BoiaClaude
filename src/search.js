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

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatarEndereco(valor) {
  if (!valor) return '';
  if (typeof valor === 'string') return valor;

  if (typeof valor === 'object') {
    const partes = [
      valor.streetAddress,
      valor.addressLocality,
      valor.addressRegion,
      valor.postalCode,
      valor.addressCountry,
    ].filter(Boolean);
    if (partes.length > 0) return partes.join(', ');
  }

  return '';
}

function extrairCoordenadasLocal(local) {
  if (!local || typeof local !== 'object') return null;

  const candidatos = [
    local.coordinates,
    local.coordinate,
    local.geo,
    local.location,
    local.latitude != null || local.longitude != null ? local : null,
  ].filter(Boolean);

  for (const c of candidatos) {
    const lat = toNumber(c.lat ?? c.latitude);
    const lng = toNumber(c.lng ?? c.lon ?? c.long ?? c.longitude);
    if (lat != null && lng != null) {
      return { lat, lng };
    }
  }

  return null;
}

function calcularDistanciaMetros(lat1, lng1, lat2, lng2) {
  const r = 6371000;
  const toRad = (g) => (g * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function formatarDistancia(metros) {
  if (!Number.isFinite(metros)) return '';
  if (metros < 1000) return `${Math.round(metros)} m`;
  return `${(metros / 1000).toFixed(1)} km`;
}

function formatarAvaliacaoBrave(rating) {
  if (rating == null) return '';

  if (typeof rating === 'number') {
    return `${rating}/5`;
  }

  if (typeof rating === 'object') {
    const valor = toNumber(rating.ratingValue ?? rating.value ?? rating.rating);
    const total = toNumber(rating.ratingCount ?? rating.reviewCount ?? rating.count);
    if (valor == null) return '';
    if (total == null) return `${valor}/5`;
    return `${valor}/5 (${total} avaliacoes)`;
  }

  return '';
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
  if (!process.env.BRAVE_SEARCH_API_KEY) {
    console.error('[LOCAL] BRAVE_SEARCH_API_KEY nao configurada. Busca local desabilitada.');
    return null;
  }

  try {
    const queryLocal = `${query} perto de mim`;
    console.log(`[LOCAL] Brave local: "${queryLocal}" (lat: ${lat}, lng: ${lng})`);

    const data = await braveSearch(queryLocal, maxResultados + 5, {
      lat,
      lng,
      result_filter: 'locations',
    });

    if (!data || !data.locations || !Array.isArray(data.locations.results) || data.locations.results.length === 0) {
      console.log('[LOCAL] Nenhum local encontrado no bloco locations.');
      return null;
    }

    const resultados = data.locations.results
      .map((loc) => {
        const titulo = loc.title || loc.name || '';
        const endereco = formatarEndereco(loc.postal_address || loc.address || loc.location?.address);
        const telefone = loc.phone || '';
        const coordenadas = extrairCoordenadasLocal(loc);

        const distanciaMetros = coordenadas
          ? calcularDistanciaMetros(lat, lng, coordenadas.lat, coordenadas.lng)
          : null;

        const mapsLink = coordenadas
          ? `https://maps.google.com/?q=${coordenadas.lat},${coordenadas.lng}`
          : `https://maps.google.com/?q=${encodeURIComponent(`${titulo} ${endereco}`.trim())}`;

        return {
          titulo,
          descricao: loc.description || '',
          url: loc.url || '',
          endereco,
          telefone,
          avaliacao: formatarAvaliacaoBrave(loc.rating),
          mapsLink,
          distancia: formatarDistancia(distanciaMetros),
          distanciaMetros,
          avaliacoesRecentes: [],
        };
      })
      .filter((r) => r.titulo);

    resultados.sort((a, b) => {
      if (a.distanciaMetros == null && b.distanciaMetros == null) return 0;
      if (a.distanciaMetros == null) return 1;
      if (b.distanciaMetros == null) return -1;
      return a.distanciaMetros - b.distanciaMetros;
    });

    const finais = resultados.slice(0, maxResultados).map((r) => {
      const { distanciaMetros, ...resto } = r;
      return resto;
    });

    console.log(`[LOCAL] ${finais.length} locais retornados (somente locations).`);
    return finais.length > 0 ? finais : null;
  } catch (err) {
    console.error('[LOCAL] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb, pesquisarLocal };
