const https = require('https');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('./database');

const EULA_PDF_PATH = path.join(__dirname, '../docs/cronos-eula.pdf');

async function enviarEulaPDF(whatsappClient, usuarioId) {
  if (!whatsappClient) return;
  if (!fs.existsSync(EULA_PDF_PATH)) return;
  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = MessageMedia.fromFilePath(EULA_PDF_PATH);
    await whatsappClient.sendMessage(usuarioId, media, { sendMediaAsDocument: true });
  } catch (err) {
    console.error('[EULA] Erro ao enviar PDF de termos:', err.message);
  }
}

const PRECO_CENTS_MENSAL = 1830;  // R$ 18,30/mês
const PRECO_CENTS_ANUAL  = 16300; // R$ 163,00/ano (≈26% de desconto)
const DIAS_TRIAL = 3;   // 3 dias grátis
const DIAS_GRACA = 0;   // sem carência — bloqueia imediatamente ao expirar

// Determina quantos dias ativar com base no order_nsu (contém '_anual_' para plano anual)
function diasDoPlano(orderNsu) {
  if (orderNsu && orderNsu.includes('_anual_')) return 365;
  return 30;
}

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
async function obterLinkPagamento(usuarioId, assinatura, plano = 'mensal') {
  const handle = process.env.INFINITYPAY_HANDLE;
  const webhookBase = process.env.WEBHOOK_BASE_URL;

  if (!handle || !webhookBase) {
    return null; // InfinityPay não configurado
  }

  // Reusar link criado nas últimas 24h (só se for do mesmo plano)
  if (assinatura?.link_pagamento && assinatura?.link_criado_em) {
    const idadeHoras = (Date.now() - new Date(assinatura.link_criado_em).getTime()) / (1000 * 60 * 60);
    const mesmoPlano = plano === 'anual'
      ? (assinatura.order_nsu || '').includes('_anual_')
      : !(assinatura.order_nsu || '').includes('_anual_');
    if (idadeHoras < 24 && mesmoPlano) {
      return assinatura.link_pagamento;
    }
  }

  const preco = plano === 'anual' ? PRECO_CENTS_ANUAL : PRECO_CENTS_MENSAL;
  const descricao = plano === 'anual'
    ? 'Cronos Assistente - Assinatura Anual'
    : 'Cronos Assistente - Assinatura Mensal';
  const nsu = `cronos_${plano}_${usuarioId.replace(/\D/g, '')}_${Date.now()}`;

  try {
    const res = await httpsPost('https://api.infinitepay.io/invoices/public/checkout/links', {
      handle,
      items: [{ quantity: 1, price: preco, description: descricao }],
      order_nsu: nsu,
      webhook_url:  `${webhookBase}/webhook/pagamento`,
      redirect_url: `${webhookBase}/pagamento/sucesso`,
    });

    const link = res.url || res.link || res.checkout_url || null;
    if (link) {
      await db.salvarLinkAssinatura(usuarioId, nsu, link);
      console.log(`[PAGAMENTO] 🔗 Link ${plano} gerado para ${usuarioId}: nsu=${nsu} url=${link}`);
    } else {
      console.error('[PAGAMENTO] API não retornou URL. Resposta:', JSON.stringify(res));
    }
    return link;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao criar link InfinityPay:', err.message);
    return null;
  }
}

// Gera link de pagamento para o plano escolhido e retorna mensagem formatada para o usuário
async function gerarLinkPlano(usuarioId, plano = 'mensal') {
  const handle = process.env.INFINITYPAY_HANDLE;
  const webhookBase = process.env.WEBHOOK_BASE_URL;

  if (!handle || !webhookBase) {
    return `❌ Sistema de pagamento não configurado. Entre em contato com o suporte.`;
  }

  const preco = plano === 'anual' ? PRECO_CENTS_ANUAL : PRECO_CENTS_MENSAL;
  const descricao = plano === 'anual'
    ? 'Cronos Assistente - Assinatura Anual'
    : 'Cronos Assistente - Assinatura Mensal';
  const nsu = `cronos_${plano}_${usuarioId.replace(/\D/g, '')}_${Date.now()}`;

  try {
    const res = await httpsPost('https://api.infinitepay.io/invoices/public/checkout/links', {
      handle,
      items: [{ quantity: 1, price: preco, description: descricao }],
      order_nsu: nsu,
      webhook_url:  `${webhookBase}/webhook/pagamento`,
      redirect_url: `${webhookBase}/pagamento/sucesso`,
    });

    const link = res.url || res.link || res.checkout_url || null;
    if (!link) {
      console.error('[PAGAMENTO] API não retornou URL para plano', plano, ':', JSON.stringify(res));
      return `❌ Erro ao gerar link. Tente novamente em instantes.`;
    }

    await db.salvarLinkAssinatura(usuarioId, nsu, link);
    console.log(`[PAGAMENTO] 🔗 Link ${plano} gerado para ${usuarioId}: nsu=${nsu} url=${link}`);

    const precoStr = plano === 'anual' ? 'R$ 163,00/ano' : 'R$ 18,30/mês';
    const emoji = plano === 'anual' ? '💎' : '💳';
    return `${emoji} *Plano ${plano === 'anual' ? 'Anual' : 'Mensal'} — ${precoStr}*\n\n` +
      `👉 ${link}\n\n_Após o pagamento, seu acesso é liberado automaticamente! ✅_`;
  } catch (err) {
    console.error('[PAGAMENTO] Erro ao criar link:', err.message);
    return `❌ Erro ao gerar link. Tente novamente.`;
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
      const dias = diasDoPlano(assinatura.order_nsu);
      const pagoAteStr = await ativarManualmente(usuarioId, dias);
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

      if (diasRestantes <= 1 && assinatura.avisos_enviados < 1) {
        aviso = `⏰ Seu período de teste *expira hoje*!\n\n` +
          `Escolha seu plano para continuar usando o Cronos:\n\n` +
          `💳 *Mensal — R$ 18,30/mês*\n` +
          `💎 *Anual — R$ 163,00/ano* _(economize 26%!)_\n\n` +
          `_Responda *mensal* ou *anual* para receber seu link de pagamento._\n\n` +
          `🎟️ _Tem um cupom? Responda *cupom SEUCÓDIGO*_`;
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
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ Seu período de teste acabou! Você tem *${diasGraca} dia(s) de carência*.\n\n` +
          `Escolha seu plano para não perder o acesso:\n\n` +
          `💳 *Mensal — R$ 18,30/mês*\n` +
          `💎 *Anual — R$ 163,00/ano* _(economize 26%!)_\n\n` +
          `_Responda *mensal* ou *anual* para receber seu link._\n\n` +
          `🎟️ _Tem um cupom? Responda *cupom SEUCÓDIGO*_`,
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
        aviso = `🔔 Sua assinatura vence em *${diasRestantes} dia(s)*!\n\n` +
          `Renove escolhendo seu plano:\n\n` +
          `💳 *Mensal — R$ 18,30/mês*\n` +
          `💎 *Anual — R$ 163,00/ano* _(economize 26%!)_\n\n` +
          `_Responda *mensal* ou *anual* para receber seu link de pagamento._\n\n` +
          `🎟️ _Tem um cupom? Responda *cupom SEUCÓDIGO*_`;
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
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ Sua assinatura venceu! Você tem *${diasGraca} dia(s) de carência*.\n\n` +
          `Renove escolhendo seu plano:\n\n` +
          `💳 *Mensal — R$ 18,30/mês*\n` +
          `💎 *Anual — R$ 163,00/ano* _(economize 26%!)_\n\n` +
          `_Responda *mensal* ou *anual* para receber seu link._\n\n` +
          `🎟️ _Tem um cupom? Responda *cupom SEUCÓDIGO*_`,
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
      return {
        permitido: true,
        status: 'graca',
        aviso: `⚠️ *${diasGraca} dia(s) de carência restante(s).*\n\n` +
          `💳 *Mensal — R$ 18,30/mês* | 💎 *Anual — R$ 163,00/ano*\n\n` +
          `_Responda *mensal*, *anual* ou *cupom SEUCÓDIGO*._`,
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
  const saudacao = nome ? `Ei, ${nome.split(' ')[0]}! ` : '';

  return `🔒 ${saudacao}Seu acesso ao *Cronos* está suspenso.\n\n` +
    `Escolha um plano para continuar:\n\n` +
    `💳 *Mensal — R$ 18,30/mês*\n` +
    `💎 *Anual — R$ 163,00/ano* _(apenas R$ 13,58/mês — economize 26%!)_\n\n` +
    `_Responda *mensal* ou *anual* para receber seu link de pagamento._\n\n` +
    `🎟️ _Tem um cupom? Responda *cupom SEUCÓDIGO*_`;
}

function msgTrialBemVindo(nome) {
  const primeiroNome = nome ? nome.split(' ')[0] : null;
  const saudacao = primeiroNome ? `, ${primeiroNome}` : '';
  return `🎉 *Bem-vindo${saudacao} ao Cronos!*\n\n` +
    `Você tem *${DIAS_TRIAL} dias grátis* para experimentar tudo!\n\n` +
    `Após o período de teste, escolha seu plano:\n` +
    `💳 *Mensal — R$ 18,30/mês*\n` +
    `💎 *Anual — R$ 163,00/ano* _(economize 26%!)_\n\n` +
    `_Qualquer dúvida é só me chamar. Bora cuidar das finanças! 🚀_\n\n` +
    `_📄 Ao usar o Cronos, você concorda com nossos Termos de Uso. Responda *termos* para receber o documento._`;
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
    return `📋 *Seu Plano Cronos*\n\n❌ Nenhum plano encontrado.\n\n💳 Assine por *R$ 18,30/mês* para começar a usar o Cronos.`;
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
    msg += `\n💰 *Plano:* Mensal — R$ 18,30/mês`;

  } else if (assinatura.status === 'ativo') {
    const pagoAte = new Date(assinatura.pago_ate + 'T23:59:59');
    const diasRestantes = Math.ceil((pagoAte - agora) / (1000 * 60 * 60 * 24));
    msg += `✅ *Status:* Ativo\n`;
    msg += `📅 *Válido até:* ${formatarDataBR(pagoAte)} (${diasRestantes} dia(s))\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 18,30/mês`;

  } else if (assinatura.status === 'graca') {
    const base = assinatura.pago_ate
      ? new Date(assinatura.pago_ate + 'T23:59:59')
      : new Date(assinatura.trial_fim);
    const fimGraca = new Date(base);
    fimGraca.setDate(fimGraca.getDate() + DIAS_GRACA);
    const diasGraca = Math.max(0, Math.ceil((fimGraca - agora) / (1000 * 60 * 60 * 24)));
    msg += `⚠️ *Status:* Carência — ${diasGraca} dia(s) para suspender\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 18,30/mês\n`;
    const link = await obterLinkPagamento(usuarioId, assinatura);
    msg += `\n👉 Renove agora: ${link || 'Entre em contato para renovar.'}`;

  } else {
    msg += `🔒 *Status:* Suspenso\n`;
    msg += `\n💰 *Plano:* Mensal — R$ 18,30/mês\n`;
    const link = await obterLinkPagamento(usuarioId, assinatura);
    msg += `\n👉 Assine para reativar: ${link || 'Entre em contato para assinar.'}`;
  }

  return msg;
}

// ─── Ativar assinatura manualmente (admin) ───────────────────────────────────

async function ativarManualmente(usuarioId, dias = 30) {
  const pagoAte = new Date();
  pagoAte.setDate(pagoAte.getDate() + dias);
  const pagoAteStr = pagoAte.toISOString().slice(0, 10);
  await db.ativarAssinatura(usuarioId, pagoAteStr);
  console.log(`[PAGAMENTO] ✅ Ativação manual: ${usuarioId} | dias=${dias} | pago_ate=${pagoAteStr}`);
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

    const dias = diasDoPlano(order_nsu);
    const pagoAte = new Date();
    pagoAte.setDate(pagoAte.getDate() + dias);
    const pagoAteStr = pagoAte.toISOString().slice(0, 10);

    await db.ativarAssinatura(assinatura.usuario_id, pagoAteStr);
    console.log(`[PAGAMENTO] ✅ Assinatura ativada via webhook: ${assinatura.usuario_id} | plano=${dias === 365 ? 'anual' : 'mensal'} | pago_ate=${pagoAteStr}`);

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

  const dias = diasDoPlano(order_nsu);
  const pagoAteStr = await ativarManualmente(assinatura.usuario_id, dias);
  console.log(`[PAGAMENTO] ✅ Ativado via redirect: ${assinatura.usuario_id} | plano=${dias === 365 ? 'anual' : 'mensal'} | pago_ate=${pagoAteStr}`);
  return { usuarioId: assinatura.usuario_id, pagoAteStr, receipt_url: receipt_url || null };
}

// ─── Cupons ───────────────────────────────────────────────────────────────────

/**
 * Valida e aplica um cupom para o usuário.
 * - dias_gratis: estende a assinatura diretamente (sem pagamento)
 * - desconto_percent: gera link InfinityPay com preço reduzido
 * Retorna: { ok, tipo, dias?, pagoAte?, desconto?, link?, erro? }
 */
async function aplicarCupom(usuarioId, codigo) {
  const cupom = await db.buscarCupom(codigo);

  if (!cupom) return { ok: false, erro: 'Cupom inválido. Verifique o código e tente novamente.' };
  if (!cupom.ativo) return { ok: false, erro: 'Este cupom foi desativado.' };
  if (cupom.usos >= cupom.uso_maximo) return { ok: false, erro: 'Este cupom já foi totalmente utilizado.' };
  if (cupom.valido_ate && new Date(cupom.valido_ate + 'T23:59:59') < new Date()) {
    return { ok: false, erro: 'Este cupom expirou.' };
  }

  if (cupom.tipo === 'dias_gratis') {
    const assinatura = await db.buscarAssinatura(usuarioId);
    const agora = new Date();

    // Base: se tem assinatura ativa no futuro, estender a partir dela; senão, de hoje
    let dataBase = agora;
    if (assinatura?.pago_ate) {
      const pagoAte = new Date(assinatura.pago_ate + 'T23:59:59');
      if (pagoAte > agora) dataBase = pagoAte;
    } else if (assinatura?.status === 'trial') {
      const trialFim = new Date(assinatura.trial_fim);
      if (trialFim > agora) dataBase = trialFim;
    }

    const novaData = new Date(dataBase);
    novaData.setDate(novaData.getDate() + cupom.valor);
    const pagoAteStr = novaData.toISOString().slice(0, 10);

    await db.ativarAssinatura(usuarioId, pagoAteStr);
    await db.incrementarUsoCupom(cupom.id);
    console.log(`[CUPOM] ✅ ${codigo} aplicado para ${usuarioId}: +${cupom.valor} dias → pago_ate=${pagoAteStr}`);

    return { ok: true, tipo: 'dias_gratis', dias: cupom.valor, pagoAte: pagoAteStr };
  }

  if (cupom.tipo === 'desconto_percent') {
    const handle = process.env.INFINITYPAY_HANDLE;
    const webhookBase = process.env.WEBHOOK_BASE_URL;

    if (!handle || !webhookBase) {
      return { ok: false, erro: 'Sistema de pagamento não configurado.' };
    }

    const precoDesconto = Math.round(PRECO_CENTS_MENSAL * (1 - cupom.valor / 100));
    const nsu = `cronos_mensal_${usuarioId.replace(/\D/g, '')}_${Date.now()}`;

    try {
      const res = await httpsPost('https://api.infinitepay.io/invoices/public/checkout/links', {
        handle,
        items: [{
          quantity: 1,
          price: precoDesconto,
          description: `Cronos Assistente - Assinatura mensal (${cupom.valor}% OFF)`,
        }],
        order_nsu: nsu,
        webhook_url: `${webhookBase}/webhook/pagamento`,
        redirect_url: `${webhookBase}/pagamento/sucesso`,
      });

      const link = res.url || res.link || res.checkout_url || null;
      if (!link) return { ok: false, erro: 'Erro ao gerar link de pagamento com desconto.' };

      await db.salvarLinkAssinatura(usuarioId, nsu, link);
      await db.incrementarUsoCupom(cupom.id);
      console.log(`[CUPOM] ✅ ${codigo} aplicado para ${usuarioId}: ${cupom.valor}% OFF → ${link}`);

      return { ok: true, tipo: 'desconto_percent', desconto: cupom.valor, link };
    } catch (err) {
      console.error('[CUPOM] Erro ao criar link com desconto:', err.message);
      return { ok: false, erro: 'Erro ao gerar link de pagamento.' };
    }
  }

  return { ok: false, erro: 'Tipo de cupom desconhecido.' };
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
          const dias = diasDoPlano(assinatura.order_nsu);
          const pagoAteStr = await ativarManualmente(assinatura.usuario_id, dias);
          console.log(`[PAGAMENTO] ✅ Ativado via polling: ${assinatura.usuario_id} | plano=${dias === 365 ? 'anual' : 'mensal'} | pago_ate=${pagoAteStr}`);
          if (whatsappClient) {
            const dataFormatada = pagoAteStr.split('-').reverse().join('/');
            await whatsappClient.sendMessage(
              assinatura.usuario_id,
              `✅ *Pagamento confirmado!* Sua assinatura do Cronos está ativa até *${dataFormatada}*. Obrigado! 🎉`
            );
            await enviarEulaPDF(whatsappClient, assinatura.usuario_id);
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
  obterLinkPagamento,
  gerarLinkPlano,
  aplicarCupom,
  processarWebhook,
  processarRedirectPagamento,
  iniciarPollingPagamentos,
};
