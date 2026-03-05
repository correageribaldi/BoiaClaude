const db = require('./database');

// Sweeper: fallback para re-enfileirar reminders pontuais atrasados e
// garantir que lembretes recorrentes sempre tenham um job agendado.
// Roda a cada 60s via setInterval (iniciado em index.js).

async function sweeperReminders() {
  try {
    const { reminderQueue } = require('./queue');

    // 1. Re-enfileirar reminders pontuais que ficaram presos em 'pending'
    const atrasados = await db.buscarRemindersPendentesAtrasados();
    for (const r of atrasados) {
      await reminderQueue.add('reminder',
        { tipo: 'one_time', reminderId: r.id },
        {
          jobId: `one-${r.id}`,
          removeOnComplete: true,
          attempts: 5,
          backoff: { type: 'exponential', delay: 10000 },
        }
      );
      console.log(`[SWEEPER] Re-enfileirado reminder pontual atrasado: ${r.id} (${r.mensagem})`);
    }

    // 2. Garantir que cada recorrente ativo tem job agendado
    await sweeperRecorrentes(reminderQueue);
  } catch (err) {
    console.error('[SWEEPER] Erro:', err.message);
  }
}

async function sweeperRecorrentes(reminderQueue) {
  try {
    await db.desativarRecorrentesExpirados();
    const regras = await db.listarRecorrentesAtivos();
    const agora = new Date();

    for (const r of regras) {
      const proxima = db.calcularProximaOcorrenciaRecorrente(r, agora);
      if (!proxima) continue;

      const jobId = `rec-${r.id}-${proxima.toISOString().substring(0, 10)}`;
      const delay = Math.max(0, proxima.getTime() - Date.now());

      // jobId idempotente: BullMQ ignora silenciosamente se o job já existe
      try {
        await reminderQueue.add('reminder',
          { tipo: 'recurrente', lembreteRecorrenteId: r.id, runAt: proxima.toISOString() },
          {
            jobId,
            delay,
            removeOnComplete: true,
            attempts: 3,
            backoff: { type: 'exponential', delay: 30000 },
          }
        );
      } catch (err) {
        // Ignorar erro de jobId duplicado (BullMQ pode lançar em algumas versões)
        if (!err.message?.includes('exists')) {
          console.error(`[SWEEPER] Erro ao enfileirar recorrente ${r.id}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error('[SWEEPER] Erro ao verificar recorrentes:', err.message);
  }
}

// Re-enfileira todos os reminders pontuais pendentes no startup do processo
async function reEnqueueOnStartup() {
  try {
    const { reminderQueue } = require('./queue');

    // Reminders pontuais futuros ainda pending
    const result = await db.pool?.query(
      `SELECT id FROM reminders WHERE status = 'pending' AND run_at > NOW()`
    );
    if (result && result.rows.length > 0) {
      for (const r of result.rows) {
        const row = await db.pool.query(`SELECT id, run_at FROM reminders WHERE id = $1`, [r.id]);
        if (!row.rows[0]) continue;
        const runAt = new Date(row.rows[0].run_at);
        const delay = Math.max(0, runAt.getTime() - Date.now());
        await reminderQueue.add('reminder',
          { tipo: 'one_time', reminderId: r.id },
          { jobId: `one-${r.id}`, delay, removeOnComplete: true, attempts: 5,
            backoff: { type: 'exponential', delay: 10000 } }
        );
      }
      console.log(`[SWEEPER] Startup: ${result.rows.length} reminder(s) pontual(is) re-enfileirado(s).`);
    }

    // Rodar sweeper de recorrentes imediatamente no startup
    await sweeperRecorrentes(reminderQueue);
    console.log('[SWEEPER] Startup: recorrentes verificados e agendados.');
  } catch (err) {
    console.error('[SWEEPER] Erro no re-enqueue de startup:', err.message);
  }
}

module.exports = { sweeperReminders, reEnqueueOnStartup };
