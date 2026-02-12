const DDG = require('duck-duck-scrape');

async function pesquisarWeb(query, maxResultados = 5) {
  try {
    console.log(`[SEARCH] Buscando: "${query}"`);

    const results = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.MODERATE,
      locale: 'br-pt',
    });

    if (results && results.results && results.results.length > 0) {
      return results.results.slice(0, maxResultados).map(r => ({
        titulo: r.title,
        descricao: r.description,
        url: r.url,
      }));
    }

    // Fallback: tenta sem locale específico
    console.log('[SEARCH] Nenhum resultado com locale br-pt, tentando sem locale...');
    const results2 = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.MODERATE,
    });

    if (results2 && results2.results && results2.results.length > 0) {
      return results2.results.slice(0, maxResultados).map(r => ({
        titulo: r.title,
        descricao: r.description,
        url: r.url,
      }));
    }

    console.log('[SEARCH] Nenhum resultado encontrado.');
    return null;
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb };
