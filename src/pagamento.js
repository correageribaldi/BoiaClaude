const https = require('https');
const cron = require('node-cron');
const db = require('./database');

const PRECO_CENTS = 1990; // R$ 19,90
const DIAS_TRIAL = 0;    // 0 = cobrar imediatamente (teste); produção: 30
const DIAS_GRACA = 0;    // 0 = sem carência; produção: sugerido 5

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
      webhook_url:  `${webhookBase}/webhook/pagamento`,
      redirect_url: `${webhookBase}/pagamento/sucesso`,
    });

    const link = res.url || res.link || res.checkout_url || null;
    if (link) {
      await db.salvarLinkAssinatura(usuarioId, nsu, link);
      console.log(`[PAGAMENTO] 🔗 Link gerado para ${usuarioId}: nsu=${nsu} url=${link}`);
    } else {
      console.error('[PAGAMENTO] API não retornou URL. Resposta:', JSON.stringify(res));
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
    await db.criarAssinatura(usuarioId, DIAS_TRIAL);
    return { permitido: true, ehPrimeiraVez: true, status: 'trial' };
  }

  // Fallback: se está em carência/expirado e tem order_nsu pendente, verificar via API
  if ((assinatura.status === 'graca' || assinatura.status === 'expirado') && assinatura.order_nsu) {
    const foiPago = await verificarPagamentoNSU(
      assinatura.order_nsu, assinatura.transaction_nsu, assinatura.invoice_slug
    );
    if (foiPago) {
      const pagoAteStr = await ativarManualmente(usuarioId);
      console.log(`[PAGAMENTO] ✅ Ativado via payment_check fallback: ${usuarioId}`);
      return { permitido: true, status: 'ativo', aviso: `✅ Pagamento confirmado! Sua assinatura está ativa até ${pagoAteStr.split('-').reverse().join('/')}.` };
    }
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
  if (DIAS_TRIAL === 0) {
    return `🎉 *Bem-vindo${saudacao} ao Cronos!*\n\n` +
      `Para usar o assistente financeiro, assine por apenas *R$ 19,90/mês*.\n\n` +
      `_Assim que o pagamento for confirmado, seu acesso é liberado automaticamente! 🚀_`;
  }
  return `🎉 *Bem-vindo${saudacao} ao Cronos!*\n\n` +
    `Você tem *${DIAS_TRIAL} dias grátis* para experimentar tudo. Após esse período, a assinatura é de apenas *R$ 19,90/mês*.\n\n` +
    `_Qualquer dúvida é só me chamar. Bora cuidar das finanças! 🚀_`;
}

// ─── Consulta de plano ───────────────────────────────────────────────────────

function formatarDataBR(date) {
  return new Date(date).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

async function consultarPlano(usuarioId) {
  if (ehAdmin(usuarioId)) {
    return `📋 *Seu Plano Cronos*\n\n✅ *Status:* Acesso admin\n\n_Você tem acesso irrestrito ao Cronos._`;
  }

  const assinatura = await db.buscarAssinatura(usuarioId);

  if (!assinatura) {
    return `📋 *Seu Plano Cronos*\n\n❌ Nenhum plano encontrado.\n\n💳 Assine por *R$ 19,90/mês* para começar a usar o Cronos.`;
  }

  const agora = new Date();
  let msg = `📋 *Seu Plano Cronos*\n\n`;

  if (assinatura.status === 'trial') {
    const trialFim = new Date(assinatura.trial_fim);
    const diasRestantes = Math.ceil((trialFim - agora) / (1000 * 60 * 60 * 24));
    if (diasRestantes > 0) {
      msg += `✅ *Status:* Período gratuito\n`;
      msg += `📅 *Expira em:* ${diasRestantes} dia(s) (${formatarDataBR(trialFim)})\n`;
    } else {
      msg += `⚠️ *Status:* Trial expirado\n`;
    }
    msg += `\n💰 *Plano:* Mensal — R$ 19,90/mês`;

  } else if (assinatura.status === 'ativo') {
    const pagoAte = new Date(assinatura.pago_ate + 'T23:59:59');
    const diasRestantes = Math.ceil((pagoAte - agora) / (1000 * 60 * 60 * 24));
    msg += `✅ *Status:* Ativo\n`;
    msg += `📅 *Válido até:* ${formatarDataBR(pagoAte)} (${diasRestantes} dia(s))\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 19,90/mês`;

  } else if (assinatura.status === 'graca') {
    const base = assinatura.pago_ate
      ? new Date(assinatura.pago_ate + 'T23:59:59')
      : new Date(assinatura.trial_fim);
    const fimGraca = new Date(base);
    fimGraca.setDate(fimGraca.getDate() + DIAS_GRACA);
    const diasGraca = Math.max(0, Math.ceil((fimGraca - agora) / (1000 * 60 * 60 * 24)));
    msg += `⚠️ *Status:* Carência — ${diasGraca} dia(s) para suspender\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 19,90/mês\n`;
    const link = await obterLinkPagamento(usuarioId, assinatura);
    msg += `\n👉 Renove agora: ${link || 'Entre em contato para renovar.'}`;

  } else {
    msg += `🔒 *Status:* Suspenso\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 19,90/mês\n`;
    const link = await obterLinkPagamento(usuarioId, assinatura);
    msg += `\n👉 Assine para reativar: ${link || 'Entre em contato para assinar.'}`;
  }

  return msg;
}

// ─── Ativar assinatura manualmente (admin) ───────────────────────────────────

async function ativarManualmente(usuarioId) {
  const pagoAte = new Date();
  pagoAte.setDate(pagoAte.getDate() + 30);
  const pagoAteStr = pagoAte.toISOString().slice(0, 10);
  await db.ativarAssinatura(usuarioId, pagoAteStr);
  console.log(`[PAGAMENTO] ✅ Ativação manual: ${usuarioId} | pago_ate=${pagoAteStr}`);
  return pagoAteStr;
}

// ─── Verificação de pagamento via API (fallback sem webhook) ─────────────────

// transactionNsu e invoiceSlug são opcionais mas melhoram a precisão da consulta
async function verificarPagamentoNSU(orderNsu, transactionNsu, invoiceSlug) {
  const handle = process.env.INFINITYPAY_HANDLE;
  if (!handle || !orderNsu) return false;
  try {
    // Envia todos os campos disponíveis conforme documentação InfinityPay
    const body = { handle, order_nsu: orderNsu };
    if (transactionNsu) body.transaction_nsu = transactionNsu;
    if (invoiceSlug)    body.slug = invoiceSlug;

    const res = await httpsPost('https://api.infinitepay.io/invoices/public/checkout/payment_check', body);
    console.log(`[PAGAMENTO] payment_check nsu=${orderNsu}:`, JSON.stringify(res));
    // Resposta: { success, paid, amount, paid_amount, ... }
    return res.success === true && res.paid === true;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao chamar payment_check:', err.message);
    return false;
  }
}

// ─── Webhook de confirmação de pagamento ──────────────────────────────────────

/**
 * Processa payload de webhook do InfinityPay.
 * Retorna o usuarioId ativado, ou false em caso de falha.
 * Log completo do payload para diagnóstico.
 */
async function processarWebhook(payload) {
  try {
    // Log completo para diagnóstico
    console.log('[PAGAMENTO] Webhook payload completo:', JSON.stringify(payload, null, 2));

    const order_nsu = payload?.order_nsu || payload?.nsu || payload?.invoice_nsu;

    if (!order_nsu) {
      console.error('[PAGAMENTO] Webhook sem order_nsu. Campos recebidos:', Object.keys(payload || {}));
      return false;
    }

    // Extrair campos InfinityPay para uso futuro no payment_check
    const transaction_nsu = payload?.transaction_nsu || null;
    const invoice_slug    = payload?.invoice_slug || payload?.slug || null;

    // Validação flexível: aceita se paid_amount > 0, ou se campos ausentes (InfinityPay só dispara em pagamento confirmado)
    const valorPago = Number(payload.paid_amount ?? payload.amount_paid ?? -1);
    if (valorPago === 0) {
      console.log(`[PAGAMENTO] Webhook indica valor zero: nsu=${order_nsu}, payload=${JSON.stringify(payload)}`);
      return false;
    }
    // Se paid_amount não veio no payload (-1), confia no webhook (InfinityPay só chama em pagamento aprovado)

    const assinatura = await db.buscarAssinaturaPorOrderNSU(order_nsu);
    if (!assinatura) {
      console.error('[PAGAMENTO] Webhook: nenhuma assinatura encontrada para nsu:', order_nsu);
      return false;
    }

    // Salvar transaction_nsu e invoice_slug antes de ativar (limpeza do order_nsu ocorre no ativarAssinatura)
    if (transaction_nsu || invoice_slug) {
      await db.salvarTransacaoAssinatura(order_nsu, transaction_nsu, invoice_slug);
      console.log(`[PAGAMENTO] Transação salva: transaction_nsu=${transaction_nsu} slug=${invoice_slug}`);
    }

    const pagoAte = new Date();
    pagoAte.setDate(pagoAte.getDate() + 30);
    const pagoAteStr = pagoAte.toISOString().slice(0, 10);

    await db.ativarAssinatura(assinatura.usuario_id, pagoAteStr);
    console.log(`[PAGAMENTO] ✅ Assinatura ativada via webhook: ${assinatura.usuario_id} | pago_ate=${pagoAteStr}`);

    return assinatura.usuario_id;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao processar webhook:', err.message);
    return false;
  }
}

// ─── Redirect pós-pagamento (InfinityPay redireciona browser do cliente) ──────

/**
 * Chamado quando InfinityPay redireciona o browser para GET /pagamento/sucesso?...
 * Recebe: order_nsu, transaction_nsu, slug, receipt_url, capture_method
 * Retorna: { usuarioId, pagoAteStr } se ativado, null se não encontrado/não pago.
 */
async function processarRedirectPagamento(query) {
  const { order_nsu, transaction_nsu, slug, receipt_url } = query;

  if (!order_nsu) {
    console.log('[PAGAMENTO] Redirect sem order_nsu. Params:', JSON.stringify(query));
    return null;
  }

  console.log(`[PAGAMENTO] Redirect recebido: order_nsu=${order_nsu} transaction_nsu=${transaction_nsu} slug=${slug}`);

  // Salvar transaction_nsu e slug para uso no payment_check
  if (transaction_nsu || slug) {
    await db.salvarTransacaoAssinatura(order_nsu, transaction_nsu || null, slug || null);
  }

  // Confirmar pagamento via API com todos os campos disponíveis
  const foiPago = await verificarPagamentoNSU(order_nsu, transaction_nsu, slug);
  if (!foiPago) {
    console.log(`[PAGAMENTO] Redirect: payment_check não confirmou pagamento para nsu=${order_nsu}`);
    return null;
  }

  // Buscar assinatura pelo order_nsu para obter usuarioId
  const assinatura = await db.buscarAssinaturaPorOrderNSU(order_nsu);
  if (!assinatura) {
    console.error('[PAGAMENTO] Redirect: assinatura não encontrada para order_nsu:', order_nsu);
    return null;
  }

  const pagoAteStr = await ativarManualmente(assinatura.usuario_id);
  console.log(`[PAGAMENTO] ✅ Ativado via redirect: ${assinatura.usuario_id} | pago_ate=${pagoAteStr}`);
  return { usuarioId: assinatura.usuario_id, pagoAteStr, receipt_url: receipt_url || null };
}

// ─── Polling automático de pagamentos pendentes ───────────────────────────────

/**
 * Inicia cron que verifica a cada 5 minutos se algum order_nsu pendente foi pago.
 * Complementa o webhook: garante ativação mesmo quando o webhook falha.
 */
function iniciarPollingPagamentos(whatsappClient) {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const pendentes = await db.buscarAssinaturasPendentes();
      if (pendentes.length === 0) return;

      console.log(`[PAGAMENTO] 🔄 Polling: verificando ${pendentes.length} pagamento(s) pendente(s)...`);
      for (const assinatura of pendentes) {
        const foiPago = await verificarPagamentoNSU(
          assinatura.order_nsu, assinatura.transaction_nsu, assinatura.invoice_slug
        );
        if (foiPago) {
          const pagoAteStr = await ativarManualmente(assinatura.usuario_id);
          console.log(`[PAGAMENTO] ✅ Ativado via polling: ${assinatura.usuario_id} | pago_ate=${pagoAteStr}`);
          if (whatsappClient) {
            const dataFormatada = pagoAteStr.split('-').reverse().join('/');
            await whatsappClient.sendMessage(
              assinatura.usuario_id,
              `✅ *Pagamento confirmado!* Sua assinatura do Cronos está ativa até *${dataFormatada}*. Obrigado! 🎉`
            );
          }
        }
      }
    } catch (err) {
      console.error('[PAGAMENTO] Erro no polling de pagamentos:', err.message);
    }
  });
  console.log('[PAGAMENTO] 🔄 Polling de pagamentos iniciado (verificação a cada 5 minutos).');
}

module.exports = {
  verificarAcesso,
  gerarMensagemBloqueio,
  msgTrialBemVindo,
  consultarPlano,
  ativarManualmente,
  processarWebhook,
  processarRedirectPagamento,
  iniciarPollingPagamentos,
};
