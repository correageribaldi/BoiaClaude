const https = require('https');
const db = require('./database');

const PRECO_CENTS = 1990; // R$ 19,90
const DIAS_GRACA = 5;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function adminIds() {
  const raw = process.env.ADMIN_WHATSAPP_IDS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function ehAdmin(usuarioId) {
  return adminIds().includes(usuarioId);
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Link de pagamento ────────────────────────────────────────────────────────

// Retorna link existente se criado nas últimas 24h, senão cria um novo
async function obterLinkPagamento(usuarioId, assinatura) {
  const handle = process.env.INFINITYPAY_HANDLE;
  const webhookBase = process.env.WEBHOOK_BASE_URL;

  if (!handle || !webhookBase) {
    return null; // InfinityPay não configurado
  }

  // Reusar link criado nas últimas 24h
  if (assinatura?.link_pagamento && assinatura?.link_criado_em) {
    const idadeHoras = (Date.now() - new Date(assinatura.link_criado_em).getTime()) / (1000 * 60 * 60);
    if (idadeHoras < 24) {
      return assinatura.link_pagamento;
    }
  }

  // Criar novo link
  const nsu = `cronos_${usuarioId.replace(/\D/g, '')}_${Date.now()}`;
  try {
    const res = await httpsPost('https://api.infinitepay.io/invoices/public/checkout/links', {
      handle,
      items: [{ quantity: 1, price: PRECO_CENTS, description: 'Cronos Assistente - Assinatura mensal' }],
      order_nsu: nsu,
      webhook_url: `${webhookBase}/webhook/pagamento`,
    });

    const link = res.url || res.link || res.checkout_url || null;
    if (link) {
      await db.salvarLinkAssinatura(usuarioId, nsu, link);
    }
    return link;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao criar link InfinityPay:', err.message);
    return null;
  }
}

// ─── Verificação de acesso ────────────────────────────────────────────────────

/**
 * Verifica se o usuário tem acesso ao bot.
 * Retorna: { permitido, status, ehPrimeiraVez?, aviso? }
 */
async function verificarAcesso(usuarioId) {
  if (ehAdmin(usuarioId)) {
    return { permitido: true, status: 'admin' };
  }

  let assinatura = await db.buscarAssinatura(usuarioId);

  if (!assinatura) {
    await db.criarAssinatura(usuarioId);
    return { permitido: true, ehPrimeiraVez: true, status: 'trial' };
  }

  const agora = new Date();

  // ── TRIAL ──
  if (assinatura.status === 'trial') {
    const trialFim = new Date(assinatura.trial_fim);

    if (agora <= trialFim) {
      const diasRestantes = Math.ceil((trialFim - agora) / (1000 * 60 * 60 * 24));
      let aviso = null;

      if (diasRestantes <= 3 && assinatura.avisos_enviados < 2) {
        const link = await obterLinkPagamento(usuarioId, assinatura);
        aviso = `⏰ Seu período gratuito termina em *${diasRestantes} dia(s)*!\n\n` +
          `Assine por apenas *R$ 19,90/mês* para continuar usando o Cronos sem interrupção.` +
          (link ? `\n\n👉 ${link}` : '');
        await db.incrementarAvisosAssinatura(usuarioId);
      }

      return { permitido: true, status: 'trial', aviso };
    }

    // Trial expirou — entrar em carência
    const fimGraca = new Date(trialFim);
    fimGraca.setDate(fimGraca.getDate() + DIAS_GRACA);

    if (agora <= fimGraca) {
      if (assinatura.status !== 'graca') {
        await db.atualizarStatusAssinatura(usuarioId, 'graca');
        assinatura = { ...assinatura, status: 'graca' };
      }
      const diasGraca = Math.ceil((fimGraca - agora) / (1000 * 60 * 60 * 24));
      const link = await obterLinkPagamento(usuarioId, assinatura);
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ Seu período gratuito acabou! Você tem *${diasGraca} dia(s) de carência*.\n\n` +
          `Assine por *R$ 19,90/mês* para não perder o acesso.` +
          (link ? `\n\n👉 ${link}` : ''),
      };
    }

    await db.atualizarStatusAssinatura(usuarioId, 'expirado');
    return { permitido: false, status: 'expirado' };
  }

  // ── ATIVO ──
  if (assinatura.status === 'ativo') {
    const pagoAte = new Date(assinatura.pago_ate + 'T23:59:59');

    if (agora <= pagoAte) {
      const diasRestantes = Math.ceil((pagoAte - agora) / (1000 * 60 * 60 * 24));
      let aviso = null;

      if (diasRestantes <= 3 && assinatura.avisos_enviados < 2) {
        const link = await obterLinkPagamento(usuarioId, assinatura);
        aviso = `🔔 Sua assinatura vence em *${diasRestantes} dia(s)*. Renove para continuar:` +
          (link ? `\n\n👉 ${link}` : '');
        await db.incrementarAvisosAssinatura(usuarioId);
      }

      return { permitido: true, status: 'ativo', aviso };
    }

    // Assinatura vencida — carência
    const fimGraca = new Date(pagoAte);
    fimGraca.setDate(fimGraca.getDate() + DIAS_GRACA);

    if (agora <= fimGraca) {
      if (assinatura.status !== 'graca') {
        await db.atualizarStatusAssinatura(usuarioId, 'graca');
        assinatura = { ...assinatura, status: 'graca' };
      }
      const diasGraca = Math.ceil((fimGraca - agora) / (1000 * 60 * 60 * 24));
      const link = await obterLinkPagamento(usuarioId, assinatura);
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ Sua assinatura venceu! Você tem *${diasGraca} dia(s) de carência*.\n\n` +
          `Renove por *R$ 19,90/mês* para não perder o acesso.` +
          (link ? `\n\n👉 ${link}` : ''),
      };
    }

    await db.atualizarStatusAssinatura(usuarioId, 'expirado');
    return { permitido: false, status: 'expirado' };
  }

  // ── CARÊNCIA (já foi marcado como graca anteriormente) ──
  if (assinatura.status === 'graca') {
    const base = assinatura.pago_ate
      ? new Date(assinatura.pago_ate + 'T23:59:59')
      : new Date(assinatura.trial_fim);
    const fimGraca = new Date(base);
    fimGraca.setDate(fimGraca.getDate() + DIAS_GRACA);

    if (agora <= fimGraca) {
      const diasGraca = Math.ceil((fimGraca - agora) / (1000 * 60 * 60 * 24));
      const link = await obterLinkPagamento(usuarioId, assinatura);
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ *${diasGraca} dia(s) de carência restante(s)*. Assine para não perder o acesso.` +
          (link ? `\n\n👉 ${link}` : ''),
      };
    }

    await db.atualizarStatusAssinatura(usuarioId, 'expirado');
    return { permitido: false, status: 'expirado' };
  }

  // ── EXPIRADO ──
  return { permitido: false, status: 'expirado' };
}

// ─── Mensagens ────────────────────────────────────────────────────────────────

async function gerarMensagemBloqueio(usuarioId, nome) {
  const assinatura = await db.buscarAssinatura(usuarioId);
  const link = await obterLinkPagamento(usuarioId, assinatura);
  const saudacao = nome ? `Ei, ${nome.split(' ')[0]}! ` : '';

  return `🔒 ${saudacao}Seu acesso ao *Cronos* está suspenso.\n\n` +
    `Para continuar usando o assistente financeiro, assine por apenas *R$ 19,90/mês*.\n` +
    (link ? `\n👉 ${link}\n` : '') +
    `\n_Após o pagamento, seu acesso é liberado automaticamente!_ ✅`;
}

function msgTrialBemVindo(nome) {
  const primeiroNome = nome ? nome.split(' ')[0] : null;
  const saudacao = primeiroNome ? `, ${primeiroNome}` : '';
  return `🎉 *Bem-vindo${saudacao} ao Cronos!*\n\n` +
    `Você tem *30 dias grátis* para experimentar tudo. Após esse período, a assinatura é de apenas *R$ 19,90/mês*.\n\n` +
    `_Qualquer dúvida é só me chamar. Bora cuidar das finanças! 🚀_`;
}

// ─── Webhook de confirmação de pagamento ──────────────────────────────────────

/**
 * Processa payload de webhook do InfinityPay.
 * Retorna o usuarioId ativado, ou false em caso de falha.
 */
async function processarWebhook(payload) {
  try {
    const { order_nsu, paid_amount, amount } = payload || {};

    if (!order_nsu) {
      console.error('[PAGAMENTO] Webhook sem order_nsu');
      return false;
    }

    // Verificar se foi de fato pago
    const valorPago = Number(paid_amount || 0);
    const valorTotal = Number(amount || PRECO_CENTS);
    if (valorPago < valorTotal) {
      console.log(`[PAGAMENTO] Webhook recebido mas não pago: nsu=${order_nsu}, pago=${valorPago}, total=${valorTotal}`);
      return false;
    }

    const assinatura = await db.buscarAssinaturaPorOrderNSU(order_nsu);
    if (!assinatura) {
      console.error('[PAGAMENTO] Webhook: assinatura não encontrada para nsu:', order_nsu);
      return false;
    }

    // pago_ate = hoje + 30 dias
    const pagoAte = new Date();
    pagoAte.setDate(pagoAte.getDate() + 30);
    const pagoAteStr = pagoAte.toISOString().slice(0, 10);

    await db.ativarAssinatura(assinatura.usuario_id, pagoAteStr);
    console.log(`[PAGAMENTO] ✅ Assinatura ativada: ${assinatura.usuario_id} | pago_ate=${pagoAteStr}`);

    return assinatura.usuario_id;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao processar webhook:', err.message);
    return false;
  }
}

module.exports = {
  verificarAcesso,
  gerarMensagemBloqueio,
  msgTrialBemVindo,
  processarWebhook,
};
