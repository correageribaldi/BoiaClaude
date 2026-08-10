// ─── Notificador — envio proativo de WhatsApp fora do fluxo de mensagem ──────
//
// Existe para que módulos de backend (sincronização Pluggy, jobs) consigam
// falar com o usuário sem importar handlers.js (que importa database, ai,
// agentes — ciclo garantido) e sem depender do objeto `app` do Express.
//
// Mesma ideia do `_whatsappClient` já usado em agente-crescimento.js e
// cron-admin.js, mas num módulo próprio para não amarrar quem só quer enviar
// uma mensagem a um agente inteiro.
//
// REGRA: enviar NUNCA lança. O WhatsApp cai (sessão expirada, QR code
// pendente, servidor reiniciando) com frequência suficiente para que um envio
// falho jamais possa abortar a operação que o originou — uma sincronização
// bancária não pode ser perdida porque o aviso não saiu.

let _client = null;

function registrarWhatsappClient(client) {
  _client = client;
}

function whatsappDisponivel() {
  return Boolean(_client);
}

// Retorna true se entregou ao cliente, false em qualquer outro caso.
async function enviarWhatsapp(usuarioId, mensagem) {
  if (!_client) {
    console.warn(`[NOTIFICADOR] WhatsApp indisponível — mensagem para ${usuarioId} descartada.`);
    return false;
  }
  if (!usuarioId || !mensagem) return false;

  try {
    await _client.sendMessage(usuarioId, mensagem);
    return true;
  } catch (err) {
    console.error(`[NOTIFICADOR] Falha ao enviar WhatsApp para ${usuarioId}:`, err.message);
    return false;
  }
}

module.exports = {
  registrarWhatsappClient,
  whatsappDisponivel,
  enviarWhatsapp,
};
