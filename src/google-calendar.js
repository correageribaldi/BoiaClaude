/**
 * Google Calendar — Motor de sincronização
 *
 * Sincroniza lembretes do Cronos → Google Calendar do usuário.
 * Direção: one-way push (Cronos → GCal). Não importamos do GCal.
 *
 * Fluxo OAuth:
 *   1. GET /auth/google/start?token=JWT  → redireciona p/ Google
 *   2. GET /auth/google/callback?code=X  → troca code por tokens, salva no DB
 *
 * Sync automático: ao criar/editar/excluir lembrete, chama as funções deste módulo.
 * Erros no GCal são logados mas nunca impedem operação no Cronos.
 */

const { google } = require('googleapis');
const db = require('./database');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

// ── OAuth2 Client ──────────────────────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ── Calendar Client autenticado ────────────────────────────────────────────────

async function getCalendarClient(usuarioId) {
  const tokens = await db.buscarGoogleTokens(usuarioId);
  if (!tokens) return null;

  const client = getOAuth2Client();
  client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ? Number(tokens.expiry_date) : undefined,
  });

  // Listener p/ salvar tokens atualizados após refresh automático
  client.on('tokens', async (newTokens) => {
    try {
      const merged = {
        access_token: newTokens.access_token || tokens.access_token,
        refresh_token: newTokens.refresh_token || tokens.refresh_token,
        expiry_date: newTokens.expiry_date || tokens.expiry_date,
      };
      await db.salvarGoogleTokens(usuarioId, merged);
    } catch (err) {
      console.error('[GCAL] Erro ao salvar tokens atualizados:', err.message);
    }
  });

  return google.calendar({ version: 'v3', auth: client });
}

async function isConectado(usuarioId) {
  const tokens = await db.buscarGoogleTokens(usuarioId);
  return !!tokens;
}

// ── Mapeamento de frequência → RRULE ──────────────────────────────────────────

const DIA_SEMANA_MAP = {
  0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA',
  'domingo': 'SU', 'segunda': 'MO', 'terca': 'TU', 'terça': 'TU',
  'quarta': 'WE', 'quinta': 'TH', 'sexta': 'FR', 'sabado': 'SA', 'sábado': 'SA',
};

function buildRrule(frequencia, diaSemana, diaMes, dataFim) {
  let rule = '';
  if (frequencia === 'diario') {
    rule = 'RRULE:FREQ=DAILY';
  } else if (frequencia === 'semanal') {
    const day = DIA_SEMANA_MAP[diaSemana] || DIA_SEMANA_MAP[Number(diaSemana)] || 'MO';
    rule = `RRULE:FREQ=WEEKLY;BYDAY=${day}`;
  } else if (frequencia === 'mensal') {
    const dia = parseInt(diaMes) || 1;
    rule = `RRULE:FREQ=MONTHLY;BYMONTHDAY=${dia}`;
  } else {
    return null;
  }
  if (dataFim) {
    const until = dataFim.replace(/-/g, '') + 'T235959Z';
    rule += `;UNTIL=${until}`;
  }
  return rule;
}

// ── Sync: Lembrete Avulso ──────────────────────────────────────────────────────

async function sincronizarLembreteAvulso(usuarioId, lembreteId, mensagem, disparaEm) {
  try {
    const cal = await getCalendarClient(usuarioId);
    if (!cal) return;

    const start = new Date(disparaEm);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // +30min

    const eventBody = {
      summary: `📋 ${mensagem}`,
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    };

    // Verifica se já tem evento (update vs insert)
    const existingEventId = await db.buscarGoogleEventId('lembretes_gerais', lembreteId);

    if (existingEventId) {
      await cal.events.update({ calendarId: 'primary', eventId: existingEventId, resource: eventBody });
      console.log(`[GCAL] Atualizado evento avulso: ${mensagem}`);
    } else {
      const res = await cal.events.insert({ calendarId: 'primary', resource: eventBody });
      await db.salvarGoogleEventId('lembretes_gerais', lembreteId, res.data.id);
      console.log(`[GCAL] Criado evento avulso: ${mensagem}`);
    }
  } catch (err) {
    console.error(`[GCAL] Erro sync avulso (${lembreteId}):`, err.message);
  }
}

// ── Sync: Lembrete Recorrente ──────────────────────────────────────────────────

async function sincronizarLembreteRecorrente(usuarioId, lembreteId, mensagem, horario, frequencia, diaSemana, diaMes, dataFim) {
  try {
    const cal = await getCalendarClient(usuarioId);
    if (!cal) return;

    // Montar data de início: hoje + horário
    const agora = new Date();
    const [h, m] = (horario || '09:00').split(':');
    const start = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), parseInt(h), parseInt(m));
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    const rrule = buildRrule(frequencia, diaSemana, diaMes, dataFim);

    const eventBody = {
      summary: `🔔 ${mensagem}`,
      start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    };
    if (rrule) eventBody.recurrence = [rrule];

    const existingEventId = await db.buscarGoogleEventId('lembretes_recorrentes', lembreteId);

    if (existingEventId) {
      await cal.events.update({ calendarId: 'primary', eventId: existingEventId, resource: eventBody });
      console.log(`[GCAL] Atualizado evento recorrente: ${mensagem}`);
    } else {
      const res = await cal.events.insert({ calendarId: 'primary', resource: eventBody });
      await db.salvarGoogleEventId('lembretes_recorrentes', lembreteId, res.data.id);
      console.log(`[GCAL] Criado evento recorrente: ${mensagem}`);
    }
  } catch (err) {
    console.error(`[GCAL] Erro sync recorrente (${lembreteId}):`, err.message);
  }
}

// ── Remover evento ─────────────────────────────────────────────────────────────

async function removerEvento(usuarioId, googleEventId) {
  try {
    if (!googleEventId) return;
    const cal = await getCalendarClient(usuarioId);
    if (!cal) return;
    await cal.events.delete({ calendarId: 'primary', eventId: googleEventId });
    console.log(`[GCAL] Removido evento: ${googleEventId}`);
  } catch (err) {
    // 404/410 = evento já deletado, tudo ok
    if (err.code === 404 || err.code === 410) return;
    console.error(`[GCAL] Erro ao remover evento:`, err.message);
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getOAuth2Client,
  isConectado,
  sincronizarLembreteAvulso,
  sincronizarLembreteRecorrente,
  removerEvento,
};
