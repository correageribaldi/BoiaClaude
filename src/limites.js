// ─── Limites de gasto — mensagens e alerta consolidado ───────────────────────
//
// Camada fina entre o cálculo (src/database.js: verificarLimitesCategoria,
// listarConsumoLimites, registrarFaixaAlertada) e os dois canais de saída
// (texto do WhatsApp e JSON do painel).
//
// Mora num módulo próprio, e não em handlers.js, porque quem mais precisa
// disso é src/pluggy.js — e pluggy → handlers seria um ciclo (handlers já
// importa praticamente tudo). As dependências aqui são só database,
// formatters e notificador.
//
// DOIS REGIMES DE AVISO, de propósito:
//
//  1. REATIVO (lançamento manual, WhatsApp ou painel): mostra o consumo
//     SEMPRE que a categoria tem teto, mesmo em 20%. Não é spam — é resposta a
//     uma ação que o usuário acabou de fazer, e é literalmente o que ele pediu
//     ("usei o cartão, me diz quanto já gastei de Mercado nessa semana").
//
//  2. PROATIVO (fim de uma sincronização Pluggy): o usuário não pediu nada,
//     então só fala quando há o que dizer — categoria que SUBIU de faixa
//     (60/80/100%) por causa daquele lote. Uma sincronização, uma mensagem,
//     listando só as categorias afetadas.

const db = require('./database');
const fmt = require('./formatters');
const notificador = require('./notificador');

const EMOJI_POR_FAIXA = { 0: '✅', 60: '📊', 80: '⚠️', 100: '🚨' };

function emojiDaFaixa(faixa) {
  return EMOJI_POR_FAIXA[faixa] || '✅';
}

// Barra de 10 blocos. Acima de 100% enche tudo — o número ao lado já conta a
// história do estouro, e uma barra "transbordando" só confundiria.
function barraProgresso(percentual) {
  const cheios = Math.max(0, Math.min(Math.round(percentual / 10), 10));
  return '█'.repeat(cheios) + '░'.repeat(10 - cheios);
}

function rotuloJanela(janela) {
  return janela === 'semana' ? 'esta semana' : 'este mês';
}

// Bloco de uma janela: "Mercado — esta semana / barra / usado de teto".
function formatarBlocoJanela(categoria, janela, info) {
  let bloco = `\n\n${emojiDaFaixa(info.faixa)} *${categoria}* — ${rotuloJanela(janela)}\n`;
  bloco += `${barraProgresso(info.percentual)} ${info.percentual}%\n`;
  bloco += `Usado: ${fmt.formatarMoeda(info.gastos)} de ${fmt.formatarMoeda(info.limite)} | `;
  bloco += info.restante >= 0
    ? `Resta: *${fmt.formatarMoeda(info.restante)}*`
    : `*Estourou ${fmt.formatarMoeda(Math.abs(info.restante))}*`;
  return bloco;
}

// Texto a anexar na confirmação de uma despesa recém-lançada. String vazia
// quando a categoria não tem teto — quem chama concatena sem verificar nada.
//
// Também sobe a marca d'água de faixa avisada: sem isso, uma sincronização
// logo depois repetiria proativamente um estouro que o usuário acabou de ver.
async function blocoLimitesDaTransacao(usuarioId, categoria, opcoes = {}) {
  if (!categoria) return '';

  let info;
  try {
    info = await db.verificarLimitesCategoria(usuarioId, categoria, opcoes);
  } catch (err) {
    // Consulta de teto é acessório da confirmação de lançamento: se falhar, o
    // usuário ainda precisa saber que a despesa foi registrada.
    console.error('[LIMITES] Falha ao consultar limites da transação:', err.message);
    return '';
  }
  if (!info) return '';

  let msg = '';
  for (const janela of ['semana', 'mes']) {
    const dados = info[janela];
    if (!dados) continue;
    msg += formatarBlocoJanela(categoria, janela, dados);
    if (dados.faixa > 0) {
      try {
        await db.registrarFaixaAlertada(usuarioId, categoria, janela, dados.chave, dados.faixa);
      } catch (err) {
        console.error('[LIMITES] Falha ao registrar faixa avisada:', err.message);
      }
    }
  }
  return msg;
}

// Mesma informação, em JSON, para a resposta da API do painel.
async function resumoLimitesDaTransacao(usuarioId, categoria, opcoes = {}) {
  if (!categoria) return null;
  try {
    const info = await db.verificarLimitesCategoria(usuarioId, categoria, opcoes);
    if (!info) return null;
    for (const janela of ['semana', 'mes']) {
      const dados = info[janela];
      if (dados?.faixa > 0) {
        await db.registrarFaixaAlertada(usuarioId, categoria, janela, dados.chave, dados.faixa);
      }
    }
    return info;
  } catch (err) {
    console.error('[LIMITES] Falha ao montar resumo de limites:', err.message);
    return null;
  }
}

// Monta o texto consolidado a partir das categorias que subiram de faixa.
// Função pura (recebe a lista pronta) para ser testável sem banco.
function formatarAvisoConsolidado(estouros) {
  if (!estouros.length) return '';

  const pior = Math.max(...estouros.map((e) => e.faixa));
  const titulo = pior >= 100
    ? '🚨 *Limite estourado*'
    : pior >= 80 ? '⚠️ *Atenção aos limites*' : '📊 *De olho nos limites*';

  let msg = `${titulo}\n_Depois de sincronizar seu banco:_`;
  for (const e of estouros) {
    msg += formatarBlocoJanela(e.categoria, e.janela, e);
  }
  return msg;
}

// Avaliação proativa ao fim de uma sincronização: quais das categorias tocadas
// pelo lote subiram de faixa, e em qual janela.
async function apurarEstouros(usuarioId, categorias, opcoes = {}) {
  const estouros = [];

  for (const categoria of categorias) {
    const info = await db.verificarLimitesCategoria(usuarioId, categoria, opcoes);
    if (!info) continue;

    for (const janela of ['semana', 'mes']) {
      const dados = info[janela];
      if (!dados || dados.faixa <= 0) continue;
      const subiu = await db.registrarFaixaAlertada(usuarioId, categoria, janela, dados.chave, dados.faixa);
      if (subiu) estouros.push({ categoria, janela, ...dados });
    }
  }

  // Pior primeiro: quem estourou aparece antes de quem só encostou nos 60%.
  estouros.sort((a, b) => b.faixa - a.faixa || b.percentual - a.percentual);
  return estouros;
}

// Ponto de entrada usado pela sincronização Pluggy.
//
// NUNCA lança: o try/catch cobre inclusive a apuração (consulta ao banco), não
// só o envio. Perder o aviso é ruim; perder a sincronização por causa do aviso
// seria pior. Devolve quantas categorias entraram na mensagem (0 = nada a
// dizer, ou falhou), para log e teste.
async function avisarLimitesPosSync(usuarioId, categorias, opcoes = {}) {
  const lista = [...new Set((categorias || []).filter(Boolean))];
  if (lista.length === 0) return 0;

  try {
    const estouros = await apurarEstouros(usuarioId, lista, opcoes);
    if (estouros.length === 0) return 0;

    const enviado = await notificador.enviarWhatsapp(usuarioId, formatarAvisoConsolidado(estouros));
    if (!enviado) {
      console.warn(`[LIMITES] Aviso de ${estouros.length} limite(s) não entregue (WhatsApp fora) — usuário ${usuarioId}.`);
    }
    return estouros.length;
  } catch (err) {
    console.error('[LIMITES] Falha ao avisar limites pós-sync (sincronização não é afetada):', err.message);
    return 0;
  }
}

module.exports = {
  emojiDaFaixa,
  barraProgresso,
  formatarBlocoJanela,
  formatarAvisoConsolidado,
  blocoLimitesDaTransacao,
  resumoLimitesDaTransacao,
  apurarEstouros,
  avisarLimitesPosSync,
};
