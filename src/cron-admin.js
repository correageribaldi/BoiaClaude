const db = require('./database');

// Frequências disponíveis (valor salvo no DB → intervalo em minutos)
const FREQUENCIAS = {
  'cada_30min':    30,
  'cada_1h':       60,
  'cada_2h':       120,
  'cada_4h':       240,
  'cada_6h':       360,
  'cada_12h':      720,
  'todo_dia':      1440,
  'cada_2dias':    2880,
  'cada_3dias':    4320,
  'semanal':       10080,
};

let _whatsappClient = null;
let _intervalo = null;

function iniciarCronsAdmin(whatsappClient) {
  _whatsappClient = whatsappClient;
  // Verifica a cada 60 segundos se alguma cron precisa rodar
  _intervalo = setInterval(() => verificarCrons(), 60 * 1000);
  console.log('[CRON-ADMIN] Verificador iniciado (a cada 60s)');
  // Recupera crons que ficaram presas em 'processando' antes do restart
  recuperarCronsPendentes(whatsappClient).catch(err =>
    console.error('[CRON-ADMIN] Erro no recovery de crons pendentes:', err.message)
  );
}

async function verificarCrons() {
  try {
    const crons = await db.listarAdminCrons();
    const agora = new Date();

    for (const c of crons) {
      if (!c.ativo) continue;

      const intervaloMin = FREQUENCIAS[c.frequencia];
      if (!intervaloMin) continue;

      // Verificar horário preferido (se for frequência diária ou maior)
      if (intervaloMin >= 1440 && c.horario) {
        const [h, m] = c.horario.split(':').map(Number);
        if (agora.getHours() !== h || agora.getMinutes() !== m) continue;
      }

      // Verificar se já passou tempo suficiente desde o último envio
      if (c.ultimo_envio) {
        const ultimo = new Date(c.ultimo_envio);
        const diffMin = (agora - ultimo) / (1000 * 60);
        if (diffMin < intervaloMin) continue;
      }

      // Hora de executar
      console.log(`[CRON-ADMIN] Executando cron #${c.id}: ${c.titulo}`);
      executarCron(c.id, _whatsappClient);
    }
  } catch (err) {
    console.error('[CRON-ADMIN] Erro no verificador:', err.message);
  }
}

async function executarCron(cronId, whatsappClient) {
  const client = whatsappClient || _whatsappClient;
  if (!client) {
    console.error('[CRON-ADMIN] WhatsApp client não disponível');
    return { enviados: 0, erros: 0 };
  }

  // Adquire lock SKIP LOCKED e cria registro de log atomicamente
  const logId = await db.iniciarExecucaoCron(cronId);
  if (!logId) {
    console.log(`[CRON-ADMIN] cron #${cronId} já está sendo processada — pulando`);
    return { enviados: 0, erros: 0 };
  }

  try {
    const c = await db.buscarAdminCron(cronId);
    if (!c) {
      await db.finalizarLogAdminCron(logId, 'erro', 0, 0, 0);
      return { enviados: 0, erros: 0 };
    }

    const usuarios = await resolverDestinatarios(c.regra, c.regra_valor, c.usuario_ids);
    let enviados = 0;
    let erros = 0;

    for (let i = 0; i < usuarios.length; i++) {
      const u = usuarios[i];
      try {
        const primeiroNome = (u.nome || '').split(' ')[0] || 'amigo(a)';
        const msg = c.mensagem.replace(/\{nome\}/gi, primeiroNome);
        await client.sendMessage(u.usuario_id, msg);
        enviados++;
      } catch (err) {
        erros++;
        console.error(`[CRON-ADMIN] Erro envio para ${u.usuario_id}:`, err.message);
      }

      // Delay 5-15s entre mensagens (exceto última)
      if (i < usuarios.length - 1) {
        const delay = Math.floor(5000 + Math.random() * 10000);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    await db.finalizarLogAdminCron(logId, 'finalizado', usuarios.length, enviados, erros);
    await db.registrarEnvioAdminCron(cronId, enviados);
    console.log(`[CRON-ADMIN] Cron #${cronId} finalizada — enviados: ${enviados}, erros: ${erros}`);
    return { enviados, erros };
  } catch (err) {
    console.error(`[CRON-ADMIN] Erro não tratado na cron #${cronId}:`, err.message);
    await db.finalizarLogAdminCron(logId, 'erro', 0, 0, 0).catch(() => {});
    return { enviados: 0, erros: 0 };
  }
}

async function recuperarCronsPendentes(whatsappClient) {
  try {
    const pendentes = await db.buscarLogsPendentes();
    if (pendentes.length === 0) return;
    console.log(`[CRON-ADMIN] ${pendentes.length} cron(s) pendente(s) encontradas — tentando reexecutar`);
    for (const log of pendentes) {
      await db.cancelarLogAdminCron(log.id);
      await executarCron(log.cron_id, whatsappClient);
    }
  } catch (err) {
    console.error('[CRON-ADMIN] Erro no recovery de crons pendentes:', err.message);
  }
}

async function resolverDestinatarios(regra, valor, usuarioIds) {
  switch (regra) {
    case 'ativos_x_dias':    return db.listarUsuariosAtivos(valor || 7);
    case 'inativos_x_dias':  return db.listarUsuariosInativos(valor || 7);
    case 'nao_pagantes':     return db.listarUsuariosNaoPagantes('todos');
    case 'trial':            return db.listarUsuariosNaoPagantes('trial');
    case 'expirados':        return db.listarUsuariosNaoPagantes('expirado');
    case 'graca':            return db.listarUsuariosNaoPagantes('graca');
    case 'dias_apos_acesso': return db.listarUsuariosFeedback(valor || 0);
    case 'manual':           return db.buscarUsuariosPorIds(usuarioIds || []);
    default:                 return [];
  }
}

module.exports = { iniciarCronsAdmin, executarCron, resolverDestinatarios, recuperarCronsPendentes, FREQUENCIAS };
