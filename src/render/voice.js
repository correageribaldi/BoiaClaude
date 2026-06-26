'use strict';

/**
 * voice.js — converte saída do core (formato WhatsApp/Markdown) em fala SSML para Alexa.
 *
 * Formatos de entrada suportados (mesmos que responderMensagem em index.js):
 *   - string
 *   - { msg, semCitacao }
 *   - { texto, grafico }          → descarta gráfico
 *   - { texto, notificarContatos }→ descarta notificação (TODO Marco 3)
 *   - Array de qualquer combinação acima
 */

// Mapa de emojis comuns → texto equivalente em português
const EMOJI_MAP = {
  '✅': 'confirmado',
  '❌': 'erro',
  '⚠️': 'atenção',
  '⚠': 'atenção',
  '💰': 'dinheiro',
  '💸': 'gasto',
  '💳': 'cartão',
  '📊': 'resumo',
  '📈': 'crescimento',
  '📉': 'queda',
  '🏦': 'banco',
  '🏷️': 'categoria',
  '🏷': 'categoria',
  '📅': 'data',
  '📆': 'calendário',
  '🔔': 'lembrete',
  '🔕': 'sem notificação',
  '⏰': 'alarme',
  '⏳': 'aguarde',
  '🔄': 'recorrente',
  '🗓️': 'agenda',
  '🗓': 'agenda',
  '💡': 'dica',
  '🎯': 'meta',
  '🚀': '',
  '👋': '',
  '😊': '',
  '🙏': '',
  '🤔': '',
  '📝': '',
  '🛒': 'compra',
  '🏠': 'moradia',
  '🚗': 'transporte',
  '✈️': 'viagem',
  '✈': 'viagem',
  '🍔': 'alimentação',
  '💊': 'saúde',
  '📱': 'celular',
  '🎉': '',
  '🎊': '',
  '⭐': '',
  '❓': '',
  '❗': '',
};

/**
 * Extrai o texto bruto de qualquer formato de saída do core.
 * Arrays são concatenados com pausa entre partes.
 * @param {*} resposta
 * @returns {{ partes: string[] }} lista de fragmentos de texto
 */
function extrairPartes(resposta) {
  if (Array.isArray(resposta)) {
    const resultado = [];
    for (const item of resposta) {
      const sub = extrairPartes(item);
      resultado.push(...sub.partes);
    }
    return { partes: resultado };
  }

  if (typeof resposta === 'string') {
    return { partes: [resposta] };
  }

  if (resposta && typeof resposta === 'object') {
    // { msg, semCitacao }
    if (resposta.msg !== undefined) {
      return { partes: [String(resposta.msg)] };
    }
    // { texto, grafico } ou { texto, notificarContatos }
    if (resposta.texto !== undefined) {
      // TODO Marco 3: tratar notificarContatos quando Proactive Events estiver disponível
      return { partes: [String(resposta.texto)] };
    }
  }

  return { partes: [''] };
}

/**
 * Converte um único fragmento de texto WhatsApp/Markdown em texto limpo.
 * @param {string} texto
 * @returns {string}
 */
function limparTexto(texto) {
  let t = texto;

  // Substituir emojis conhecidos por texto
  for (const [emoji, substituto] of Object.entries(EMOJI_MAP)) {
    // Escapar caracteres especiais de regex no emoji
    const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(escaped, 'g'), substituto ? ` ${substituto} ` : ' ');
  }

  // Remover outros emojis (unicode ranges de emoji)
  // eslint-disable-next-line no-misleading-character-class
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}]|[\u{1F900}-\u{1F9FF}]/gu, ' ');

  // Markdown WhatsApp: negrito *texto*, itálico _texto_, tachado ~texto~, mono `texto`
  // Remover marcadores mas manter o conteúdo
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  t = t.replace(/~([^~]+)~/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');

  // Citação WhatsApp "> texto"
  t = t.replace(/^>\s*/gm, '');

  // Rede de segurança: remover qualquer * _ > ~ restante
  t = t.replace(/[*_>~]/g, '');

  // Limpar espaços múltiplos
  t = t.replace(/[ \t]+/g, ' ');

  // Normalizar linhas vazias múltiplas → no máximo duas
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Converte texto limpo em SSML, transformando quebras de parágrafo em pausas.
 * @param {string} textoLimpo
 * @returns {string} fragmento SSML (sem o wrapper <speak>)
 */
function textoParaSSML(textoLimpo) {
  // Parágrafo duplo → pausa de 500ms
  return textoLimpo
    .split(/\n\n+/)
    .map(parte => parte.replace(/\n/g, ' ').trim())
    .filter(Boolean)
    .join('<break time="500ms"/>');
}

/**
 * Converte a saída do core em objeto de resposta Alexa.
 *
 * @param {string|object|Array} resposta - saída de handleMessage
 * @returns {{ speech: string, card: { title: string, content: string } }}
 */
function paraFala(resposta) {
  const { partes } = extrairPartes(resposta);

  // Limpar cada parte separadamente
  const partesLimpas = partes.map(limparTexto).filter(Boolean);

  if (partesLimpas.length === 0) {
    return {
      speech: '<speak>Pronto.</speak>',
      card: { title: 'Cronos', content: 'Pronto.' },
    };
  }

  // Para card (texto plano): unir com quebra dupla
  const textoPlano = partesLimpas.join('\n\n');

  // Para SSML: cada parte separada por pausa de 500ms
  const ssmlPartes = partesLimpas
    .map(textoParaSSML)
    .filter(Boolean)
    .join('<break time="500ms"/>');

  const speech = `<speak>${ssmlPartes}</speak>`;

  return {
    speech,
    card: { title: 'Cronos', content: textoPlano },
  };
}

module.exports = { paraFala, limparTexto, extrairPartes };
