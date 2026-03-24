const cron = require('node-cron');
const db = require('./database');

// Etapas da campanha de reativação (dias de inatividade → mensagem)
const ETAPAS = [
  {
    dias: 3,
    etapa: 3,
    mensagem: (nome) =>
      `Oi${nome ? `, ${nome}` : ''}! Tudo bem? 😊\n\n` +
      `Faz uns dias que você não aparece por aqui. ` +
      `Registrar suas despesas todo dia é o segredo pra ter controle real do seu dinheiro!\n\n` +
      `Bora colocar as contas em dia? É só me mandar o que gastou hoje. 💪`,
  },
  {
    dias: 7,
    etapa: 7,
    mensagem: (nome) =>
      `Ei${nome ? `, ${nome}` : ''}! Sabia que você pode registrar despesas por *áudio*? 🎤\n\n` +
      `É só gravar: _"gastei 45 reais no mercado"_ e eu registro tudo pra você.\n\n` +
      `Também aceito *foto de boleto* e *extrato CSV* do banco. Tudo pra facilitar sua vida! 📸\n\n` +
      `Me manda um oi se precisar de ajuda. 😉`,
  },
  {
    dias: 14,
    etapa: 14,
    mensagem: (nome) =>
      `${nome ? `${nome}, ` : ''}passando pra te dar uma força! 💙\n\n` +
      `Sei que organizar as finanças nem sempre é fácil, mas o primeiro passo é começar.\n\n` +
      `Que tal registrar só *uma despesa* agora? Pode ser a última compra que fez.\n\n` +
      `Estou aqui pra te ajudar! 🚀`,
  },
  {
    dias: 30,
    etapa: 30,
    mensagem: (nome) =>
      `${nome ? `${nome}, ` : ''}como você não está usando o Cronos, vou parar de enviar mensagens pra não incomodar. 🙏\n\n` +
      `Seus dados continuam salvos e seguros.\n\n` +
      `Quando quiser voltar, é só mandar um *oi* aqui que eu reativo tudo na hora! 😊\n\n` +
      `Até mais! 👋`,
  },
];

async function executarReativacao(client) {
  console.log('[REATIVACAO] Iniciando verificação de usuários inativos...');

  let totalEnviados = 0;
  let totalErros = 0;

  // Processar da etapa mais alta (30 dias) para a mais baixa (3 dias)
  // Assim, se alguém está inativo há 30 dias e nunca recebeu nenhuma etapa,
  // recebe apenas a etapa 30 (despedida), não todas de uma vez
  for (const { dias, etapa, mensagem } of [...ETAPAS].reverse()) {
    try {
      const usuarios = await db.buscarUsuariosParaReativacao(dias);

      for (const u of usuarios) {
        try {
          // Pular se já enviou esta etapa
          const jaEnviou = await db.jaEnviouReativacao(u.usuario_id, etapa);
          if (jaEnviou) continue;

          // Pular se já enviou uma etapa posterior (ex: já recebeu etapa 14, não enviar etapa 7)
          // Mas permitir etapas anteriores não enviadas se faz sentido na sequência
          // Na prática: só enviar se não recebeu NENHUMA etapa igual ou posterior
          let jaRecebeuPosterior = false;
          for (const e of ETAPAS) {
            if (e.etapa > etapa) {
              const recebeu = await db.jaEnviouReativacao(u.usuario_id, e.etapa);
              if (recebeu) { jaRecebeuPosterior = true; break; }
            }
          }
          if (jaRecebeuPosterior) continue;

          const primeiroNome = (u.nome || '').split(' ')[0] || '';
          const msg = mensagem(primeiroNome);

          await client.sendMessage(u.usuario_id, msg);
          await db.registrarReativacao(u.usuario_id, etapa);
          totalEnviados++;

          console.log(`[REATIVACAO] Etapa ${etapa}d enviada para ${u.usuario_id} (${u.nome || 'sem nome'}, inativo há ${u.dias_inativo}d)`);

          // Etapa 30 = despedida → marcar como churned
          if (etapa === 30) {
            await db.marcarChurned(u.usuario_id);
            console.log(`[REATIVACAO] ${u.usuario_id} marcado como churned`);
          }

          // Delay 5-15s entre mensagens (anti-spam)
          const delay = Math.floor(5000 + Math.random() * 10000);
          await new Promise(r => setTimeout(r, delay));
        } catch (err) {
          totalErros++;
          console.error(`[REATIVACAO] Erro ao enviar etapa ${etapa} para ${u.usuario_id}:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[REATIVACAO] Erro ao buscar usuários para etapa ${etapa}:`, err.message);
    }
  }

  console.log(`[REATIVACAO] Concluído — enviados: ${totalEnviados}, erros: ${totalErros}`);
}

function iniciarReativacao(client) {
  // Roda todo dia às 10:00 (horário de Brasília)
  cron.schedule('0 10 * * *', async () => {
    console.log('[REATIVACAO] Cron disparado (10:00 BRT)');
    await executarReativacao(client);
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🔄 Reativação automática: todo dia às 10:00 (horário de Brasília)');
}

module.exports = { iniciarReativacao, executarReativacao };
