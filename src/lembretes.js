const cron = require('node-cron');
const db = require('./database');
const fmt = require('./formatters');
// Importação lazy para evitar dependência circular (handlers importa db, lembretes importa handlers)
function getHandlers() {
  return require('./handlers');
}

// Gera mensagens humanizadas por rodada
function gerarMensagem(rodada, transacoes) {
  const total = transacoes.reduce((s, t) => s + t.valor, 0);
  const qtd = transacoes.length;

  let detalhes = '\n';
  for (const t of transacoes) {
    const vencimento = fmt.formatarData(t.data);
    const partes = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/');
    const hoje = `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
    const atrasado = t.data < hoje;
    const tag = atrasado ? ' _(vencida!)_' : '';
    detalhes += `  ${t.tipo === 'despesa' ? '🔴' : '🟢'} *#${t.numero_usuario}* - ${t.descricao}: ${fmt.formatarMoeda(t.valor)} (venc. ${vencimento})${tag}\n`;
  }
  detalhes += `\n💵 *Total:* ${fmt.formatarMoeda(total)}`;

  if (qtd === 1) {
    const t = transacoes[0];
    const acao = t.tipo === 'despesa' ? 'pagar' : 'receber';
    const artigo = t.tipo === 'despesa' ? 'a' : 'o';
    const acaoPassado = t.tipo === 'despesa' ? 'pagou' : 'recebeu';

    if (rodada === 1) {
      return `Bom dia! Passando pra lembrar que hoje a gente tem que ${acao} ${artigo} *${t.descricao}* no valor de *${fmt.formatarMoeda(t.valor)}*.\n\nSe já ${acaoPassado}, me confirma aqui que eu dou baixa! ✅`;
    }
    if (rodada === 2) {
      return `E aí, deve ter sido corrido a manhã né... mas não deixa de ${acao} ${artigo} *${t.descricao}* (${fmt.formatarMoeda(t.valor)}) hein!\n\nSe já ${acaoPassado}, me avisa! 💬`;
    }
    return `Não querendo ser chato... kkkk mas temos que ${acao} ${artigo} *${t.descricao}* (${fmt.formatarMoeda(t.valor)}). Olha a multa depois por atraso!\n\nSe já resolveu durante o dia, me fala! 📢`;
  }

  // Múltiplas contas
  if (rodada === 1) {
    return `Bom dia! Passando pra lembrar que hoje temos *${qtd} contas* pra resolver:\n${detalhes}\n\nSe já pagou/recebeu alguma, me confirma aqui que eu dou baixa! ✅`;
  }
  if (rodada === 2) {
    return `E aí, a manhã foi corrida né... mas não esquece que ainda temos *${qtd} contas* pendentes:\n${detalhes}\n\nQualquer uma que já tenha pago/recebido, me avisa! 💬`;
  }
  return `Não querendo ser chato... kkkk mas ainda temos *${qtd} contas* pendentes pra hoje:\n${detalhes}\n\nOlha a multa por atraso! Se já resolveu alguma durante o dia, me fala! 📢`;
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

// Criação lazy: gera transações pendentes para recorrências que disparam hoje e ainda não têm registro
async function criarPendentesDeRecorrencias() {
  try {
    const hoje = new Date();
    const hojeStr = hoje.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/');
    const hojeISO = `${hojeStr[2]}-${hojeStr[1].padStart(2, '0')}-${hojeStr[0].padStart(2, '0')}`;
    const hojeObj = new Date(hojeISO + 'T12:00:00');

    // Buscar todos os usuários com recorrências ativas
    const result = await db.pool.query(
      `SELECT DISTINCT usuario_id FROM recorrencias WHERE ativo = TRUE AND (data_fim IS NULL OR data_fim >= $1)`,
      [hojeISO]
    );

    for (const row of result.rows) {
      const usuarioId = row.usuario_id;
      const regras = await db.listarRecorrencias(usuarioId);
      const ocorrenciasHoje = db.calcularOcorrenciasNoPerodo(regras, hojeObj, hojeObj);

      for (const o of ocorrenciasHoje) {
        // Verificar se já existe transação para esta recorrência neste mês
        const anoMes = hojeISO.substring(0, 7);
        const existeRes = await db.pool.query(
          `SELECT id FROM transacoes
           WHERE usuario_id = $1 AND recorrencia_id = $2 AND TO_CHAR(data, 'YYYY-MM') = $3
           LIMIT 1`,
          [usuarioId, o.recorrencia_id, anoMes]
        );
        if (existeRes.rows.length === 0) {
          // Criar transação pendente para o lembrete
          await db.adicionarTransacaoComRecorrencia(
            usuarioId, o.tipo, o.valor, o.descricao,
            o.categoria, hojeISO, 'pendente', o.recorrencia_id
          );
          console.log(`[RECORRENCIA] Criada pendente lazy: ${o.descricao} (${usuarioId})`);
        }
      }
    }
  } catch (err) {
    console.error('[RECORRENCIA] Erro ao criar pendentes lazy:', err.message);
  }
}

// Executa uma rodada de lembretes
async function executarRodada(client, rodada) {
  try {
    // Rodada 1: garantir que recorrências do dia têm transação pendente
    if (rodada === 1) {
      await criarPendentesDeRecorrencias();
    }

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

        // Registrar estado para capturar confirmação de pagamento do usuário
        try {
          const { registrarLembreteAtivo } = getHandlers();
          const ids = aindaPendentes.map(t => t.id);
          const info = aindaPendentes.map(t => ({ id: t.id, numero_usuario: t.numero_usuario, descricao: t.descricao, valor: t.valor, tipo: t.tipo }));
          registrarLembreteAtivo(usuarioId, ids, info);
        } catch (err) {
          console.error(`[LEMBRETE] Erro ao registrar estado de confirmação:`, err.message);
        }

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

// Verifica e envia lembretes recorrentes (roda a cada minuto) — FALLBACK legacy
async function verificarLembretesRecorrentes(client) {
  try {
    // Desativar expirados primeiro
    await db.desativarRecorrentesExpirados();

    const lembretes = await db.buscarRecorrentesParaDisparar();

    for (const l of lembretes) {
      try {
        const msg = `🔄 *Lembrete recorrente!*\n\nEi, passando pra te lembrar: *${l.mensagem}*\n\nBora lá! 💪`;
        await client.sendMessage(l.usuario_id, msg);
        await db.marcarRecorrenteEnviado(l.id);
        console.log(`[RECORRENTE] Enviado para ${l.usuario_id}: "${l.mensagem}" (${l.frequencia})`);
      } catch (err) {
        console.error(`[RECORRENTE] Erro ao enviar para ${l.usuario_id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[RECORRENTE] Erro ao verificar lembretes:', err.message);
  }
}

// Guard para evitar execuções sobrepostas no cron de lembretes por minuto
let _rodandoVerificacao = false;

function iniciarLembretes(client) {
  // Rodada 1: 10:00
  cron.schedule('0 10 * * *', async () => {
    console.log('[LEMBRETE] Iniciando rodada 1 (10:00)...');
    await executarRodada(client, 1);
  }, { timezone: 'America/Sao_Paulo' });

  // Rodada 2: 13:00
  cron.schedule('0 13 * * *', async () => {
    console.log('[LEMBRETE] Iniciando rodada 2 (13:00)...');
    await executarRodada(client, 2);
  }, { timezone: 'America/Sao_Paulo' });

  // Rodada 3: 20:00
  cron.schedule('0 20 * * *', async () => {
    console.log('[LEMBRETE] Iniciando rodada 3 (20:00)...');
    await executarRodada(client, 3);
  }, { timezone: 'America/Sao_Paulo' });

  // Lembretes recorrentes legacy (fallback): verifica a cada minuto
  // Nota: lembretes pontuais são gerenciados pelo BullMQ (worker-reminders.js)
  cron.schedule('* * * * *', async () => {
    if (_rodandoVerificacao) {
      console.log('[LEMBRETE] Tick ignorado — verificação anterior ainda em andamento.');
      return;
    }
    _rodandoVerificacao = true;
    try {
      await verificarLembretesRecorrentes(client);
    } finally {
      _rodandoVerificacao = false;
    }
  }, { timezone: 'America/Sao_Paulo' });

  console.log('⏰ Lembretes financeiros: 10:00, 13:00 e 20:00 (horário de Brasília)');
  console.log('🔔 Lembretes recorrentes (legacy fallback): verificação a cada minuto');
}

module.exports = { iniciarLembretes };
