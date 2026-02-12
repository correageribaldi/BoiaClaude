const cron = require('node-cron');
const db = require('./database');
const fmt = require('./formatters');

// Gera mensagens humanizadas por rodada
function gerarMensagem(rodada, transacoes) {
  const total = transacoes.reduce((s, t) => s + t.valor, 0);
  const qtd = transacoes.length;

  let detalhes = '\n';
  for (const t of transacoes) {
    const vencimento = fmt.formatarData(t.data);
    const hoje = new Date().toISOString().split('T')[0];
    const atrasado = t.data < hoje;
    const tag = atrasado ? ' _(vencida!)_' : '';
    detalhes += `  ${t.tipo === 'despesa' ? '🔴' : '🟢'} *#${t.id}* - ${t.descricao}: ${fmt.formatarMoeda(t.valor)} (venc. ${vencimento})${tag}\n`;
  }
  detalhes += `\n💵 *Total:* ${fmt.formatarMoeda(total)}`;

  if (qtd === 1) {
    const t = transacoes[0];
    const acao = t.tipo === 'despesa' ? 'pagar' : 'receber';
    const artigo = t.tipo === 'despesa' ? 'a' : 'o';

    if (rodada === 1) {
      return `Bom dia! Passando pra lembrar que hoje a gente tem que ${acao} ${artigo} *${t.descricao}* no valor de *${fmt.formatarMoeda(t.valor)}*.\n\nSe já resolveu, me confirma aqui que eu dou baixa!\n\n_Envie: *pagar #${t.id}*_`;
    }
    if (rodada === 2) {
      return `E aí, deve ter sido corrido a manhã né... mas não deixa de ${acao} ${artigo} *${t.descricao}* (${fmt.formatarMoeda(t.valor)}) hein!\n\nSe já pagou, só me confirma aqui.\n\n_Envie: *pagar #${t.id}*_`;
    }
    return `Não querendo ser chato... kkkk mas temos que ${acao} ${artigo} *${t.descricao}* (${fmt.formatarMoeda(t.valor)}). Olha a multa depois por atraso!\n\nSe já resolveu durante o dia, me avisa!\n\n_Envie: *pagar #${t.id}*_`;
  }

  // Múltiplas contas
  if (rodada === 1) {
    return `Bom dia! Passando pra lembrar que hoje temos *${qtd} contas* pra resolver:\n${detalhes}\n\nSe já pagou alguma, me confirma aqui que eu dou baixa!\n\n_Envie: *pagar #ID* para cada uma_`;
  }
  if (rodada === 2) {
    return `E aí, a manhã foi corrida né... mas não esquece que ainda temos *${qtd} contas* pendentes:\n${detalhes}\n\nQualquer uma que já tenha pago, me avisa!\n\n_Envie: *pagar #ID* para cada uma_`;
  }
  return `Não querendo ser chato... kkkk mas ainda temos *${qtd} contas* pendentes pra hoje:\n${detalhes}\n\nOlha a multa por atraso! Se já resolveu alguma durante o dia, me avisa!\n\n_Envie: *pagar #ID* para cada uma_`;
}

// Agrupa transações por usuário
function agruparPorUsuario(transacoes) {
  const grupos = {};
  for (const t of transacoes) {
    if (!grupos[t.usuario_id]) grupos[t.usuario_id] = [];
    grupos[t.usuario_id].push(t);
  }
  return grupos;
}

// Executa uma rodada de lembretes
async function executarRodada(client, rodada) {
  try {
    const pendentes = await db.buscarPendentesParaLembrete(rodada);

    if (pendentes.length === 0) {
      console.log(`[LEMBRETE] Rodada ${rodada}: nenhum lembrete pendente.`);
      return;
    }

    const porUsuario = agruparPorUsuario(pendentes);

    for (const [usuarioId, transacoes] of Object.entries(porUsuario)) {
      // Filtrar só as que ainda estão pendentes (pode ter pago entre rodadas)
      const aindaPendentes = [];
      for (const t of transacoes) {
        const pendente = await db.transacaoAindaPendente(t.id);
        if (pendente) aindaPendentes.push(t);
      }

      if (aindaPendentes.length === 0) continue;

      const mensagem = gerarMensagem(rodada, aindaPendentes);

      try {
        await client.sendMessage(usuarioId, mensagem);
        console.log(`[LEMBRETE] Rodada ${rodada}: enviado para ${usuarioId} (${aindaPendentes.length} contas)`);

        // Registrar cada lembrete enviado
        for (const t of aindaPendentes) {
          await db.registrarLembreteEnviado(t.id, usuarioId, rodada);
        }
      } catch (err) {
        console.error(`[LEMBRETE] Erro ao enviar para ${usuarioId}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[LEMBRETE] Erro na rodada ${rodada}:`, err.message);
  }
}

// Verifica e envia lembretes gerais que já venceram (roda a cada minuto)
async function verificarLembretesGerais(client) {
  try {
    const lembretes = await db.buscarLembretesParaDisparar();

    for (const l of lembretes) {
      try {
        const msg = `🔔 *Lembrete!*\n\nEi, passando pra te lembrar: *${l.mensagem}*\n\nBora lá! 💪`;
        await client.sendMessage(l.usuario_id, msg);
        console.log(`[LEMBRETE GERAL] Enviado para ${l.usuario_id}: "${l.mensagem}"`);
      } catch (err) {
        console.error(`[LEMBRETE GERAL] Erro ao enviar para ${l.usuario_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[LEMBRETE GERAL] Erro ao verificar lembretes:', err.message);
  }
}

function iniciarLembretes(client) {
  // Rodada 1: 10:00
  cron.schedule('0 10 * * *', () => {
    console.log('[LEMBRETE] Iniciando rodada 1 (10:00)...');
    executarRodada(client, 1);
  }, { timezone: 'America/Sao_Paulo' });

  // Rodada 2: 13:00
  cron.schedule('0 13 * * *', () => {
    console.log('[LEMBRETE] Iniciando rodada 2 (13:00)...');
    executarRodada(client, 2);
  }, { timezone: 'America/Sao_Paulo' });

  // Rodada 3: 20:00
  cron.schedule('0 20 * * *', () => {
    console.log('[LEMBRETE] Iniciando rodada 3 (20:00)...');
    executarRodada(client, 3);
  }, { timezone: 'America/Sao_Paulo' });

  // Lembretes gerais: verifica a cada minuto
  cron.schedule('* * * * *', () => {
    verificarLembretesGerais(client);
  }, { timezone: 'America/Sao_Paulo' });

  console.log('⏰ Lembretes financeiros: 10:00, 13:00 e 20:00 (horário de Brasília)');
  console.log('🔔 Lembretes gerais: verificação a cada minuto');
}

module.exports = { iniciarLembretes };
