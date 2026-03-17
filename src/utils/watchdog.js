/**
 * Watchdog do cliente WhatsApp.
 * Verifica o estado da conexão periodicamente e força reinicialização
 * caso o client esteja zumbi (Chrome travado, WebSocket morto, etc.).
 */

const INTERVALO_MS = 3 * 60 * 1000; // 3 minutos

async function _verificar(client) {
  try {
    const state = await client.getState();
    console.log(`[WATCHDOG] state=${state} uptime=${Math.round(process.uptime())}s`);
    if (state !== 'CONNECTED') {
      console.warn(`[WATCHDOG] estado fora do ar (${state}) — forçando reinicialização`);
      await client.destroy().catch(() => {});
      await client.initialize().catch(err =>
        console.error('[WATCHDOG] erro ao reinicializar:', err.message)
      );
    }
  } catch (err) {
    console.warn('[WATCHDOG] getState falhou — Chrome pode ter travado:', err.message);
    await client.destroy().catch(() => {});
    await client.initialize().catch(e =>
      console.error('[WATCHDOG] erro ao reinicializar após falha:', e.message)
    );
  }
}

/**
 * Inicia o watchdog.
 * @param {import('whatsapp-web.js').Client} client
 */
function iniciarWatchdog(client) {
  setInterval(() => _verificar(client), INTERVALO_MS);
  console.log('👁  Watchdog WhatsApp iniciado (3min).');
}

module.exports = { iniciarWatchdog };
