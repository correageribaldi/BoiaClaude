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

function serperRequest(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) {
      reject(new Error('SERPER_API_KEY nao configurada'));
      return;
    }

    const body = JSON.stringify(payload || {});
    const options = {
      hostname: 'google.serper.dev',
      path: `/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (err) {
          reject(new Error(`Erro ao parsear resposta Serper: ${err.message}`));
          return;
        }

        if (res.statusCode >= 400) {
          const msg = data?.message || data?.error || `HTTP ${res.statusCode}`;
          reject(new Error(`Serper ${endpoint}: ${msg}`));
          return;
        }

        resolve(data);
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout na busca Serper'));
    });
    req.write(body);
    req.end();
  });
}

const cacheReverseGeocode = new Map();

function chaveCacheCoordenadas(lat, lng) {
  const a = Number(lat).toFixed(3);
  const b = Number(lng).toFixed(3);
  return `${a},${b}`;
}

function montarContextoLocalizacaoPadrao(lat, lng) {
  return {
    location: `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}, Brasil`,
    cidade: '',
    estado: '',
    pais: 'Brasil',
    bairro: '',
    rua: '',
  };
}

async function reverseGeocodeNominatim(lat, lng) {
  const key = chaveCacheCoordenadas(lat, lng);
  const cached = cacheReverseGeocode.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.contexto;
  }

  return new Promise((resolve) => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '14',
      addressdetails: '1',
      'accept-language': 'pt-BR',
    });

    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path: `/reverse?${params.toString()}`,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'CronosAssistente/1.0 (busca-local)',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          const data = raw ? JSON.parse(raw) : {};
          const addr = data.address || {};
          const cidade = addr.city || addr.town || addr.village || addr.municipality || addr.county || '';
          const estado = addr.state || addr.region || '';
          const pais = addr.country || '';
          const bairro = addr.suburb || addr.neighbourhood || addr.quarter || addr.city_district || '';
          const rua = addr.road || addr.pedestrian || addr.cycleway || '';

          let location = [cidade, estado, pais].filter(Boolean).join(', ');
          if (!location && data.display_name) {
            location = String(data.display_name)
              .split(',')
              .slice(0, 3)
              .map((p) => p.trim())
              .filter(Boolean)
              .join(', ');
          }

          if (location) {
            const contexto = {
              location,
              cidade,
              estado,
              pais: pais || 'Brasil',
              bairro,
              rua,
            };

            cacheReverseGeocode.set(key, {
              contexto,
              expiresAt: Date.now() + 6 * 60 * 60 * 1000,
            });
            resolve(contexto);
            return;
          }
        } catch (_) {}

        resolve(null);
      });
    });

    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
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

function parseDistanciaTexto(valor) {
  if (!valor || typeof valor !== 'string') return null;

  const texto = valor
    .toLowerCase()
    .replace(',', '.')
    .trim();

  const m = texto.match(/(-?\d+(?:\.\d+)?)\s*(km|quilometro|quilômetros|quilometros|m|metro|metros)\b/);
  if (!m) return null;

  const numero = toNumber(m[1]);
  if (numero == null || numero < 0) return null;

  const unidade = m[2];
  if (unidade.startsWith('k') || unidade.includes('quilo')) return numero * 1000;
  return numero;
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

function limparTituloMaps(titulo) {
  if (!titulo) return '';
  return String(titulo)
    .replace(/\s*-\s*Google\s*Maps\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extrairLinkMapsBruto(url, profundidade = 0) {
  if (!url || profundidade > 2) return null;

  const texto = String(url).trim();
  if (!texto) return null;

  try {
    const u = new URL(texto);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();

    if (host === 'maps.app.goo.gl' || host === 'goo.gl') return u.toString();
    if (host.startsWith('maps.google.')) return u.toString();
    if (host === 'google.com' || host.endsWith('.google.com')) {
      if (path.includes('/maps')) return u.toString();

      for (const chave of ['url', 'q', 'u', 'dest', 'destination', 'redirect']) {
        const valor = u.searchParams.get(chave);
        if (!valor) continue;
        const candidato = extrairLinkMapsBruto(valor, profundidade + 1);
        if (candidato) return candidato;
      }
    }

    const match = texto.match(/https?:\/\/[^"'\s]*google\.[^"'\s]*\/maps[^"'\s]*/i);
    if (match) return match[0];
    return null;
  } catch (_) {
    const match = texto.match(/https?:\/\/[^"'\s]*google\.[^"'\s]*\/maps[^"'\s]*/i);
    return match ? match[0] : null;
  }
}

function normalizarUrlHttp(url) {
  if (!url) return null;
  const texto = String(url).trim();
  if (!texto) return null;

  try {
    const u = new URL(texto);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    return null;
  } catch (_) {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(texto)) return null;
    try {
      const u = new URL(`https://${texto}`);
      return u.toString();
    } catch (_) {
      return null;
    }
  }
}

function ehLinkMaps(url) {
  return !!extrairLinkMapsBruto(url);
}

function extrairSiteOficial(item, mapsLink) {
  const candidatos = [
    item.website,
    item.site,
    item.officialWebsite,
    item.url,
    item.link,
  ];

  for (const candidato of candidatos) {
    const normalizado = normalizarUrlHttp(candidato);
    if (!normalizado) continue;
    if (ehLinkMaps(normalizado)) continue;
    if (mapsLink && normalizado === mapsLink) continue;
    return normalizado;
  }

  return '';
}

function extrairCoordenadasDeUrl(url) {
  if (!url) return null;

  const s = String(url);
  const padroes = [
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&]query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  ];

  for (const re of padroes) {
    const m = s.match(re);
    if (m) {
      const lat = toNumber(m[1]);
      const lng = toNumber(m[2]);
      if (lat != null && lng != null) return { lat, lng };
    }
  }

  return null;
}

function extrairLocaisDeLocations(data, lat, lng) {
  if (!data || !data.locations || !Array.isArray(data.locations.results)) return [];

  return data.locations.results
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
        site: '',
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
}

function extrairLocaisDeWebMaps(data, lat, lng) {
  if (!data || !data.web || !Array.isArray(data.web.results)) return [];

  return data.web.results
    .map((r) => {
      const mapsLink = extrairLinkMapsBruto(r.url);
      if (!mapsLink) return null;

      const titulo = limparTituloMaps(r.title);
      const descricao = r.description || r.extra_snippets?.[0] || '';
      const coords = extrairCoordenadasDeUrl(mapsLink);
      const distanciaMetros = coords ? calcularDistanciaMetros(lat, lng, coords.lat, coords.lng) : null;

      return {
        titulo: titulo || 'Local no Google Maps',
        descricao,
        url: mapsLink,
        site: '',
        endereco: '',
        telefone: '',
        avaliacao: '',
        mapsLink,
        distancia: formatarDistancia(distanciaMetros),
        distanciaMetros,
        avaliacoesRecentes: [],
      };
    })
    .filter(Boolean);
}

function normalizarChaveLocal(titulo, mapsLink) {
  return `${(titulo || '').toLowerCase().trim()}|${(mapsLink || '').toLowerCase().trim()}`;
}

function ordenarPorDistancia(list) {
  list.sort((a, b) => {
    if (a.distanciaMetros == null && b.distanciaMetros == null) return 0;
    if (a.distanciaMetros == null) return 1;
    if (b.distanciaMetros == null) return -1;
    return a.distanciaMetros - b.distanciaMetros;
  });
}

function removerCampoDistanciaInterna(list) {
  return list.map((r) => {
    const { distanciaMetros, ...resto } = r;
    return resto;
  });
}

function limitarPorDistancia(list, maxResultados) {
  const limiteKm = toNumber(process.env.LOCAL_MAX_DISTANCE_KM) ?? 50;
  const limiteMetros = limiteKm > 0 ? limiteKm * 1000 : null;

  ordenarPorDistancia(list);
  if (limiteMetros == null) {
    return list.slice(0, maxResultados);
  }

  const dentro = list.filter((r) => r.distanciaMetros != null && r.distanciaMetros <= limiteMetros);
  const semDistancia = list.filter((r) => r.distanciaMetros == null);

  if (dentro.length > 0) {
    return [...dentro, ...semDistancia].slice(0, maxResultados);
  }

  return list.slice(0, maxResultados);
}

function extrairCoordenadasGenericas(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const candidatos = [
    obj,
    obj.coordinates,
    obj.coordinate,
    obj.location,
    obj.geo,
    obj.position,
    obj.geometry?.location,
  ].filter(Boolean);

  for (const c of candidatos) {
    const lat = toNumber(c.lat ?? c.latitude);
    const lng = toNumber(c.lng ?? c.longitude ?? c.lon ?? c.long);
    if (lat != null && lng != null) return { lat, lng };
  }

  return null;
}

function mapearLocalSerper(item, lat, lng) {
  const titulo = item.title || item.name || item.placeName || '';
  if (!titulo) return null;

  const endereco = formatarEndereco(item.address || item.formattedAddress || item.vicinity || '');
  const telefone = item.phoneNumber || item.phone || '';
  const coordsDoItem = extrairCoordenadasGenericas(item);

  let mapsLink = extrairLinkMapsBruto(
    item.googleMapsUrl
    || item.mapsUrl
    || item.placeUrl
    || item.mapUrl
    || item.link
    || item.url
    || ''
  );

  if (!mapsLink) {
    if (item.placeId) {
      mapsLink = `https://www.google.com/maps/place/?q=place_id:${item.placeId}`;
    } else if (coordsDoItem) {
      mapsLink = `https://maps.google.com/?q=${coordsDoItem.lat},${coordsDoItem.lng}`;
    } else {
      mapsLink = `https://maps.google.com/?q=${encodeURIComponent(`${titulo} ${endereco}`.trim())}`;
    }
  }

  const coordsDoLink = extrairCoordenadasDeUrl(mapsLink);
  const coords = coordsDoItem || coordsDoLink;
  const site = extrairSiteOficial(item, mapsLink);

  const distanciaTextoSerper = typeof item.distance === 'string' ? item.distance : '';
  const distanciaMetrosTexto = parseDistanciaTexto(distanciaTextoSerper);
  const distanciaMetros = coords
    ? calcularDistanciaMetros(lat, lng, coords.lat, coords.lng)
    : distanciaMetrosTexto;

  const rating = item.rating ?? item.stars ?? null;
  const ratingCount = item.ratingCount ?? item.reviews ?? item.reviewCount ?? null;
  const avaliacao = rating != null
    ? (ratingCount != null ? `${rating}/5 (${ratingCount} avaliacoes)` : `${rating}/5`)
    : '';

  const distanciaTexto = formatarDistancia(distanciaMetros) || distanciaTextoSerper;

  return {
    titulo,
    descricao: item.snippet || item.description || item.category || '',
    url: mapsLink,
    site,
    endereco,
    telefone,
    avaliacao,
    mapsLink,
    distancia: distanciaTexto,
    distanciaMetros,
    avaliacoesRecentes: [],
  };
}

function extrairLocaisSerper(data, lat, lng) {
  if (!data || typeof data !== 'object') return [];

  const grupos = [];
  if (Array.isArray(data.places)) grupos.push(...data.places);
  if (Array.isArray(data.localResults)) grupos.push(...data.localResults);
  if (Array.isArray(data.localPack)) grupos.push(...data.localPack);
  if (Array.isArray(data.maps)) grupos.push(...data.maps);
  if (Array.isArray(data.organic)) grupos.push(...data.organic);

  return grupos
    .map((item) => mapearLocalSerper(item, lat, lng))
    .filter(Boolean);
}

async function pesquisarLocalSerper(query, lat, lng, maxResultados = 15) {
  if (!process.env.SERPER_API_KEY) return null;

  const contextoGeo = (await reverseGeocodeNominatim(lat, lng)) || montarContextoLocalizacaoPadrao(lat, lng);
  const locationFinal = contextoGeo.location;
  const cidade = contextoGeo.cidade || '';
  const bairro = contextoGeo.bairro || '';
  const rua = contextoGeo.rua || '';

  const payloadBase = {
    q: query,
    gl: 'br',
    hl: 'pt-br',
    location: locationFinal,
    ll: `@${lat},${lng},14z`,
    num: Math.max(maxResultados, 15),
    autocorrect: true,
    page: 1,
  };

  const endpoints = ['places'];
  const queries = [query];
  if (rua && bairro && cidade) queries.unshift(`${query} na ${rua}, ${bairro}, ${cidade}`);
  if (bairro && cidade) queries.unshift(`${query} em ${bairro}, ${cidade}`);
  if (cidade) queries.push(`${query} em ${cidade}`);
  queries.push(`${query} perto de mim`);

  console.log(`[LOCAL][SERPER] location="${locationFinal}" ll="@${lat},${lng},14z" (coords=${lat},${lng})`);

  const resultados = [];
  const existentes = new Set();

  for (const endpoint of endpoints) {
    for (const q of queries) {
      try {
        const data = await serperRequest(endpoint, { ...payloadBase, q });
        const locais = extrairLocaisSerper(data, lat, lng);
        console.log(`[LOCAL][SERPER] endpoint=${endpoint} query="${q}" itens=${locais.length}`);

        for (const local of locais) {
          const chave = normalizarChaveLocal(local.titulo, local.mapsLink);
          if (existentes.has(chave)) continue;
          resultados.push(local);
          existentes.add(chave);
          if (resultados.length >= maxResultados + 6) break;
        }

        if (resultados.length >= maxResultados) break;
      } catch (err) {
        console.log(`[LOCAL][SERPER] endpoint=${endpoint} falhou: ${err.message}`);
      }
    }

    if (resultados.length >= maxResultados) break;
  }

  if (resultados.length === 0) {
    return null;
  }

  const selecionados = limitarPorDistancia(resultados, maxResultados);
  return removerCampoDistanciaInterna(selecionados);
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

async function pesquisarLocal(query, lat, lng, maxResultados = 15) {
  if (!process.env.SERPER_API_KEY) {
    console.error('[LOCAL] SERPER_API_KEY nao configurada. Busca local desabilitada.');
    return null;
  }

  try {
    const viaSerper = await pesquisarLocalSerper(query, lat, lng, maxResultados);
    if (viaSerper && viaSerper.length > 0) {
      console.log(`[LOCAL] ${viaSerper.length} locais retornados via Serper.`);
      return viaSerper;
    }

    const buscaDiretaMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}&center=${lat},${lng}`;
    console.log('[LOCAL] Serper sem resultados. Retornando link de busca direta.');
    return [{
      titulo: `Buscar "${query}" no Google Maps`,
      descricao: 'Nao consegui listar locais agora, mas este link abre a busca no mapa na sua regiao.',
      url: buscaDiretaMaps,
      site: '',
      endereco: '',
      telefone: '',
      avaliacao: '',
      mapsLink: buscaDiretaMaps,
      distancia: '',
      avaliacoesRecentes: [],
    }];
  } catch (err) {
    console.error('[LOCAL] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb, pesquisarLocal };
