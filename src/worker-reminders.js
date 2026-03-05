const { Worker } = require('bullmq');
const db = require('./database');

function criarWorkerReminders(client, connection) {
  const worker = new Worker('reminders', async (job) => {
    const { tipo, reminderId, lembreteRecorrenteId, runAt } = job.data;

    if (tipo === 'one_time') {
      const claimed = await db.claimReminder(reminderId);
      if (!claimed) {
        // Já foi enviado, cancelado ou claimed por outro worker
        return;
      }
      try {
        const msg = `🔔 *Lembrete!*\n\nEi, passando pra te lembrar: *${claimed.mensagem}*\n\nBora lá! 💪`;
        await client.sendMessage(claimed.usuario_id, msg);
        await db.markReminderSent(reminderId);
        console.log(`[WORKER] Lembrete pontual enviado para ${claimed.usuario_id}: "${claimed.mensagem}"`);
      } catch (err) {
        await db.markReminderFailed(reminderId, err.message);
        console.error(`[WORKER] Falha ao enviar lembrete ${reminderId}:`, err.message);
        throw err; // BullMQ fará retry com backoff
      }
    }

    if (tipo === 'recurrente') {
      const regra = await db.buscarLembreteRecorrentePorId(lembreteRecorrenteId);
      if (!regra || !regra.ativo) return;

      // Guard de idempotência: se já enviou hoje, pula
      const hoje = new Date(runAt).toISOString().substring(0, 10);
      if (regra.ultimo_envio === hoje) return;

      try {
        const msg = `🔄 *Lembrete recorrente!*\n\nEi, passando pra te lembrar: *${regra.mensagem}*\n\nBora lá! 💪`;
        await client.sendMessage(regra.usuario_id, msg);
        await db.marcarRecorrenteEnviado(lembreteRecorrenteId);
        console.log(`[WORKER] Lembrete recorrente enviado para ${regra.usuario_id}: "${regra.mensagem}" (${regra.frequencia})`);
      } catch (err) {
        console.error(`[WORKER] Falha ao enviar recorrente ${lembreteRecorrenteId}:`, err.message);
        throw err; // BullMQ fará retry
      }

      // Agendar próxima ocorrência
      agendarProximaRecorrente(lembreteRecorrenteId, regra, new Date(runAt));
    }
  }, {
    connection,
    concurrency: 3,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  worker.on('failed', (job, err) => {
    console.error(`[WORKER] Job ${job?.id} falhou definitivamente: ${err.message}`);
  });

  console.log('[WORKER] Worker de lembretes iniciado (BullMQ).');
  return worker;
}

// Agenda a próxima ocorrência de um lembrete recorrente na fila
async function agendarProximaRecorrente(lembreteRecorrenteId, regra, aposData) {
  try {
    const { reminderQueue } = require('./queue');
    const proxima = db.calcularProximaOcorrenciaRecorrente(regra, aposData);
    if (!proxima) {
      // Sem próxima ocorrência: desativar regra
      console.log(`[WORKER] Recorrente #${lembreteRecorrenteId} sem próxima ocorrência, desativando.`);
      return;
    }
    const delay = Math.max(0, proxima.getTime() - Date.now());
    const jobId = `rec-${lembreteRecorrenteId}-${proxima.toISOString().substring(0, 10)}`;
    await reminderQueue.add('reminder',
      { tipo: 'recurrente', lembreteRecorrenteId, runAt: proxima.toISOString() },
      { jobId, delay, removeOnComplete: true, attempts: 3,
        backoff: { type: 'exponential', delay: 30000 } }
    );
    console.log(`[WORKER] Próxima ocorrência de recorrente #${lembreteRecorrenteId} agendada para ${proxima.toISOString()}`);
  } catch (err) {
    console.error(`[WORKER] Erro ao agendar próxima ocorrência de recorrente #${lembreteRecorrenteId}:`, err.message);
  }
}

module.exports = { criarWorkerReminders, agendarProximaRecorrente };
