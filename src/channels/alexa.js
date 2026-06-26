'use strict';

/**
 * alexa.js — adapter de entrada para o canal Alexa Echo.
 *
 * Monta a rota POST /alexa no Express existente (webserver.js chama montarRotaAlexa).
 * Valida assinatura Amazon via ask-sdk-express-adapter.
 * Resolve usuarioId a partir do vínculo persistido no DB.
 * Roteia intents para handleMessage (core canal-agnóstico).
 * Converte resposta via paraFala (src/render/voice.js).
 */

const { SkillRequestSignatureVerifier, TimestampVerifier } = require('ask-sdk-express-adapter');
const db = require('../database');
const { handleMessage } = require('../handlers');
const { paraFala } = require('../render/voice');

// ── Constantes ────────────────────────────────────────────────────────────────

const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || '';

const MENSAGEM_BOAS_VINDAS =
  'Olá! Eu sou o Cronos, seu assistente financeiro. O que você gostaria de fazer?';

const MENSAGEM_AJUDA =
  'Você pode me dizer coisas como: registrar despesa, ver meu saldo, ou mostrar resumo do mês. O que deseja?';

const MENSAGEM_ENCERRAR = 'Até mais! Qualquer dúvida financeira, é só chamar.';

const MENSAGEM_FALLBACK =
  'Não entendi bem. Pode repetir de outra forma? Por exemplo: qual é meu saldo?';

/**
 * Constrói o envelope de resposta JSON da Alexa.
 * @param {string} speech - SSML (com tag <speak>)
 * @param {{ title: string, content: string }} card
 * @param {boolean} shouldEndSession
 * @returns {object}
 */
function envelopeAlexa(speech, card, shouldEndSession = true) {
  return {
    version: '1.0',
    response: {
      outputSpeech: {
        type: 'SSML',
        ssml: speech,
      },
      card: {
        type: 'Simple',
        title: card.title,
        content: card.content,
      },
      shouldEndSession,
    },
  };
}

/**
 * Resposta simples (texto direto, sem chamar o core).
 */
function respostaSimples(texto, shouldEndSession = true) {
  const { speech, card } = paraFala(texto);
  return envelopeAlexa(speech, card, shouldEndSession);
}

// ── Verificadores de assinatura Amazon ───────────────────────────────────────

const signatureVerifier = new SkillRequestSignatureVerifier();
const timestampVerifier = new TimestampVerifier();

/**
 * Valida a assinatura da requisição Alexa.
 * Lança erro se inválida.
 * @param {import('express').Request} req
 */
async function verificarAssinatura(req) {
  const rawBody = req.rawBody;
  if (!rawBody) {
    throw new Error('rawBody ausente — configure express.raw() antes desta rota');
  }

  await signatureVerifier.verify(rawBody.toString(), req.headers);
  await timestampVerifier.verify(rawBody.toString());
}

/**
 * Valida applicationId da skill.
 * @param {object} body - body parseado da requisição
 */
function verificarApplicationId(body) {
  if (!ALEXA_SKILL_ID) {
    console.warn('[ALEXA] ALEXA_SKILL_ID não configurado — pulando validação de applicationId');
    return;
  }
  const appId = body?.session?.application?.applicationId
    || body?.context?.System?.application?.applicationId;

  if (appId !== ALEXA_SKILL_ID) {
    throw new Error(`applicationId inválido: ${appId}`);
  }
}

// ── Handler principal de intents ──────────────────────────────────────────────

/**
 * Processa um request Alexa já validado.
 * @param {object} body - payload JSON completo do request Alexa
 * @returns {Promise<object>} envelope de resposta Alexa
 */
async function processarRequest(body) {
  const requestType = body?.request?.type;
  const intentName = body?.request?.intent?.name;
  const alexaUserId = body?.context?.System?.user?.userId
    || body?.session?.user?.userId;

  console.log(`[ALEXA] requestType=${requestType} intentName=${intentName || '-'} alexaUserId=${alexaUserId?.slice(-8) || 'n/a'}`);

  // ── SessionEndedRequest: noop ─────────────────────────────────────────────
  if (requestType === 'SessionEndedRequest') {
    return {
      version: '1.0',
      response: {},
    };
  }

  // ── LaunchRequest: boas-vindas ────────────────────────────────────────────
  if (requestType === 'LaunchRequest') {
    // Verificar se usuário está vinculado
    const usuarioId = alexaUserId ? await db.resolverUsuarioPorAlexa(alexaUserId) : null;

    if (!usuarioId) {
      // Gerar código de pareamento e instruir o usuário
      let instrucao = MENSAGEM_BOAS_VINDAS + ' Para começar, precisamos vincular sua conta. ';
      if (alexaUserId) {
        try {
          const codigo = await db.gerarCodigoPareamento(alexaUserId);
          instrucao += `Envie a mensagem "vincular alexa ${codigo}" no WhatsApp do Cronos para concluir o vínculo.`;
        } catch (err) {
          console.error('[ALEXA] Erro ao gerar código de pareamento:', err.message);
          instrucao += 'Envie "vincular alexa" no WhatsApp do Cronos para obter o código de vínculo.';
        }
      } else {
        instrucao += 'Abra o WhatsApp e envie "vincular alexa" para o Cronos para obter o código de vínculo.';
      }
      return respostaSimples(instrucao, false);
    }

    return respostaSimples(MENSAGEM_BOAS_VINDAS, false);
  }

  // ── IntentRequest ─────────────────────────────────────────────────────────
  if (requestType === 'IntentRequest') {
    // Intents de controle (sem necessidade de vínculo)
    if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
      return respostaSimples(MENSAGEM_ENCERRAR, true);
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return respostaSimples(MENSAGEM_AJUDA, false);
    }

    if (intentName === 'AMAZON.FallbackIntent') {
      return respostaSimples(MENSAGEM_FALLBACK, false);
    }

    // Para intents que precisam de vínculo, resolver usuarioId
    const usuarioId = alexaUserId ? await db.resolverUsuarioPorAlexa(alexaUserId) : null;

    if (!usuarioId) {
      let instrucao = 'Sua conta ainda não está vinculada ao Cronos. ';
      if (alexaUserId) {
        try {
          const codigo = await db.gerarCodigoPareamento(alexaUserId);
          instrucao += `Envie a mensagem "vincular alexa ${codigo}" no WhatsApp do Cronos.`;
        } catch (err) {
          instrucao += 'Envie "vincular alexa" no WhatsApp do Cronos para obter o código.';
        }
      }
      return respostaSimples(instrucao, false);
    }

    // Intent principal: FalarComCronos
    if (intentName === 'FalarComCronos') {
      const textoSlot = body?.request?.intent?.slots?.texto?.value;

      if (!textoSlot || !textoSlot.trim()) {
        return respostaSimples('Não captei o que você disse. Pode repetir?', false);
      }

      try {
        // Enviar direto para o core — mesma IA do WhatsApp
        const resposta = await handleMessage(usuarioId, textoSlot, null);
        const { speech, card } = paraFala(resposta);
        return envelopeAlexa(speech, card, true);
      } catch (err) {
        console.error('[ALEXA] Erro em handleMessage:', err.message);
        return respostaSimples('Ocorreu um erro ao processar sua solicitação. Tente novamente.', true);
      }
    }

    // Intent não reconhecido
    return respostaSimples(MENSAGEM_FALLBACK, false);
  }

  // Tipo de request desconhecido
  return respostaSimples('Não consegui entender essa solicitação.', true);
}

// ── Montagem da rota Express ──────────────────────────────────────────────────

/**
 * Monta a rota POST /alexa no app Express fornecido.
 * Deve ser chamado em webserver.js antes de iniciarWebServer.
 *
 * @param {import('express').Application} app
 */
function montarRotaAlexa(app) {
  // express.raw() para capturar body bruto necessário para verificação de assinatura
  const rawBodyParser = require('express').raw({ type: 'application/json', limit: '10mb' });

  app.post('/alexa', rawBodyParser, async (req, res) => {
    let body;

    try {
      // Guardar rawBody para o verificador de assinatura
      req.rawBody = req.body; // express.raw() já entrega Buffer

      // Parse JSON
      const raw = req.rawBody instanceof Buffer ? req.rawBody.toString('utf8') : req.rawBody;
      body = JSON.parse(raw);
    } catch (err) {
      console.error('[ALEXA] Erro ao parsear body:', err.message);
      return res.status(400).json({ error: 'Body inválido' });
    }

    try {
      await verificarAssinatura(req);
    } catch (err) {
      console.error('[ALEXA] Assinatura inválida:', err.message);
      return res.status(400).json({ error: 'Assinatura inválida' });
    }

    try {
      verificarApplicationId(body);
    } catch (err) {
      console.error('[ALEXA] ApplicationId inválido:', err.message);
      return res.status(400).json({ error: 'ApplicationId inválido' });
    }

    try {
      const resposta = await processarRequest(body);
      return res.json(resposta);
    } catch (err) {
      console.error('[ALEXA] Erro ao processar request:', err.message);
      const fallback = respostaSimples('Erro interno. Tente novamente.', true);
      return res.json(fallback);
    }
  });

  console.log('[ALEXA] Rota POST /alexa montada');
}

module.exports = { montarRotaAlexa, processarRequest, respostaSimples, envelopeAlexa };
