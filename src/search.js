const DDG = require('duck-duck-scrape');

async function pesquisarWeb(query, maxResultados = 5) {
  try {
    const results = await DDG.search(query, {
      safeSearch: DDG.SafeSearchType.MODERATE,
      locale: 'br-pt',
    });

    if (!results || !results.results || results.results.length === 0) {
      return null;
    }

    return results.results.slice(0, maxResultados).map(r => ({
      titulo: r.title,
      descricao: r.description,
      url: r.url,
    }));
  } catch (err) {
    console.error('[SEARCH] Erro ao pesquisar:', err.message);
    return null;
  }
}

module.exports = { pesquisarWeb };
