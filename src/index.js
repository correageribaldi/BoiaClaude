require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleMessage, handleImageMessage, handleCSVImport, handleLocationMessage, handleContatoCompartilhado, handleAnaliseFinanceiraCSV, obterAnaliseFinanceira, mensagemBoasVindas, mensagemConviteCompartilhado, setOnboardingState, mensagemApresentacao, mensagemPerguntaNome, limparMapsExpirados } = require('./handlers');
const { transcreverAudio } = require('./ai');
const db = require('./database');
const pagamento = require('./pagamento');
const { iniciarLembretes } = require('./lembretes');
const { iniciarWebServer } = require('./webserver');
const { connection } = require('./queue');
const { criarWorkerReminders } = require('./worker-reminders');
const { sweeperReminders, reEnqueueOnStartup } = require('./sweeper');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  || '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

// Controle para evitar listeners duplicados no reconnect
let _readyExecutado = false;
let _sweeperInterval = null;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: CHROMIUM_PATH,
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('📱 Escaneie o QR Code abaixo para conectar ao WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

// Recuperar mensagens recebidas enquanto o bot estava offline
async function processarMensagensPerdidas(client) {
  const MAX_MSG_AGE_MS = 10 * 60 * 1000; // Ignorar mensagens com mais de 10 minutos
  const agora = Date.now();

  console.log('[RECOVERY] Verificando mensagens perdidas durante o restart...');

  let chats;
  try {
    chats = await client.getChats();
  } catch (err) {
    console.error('[RECOVERY] Erro ao buscar chats:', err.message);
    return;
  }

  const chatsComNaoLidas = chats.filter(
    (chat) => chat.unreadCount > 0 && !chat.isGroup
  );

  if (chatsComNaoLidas.length === 0) {
    console.log('[RECOVERY] Nenhuma mensagem perdida encontrada.');
    return;
  }

  console.log(`[RECOVERY] Encontrados ${chatsComNaoLidas.length} chat(s) com mensagens não lidas.`);

  let processadas = 0;
  let ignoradas = 0;

  for (const chat of chatsComNaoLidas) {
    try {
      // Buscar as mensagens não lidas do chat
      const mensagens = await chat.fetchMessages({ limit: chat.unreadCount });

      for (const msg of mensagens) {
        // Filtrar: apenas mensagens recebidas (não enviadas pelo bot)
        if (msg.fromMe) continue;

        // Filtrar: ignorar mensagens muito antigas (mais de 10 min)
        const msgTimestamp = msg.timestamp * 1000;
        if (agora - msgTimestamp > MAX_MSG_AGE_MS) {
          ignoradas++;
          continue;
        }

        // Filtrar: ignorar mensagens de grupo e status
        if (msg.from.includes('@g.us')) continue;
        if (msg.from === 'status@broadcast') continue;

        console.log(`[RECOVERY] Processando mensagem perdida de ${msg.from} (${new Date(msgTimestamp).toLocaleTimeString('pt-BR')})`);

        // Resolver ID canônico do usuário
        let usuarioId = msg.from;
        try {
          const contato = await msg.getContact();
          const numeroContato = (contato?.number || '').replace(/\D/g, '');
          if (numeroContato) {
            usuarioId = `${numeroContato}@c.us`;
          }
        } catch (_) {}

        // Ignorar tipos não suportados (vCard, location, documentos, vídeos, stickers)
        if (msg.type === 'vcard' || msg.type === 'multi_vcard' || msg.type === 'location') {
          console.log(`[RECOVERY] Ignorando vcard/location de ${usuarioId} (tipo: ${msg.type})`);
          ignoradas++;
          continue;
        }
        if (msg.hasMedia && !['ptt', 'audio', 'image'].includes(msg.type)) {
          console.log(`[RECOVERY] Ignorando mídia não suportada de ${usuarioId} (tipo: ${msg.type})`);
          ignoradas++;
          continue;
        }

        try {
          // Verificar acesso antes de processar
          const acesso = await pagamento.verificarAcesso(usuarioId);
          if (!acesso.permitido) {
            ignoradas++;
            continue;
          }

          // Processar áudio/voz
          if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
            try {
              const media = await msg.downloadMedia();
              if (media && media.data) {
                console.log(`[RECOVERY] Transcrevendo áudio de ${usuarioId}...`);
                const textoAudio = await transcreverAudio(media.data);
                if (textoAudio) {
                  const resposta = await handleMessage(usuarioId, textoAudio);
                  if (resposta) {
                    await responderMensagem(msg, usuarioId, resposta);
                  }
                  processadas++;
                } else {
                  await msg.reply('❌ Não consegui entender o áudio. Tente novamente ou envie por texto.');
                  ignoradas++;
                }
              }
            } catch (err) {
              console.error(`[RECOVERY] Erro ao processar áudio de ${usuarioId}:`, err.message);
            }
            continue;
          }

          // Processar imagem (boleto, nota fiscal, cupom)
          if (msg.hasMedia && msg.type === 'image') {
            try {
              const media = await msg.downloadMedia();
              if (media && media.data) {
                console.log(`[RECOVERY] Analisando imagem de ${usuarioId}...`);
                const resposta = await handleImageMessage(usuarioId, media.data, media.mimetype);
                await msg.reply(resposta);
                processadas++;
              }
            } catch (err) {
              console.error(`[RECOVERY] Erro ao processar imagem de ${usuarioId}:`, err.message);
            }
            continue;
          }

          // Processar texto
          const texto = msg.body;
          if (!texto || texto.trim().length === 0) {
            ignoradas++;
            continue;
          }

          const resposta = await handleMessage(usuarioId, texto);
          if (resposta) {
            await responderMensagem(msg, usuarioId, resposta);
          }
          processadas++;
        } catch (err) {
          console.error(`[RECOVERY] Erro ao processar mensagem de ${usuarioId}:`, err.message);
        }
      }

      // Marcar chat como lido após processar
      try {
        await chat.sendSeen();
      } catch (_) {}
    } catch (err) {
      console.error(`[RECOVERY] Erro ao processar chat ${chat.id._serialized}:`, err.message);
    }
  }

  console.log(`[RECOVERY] Concluído: ${processadas} mensagem(ns) processada(s), ${ignoradas} ignorada(s).`);
}

client.on('ready', async () => {
  console.log('✅ Bot conectado ao WhatsApp com sucesso!');
  console.log('📊 Cronos Assistente Pessoal está rodando.');
  console.log('   Envie "ajuda" no WhatsApp para ver os comandos.');

  // Prevenir listeners duplicados em reconexões
  if (!_readyExecutado) {
    _readyExecutado = true;

    // Iniciar sistema de lembretes financeiros (cron 10h/13h/20h)
    iniciarLembretes(client);

    // Iniciar worker BullMQ para lembretes pontuais e recorrentes
    criarWorkerReminders(client, connection);

    // Re-enfileirar reminders pendentes após restart do processo
    reEnqueueOnStartup().catch(err =>
      console.error('[STARTUP] Erro no reEnqueueOnStartup:', err.message)
    );

    // Sweeper fallback: roda a cada 60s para cobrir jobs perdidos
    _sweeperInterval = setInterval(sweeperReminders, 60_000);
    console.log('🔁 Sweeper de lembretes iniciado (60s).');

    // Iniciar polling de pagamentos pendentes (fallback do webhook)
    pagamento.iniciarPollingPagamentos(client);

    // GC periódico: limpa Maps de estado expirados a cada 5 min
    setInterval(limparMapsExpirados, 5 * 60 * 1000);
    console.log('🧹 GC de Maps iniciado (5min).');
  } else {
    console.log('🔄 Reconexão detectada — listeners já registrados, pulando duplicação.');
  }

  // Recuperar mensagens perdidas durante o restart (sempre executa)
  processarMensagensPerdidas(client).catch(err =>
    console.error('[STARTUP] Erro ao processar mensagens perdidas:', err.message)
  );
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
});

let _reconnectAttempts = 0;
client.on('disconnected', (reason) => {
  console.log('🔌 Desconectado:', reason);
  _reconnectAttempts++;
  const delay = Math.min(5000 * _reconnectAttempts, 60000); // 5s, 10s, 15s... max 60s
  console.log(`   Reconectando em ${delay / 1000}s (tentativa ${_reconnectAttempts})...`);
  setTimeout(() => {
    client.initialize().catch(err => {
      console.error('❌ Erro ao reinicializar:', err.message);
    });
  }, delay);
});

// Resetar contador de reconexão quando conectar com sucesso
client.on('authenticated', () => {
  console.log('🔐 Autenticação realizada com sucesso.');
  _reconnectAttempts = 0;
});

async function notificarContatosCompartilhados(usuarioPrincipalId, notificarContatos) {
  if (!Array.isArray(notificarContatos) || notificarContatos.length === 0) return;

  let nomeMaster = null;
  try {
    const usuarioMaster = await db.buscarUsuario(usuarioPrincipalId);
    nomeMaster = usuarioMaster?.nome || null;
  } catch (_) {}

  for (const item of notificarContatos) {
    const contatoId = item?.contatoId;
    if (!contatoId || contatoId === usuarioPrincipalId) continue;

    try {
      let nomeNovo = null;
      try {
        const contatoNovo = await client.getContactById(contatoId);
        nomeNovo = contatoNovo?.pushname || contatoNovo?.name || null;
      } catch (_) {}

      const convite = mensagemConviteCompartilhado(nomeNovo, nomeMaster);
      await client.sendMessage(contatoId, convite);
      console.log(`[SHARED] convite enviado para ${contatoId} (master=${usuarioPrincipalId})`);
    } catch (err) {
      console.error(`[SHARED] erro ao enviar convite para ${contatoId}:`, err.message);
    }
  }
}

async function responderMensagem(msg, usuarioId, resposta) {
  // Helper: envia sem citação (sendMessage) ou com citação (reply)
  const enviar = async (conteudo, semCitacao) => {
    if (semCitacao) {
      await client.sendMessage(usuarioId, conteudo);
    } else {
      await msg.reply(conteudo);
    }
  };

  if (Array.isArray(resposta)) {
    for (let i = 0; i < resposta.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000));
      const parte = resposta[i];
      if (typeof parte === 'object' && parte?.msg) {
        await enviar(parte.msg, parte.semCitacao);
      } else {
        await msg.reply(parte);
      }
    }
    return;
  }

  if (typeof resposta === 'object' && resposta?.texto && resposta?.grafico) {
    await enviar(resposta.texto, resposta.semCitacao);
    const media = new MessageMedia('image/png', resposta.grafico.toString('base64'), 'grafico.png');
    await enviar(media, resposta.semCitacao);
    console.log(`[GRAFICO] Gráfico enviado para ${usuarioId}`);
    return;
  }

  if (typeof resposta === 'object' && resposta?.texto) {
    await enviar(resposta.texto, resposta.semCitacao);
    await notificarContatosCompartilhados(usuarioId, resposta.notificarContatos);
    return;
  }

  if (typeof resposta === 'object' && resposta?.semCitacao) {
    await client.sendMessage(usuarioId, resposta.msg);
    return;
  }

  await msg.reply(resposta);
}

client.on('message', async (msg) => {
  // Ignorar mensagens de grupo e status
  if (msg.from.includes('@g.us')) return;
  if (msg.from === 'status@broadcast') return;

  let usuarioId = msg.from;
  let contato = null;

  try {
    contato = await msg.getContact();
    const numeroContato = (contato?.number || '').replace(/\D/g, '');
    if (numeroContato) {
      usuarioId = `${numeroContato}@c.us`;
    }
  } catch (_) {}

  if (process.env.DEBUG_SHARED_CONTACTS === '1' && usuarioId !== msg.from) {
    console.log(`[SHARED][ID] from=${msg.from} canonical=${usuarioId}`);
  }

  // Verificar se é o primeiro contato do usuário e registrar
  try {
    const ehNovo = await db.verificarUsuarioNovo(usuarioId);
    if (ehNovo) {
      // Obter nome do contato no WhatsApp
      let nome = null;
      nome = contato?.pushname || contato?.name || null;

      await db.registrarUsuario(usuarioId, nome);
      console.log(`[NOVO USUÁRIO] ${usuarioId} (${nome || 'sem nome'}) registrado. Processando primeira mensagem...`);
      // Não envia boas-vindas aqui - deixa o handleMessage processar a mensagem do usuário
      // Se o usuário disser "oi", "olá", etc, a IA responderá com saudação
    }
  } catch (error) {
    console.error('[USUARIO] Erro ao verificar primeiro contato:', error.message);
  }

  let texto = null;

  // Processar mensagens de áudio/voz
  if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        console.log(`[ÁUDIO] Recebido áudio de ${usuarioId}, transcrevendo...`);
        texto = await transcreverAudio(media.data);
        if (!texto) {
          await msg.reply('❌ Não consegui entender o áudio. Tente novamente ou envie por texto.');
          return;
        }
        console.log(`[ÁUDIO] Transcrição: "${texto}"`);
      }
    } catch (error) {
      console.error('[ÁUDIO] Erro ao processar áudio:', error.message);
      await msg.reply('❌ Erro ao processar o áudio. Tente novamente ou envie por texto.');
      return;
    }
  } else if (msg.type === 'location') {
    // Processar localização compartilhada
    try {
      const loc = msg.location;
      if (loc && loc.latitude && loc.longitude) {
        console.log(`[LOCALIZAÇÃO] Recebida de ${usuarioId}: lat=${loc.latitude}, lng=${loc.longitude}`);
        const resposta = await handleLocationMessage(usuarioId, loc);
        await msg.reply(resposta);
      }
    } catch (error) {
      console.error('[LOCALIZAÇÃO] Erro ao processar localização:', error.message);
      await msg.reply('❌ Erro ao processar a localização. Tente enviar novamente.');
    }
    return;
  } else if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    // Processar contato anexado (vCard) para vínculo de conta compartilhada
    try {
      const vcards = [];
      if (Array.isArray(msg.vCards) && msg.vCards.length > 0) {
        vcards.push(...msg.vCards);
      }
      if (msg.body) {
        vcards.push(msg.body);
      }

      const resposta = await handleContatoCompartilhado(usuarioId, vcards);
      await responderMensagem(msg, usuarioId, resposta);
    } catch (error) {
      console.error('[CONTATO] Erro ao processar vCard:', error.message);
      await msg.reply('❌ Não consegui processar esse contato agora. Tente novamente ou use: *adicionar contato 5511999998888*');
    }
    return;
  } else if (msg.hasMedia && msg.type === 'image') {
    // Processar imagens (boletos, notas fiscais, cupons)
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        console.log(`[IMAGEM] Recebida imagem de ${usuarioId}, analisando...`);
        const resposta = await handleImageMessage(usuarioId, media.data, media.mimetype);
        await msg.reply(resposta);
      }
    } catch (error) {
      console.error('[IMAGEM] Erro ao processar imagem:', error.message);
      await msg.reply('❌ Erro ao processar a imagem. Envie uma foto clara de um boleto ou nota fiscal.');
    }
    return;
  } else if (msg.hasMedia && msg.type === 'document') {
    // Processar documentos (extratos CSV)
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        const filename = (media.filename || msg.body || '').toLowerCase();
        if (filename.endsWith('.csv')) {
          console.log(`[CSV] Recebido arquivo CSV de ${usuarioId}: ${media.filename || 'sem nome'}`);
          const csvContent = Buffer.from(media.data, 'base64').toString('utf-8');

          // Verificar se está no fluxo de análise financeira
          const analise = obterAnaliseFinanceira(usuarioId);
          if (analise && analise.etapa === 'aguardando_csv') {
            await msg.reply('📄 Recebendo extrato para análise... ⏳');
            const resposta = await handleAnaliseFinanceiraCSV(usuarioId, csvContent);
            await msg.reply(resposta);
            return;
          }

          await msg.reply('📄 Recebi teu extrato! Analisando e categorizando as transações... ⏳');
          const resposta = await handleCSVImport(usuarioId, csvContent);
          await msg.reply(resposta);
        } else {
          await msg.reply('📄 Por enquanto aceito apenas arquivos *CSV* de extratos bancários.\n\n_Exporta o extrato do teu banco em formato CSV e me manda aqui!_');
        }
      }
    } catch (error) {
      console.error('[CSV] Erro ao processar documento:', error.message);
      await msg.reply('❌ Erro ao processar o arquivo. Tenta mandar novamente ou verifica se é um CSV válido.');
    }
    return;
  } else if (msg.hasMedia) {
    // Ignorar outros tipos de mídia (vídeos, stickers, etc.)
    return;
  } else {
    texto = msg.body;
  }

  if (!texto || texto.trim().length === 0) return;

  try {
    // Interceptar escolha de plano e cupom ANTES do check de acesso (usuários bloqueados também podem usar)
    const textoLower = texto.trim().toLowerCase();
    if (['mensal', 'plano mensal', 'assinar mensal', 'anual', 'plano anual', 'assinar anual'].includes(textoLower)) {
      const plano = textoLower.includes('anual') ? 'anual' : 'mensal';
      const resposta = await pagamento.gerarLinkPlano(usuarioId, plano);
      await msg.reply(resposta);
      return;
    }

    if (textoLower.startsWith('cupom ')) {
      const codigo = texto.trim().slice(6).trim().toUpperCase();
      if (!codigo) {
        await msg.reply('❌ Informe o código do cupom.\n_Ex: cupom CRONOS30_');
        return;
      }
      const resultado = await pagamento.aplicarCupom(usuarioId, codigo);
      if (!resultado.ok) {
        await msg.reply(`❌ ${resultado.erro}\n\n_Escolha seu plano: responda *mensal* ou *anual*._`);
        return;
      }
      if (resultado.tipo === 'dias_gratis') {
        const dataFormatada = resultado.pagoAte.split('-').reverse().join('/');
        await msg.reply(`🎉 Cupom aplicado com sucesso!\n\nVocê ganhou *${resultado.dias} dia(s)* de acesso gratuito ao Cronos! ✅\n\n📅 Seu acesso vai até *${dataFormatada}*. Aproveite! 🚀`);
      } else if (resultado.tipo === 'desconto_percent') {
        await msg.reply(`🎉 Cupom de *${resultado.desconto}% de desconto* aplicado!\n\n👉 ${resultado.link}\n\n_Após o pagamento, seu acesso é liberado automaticamente! ✅_`);
      }
      return;
    }

    // Enviar PDF de Termos de Uso sob demanda (disponível mesmo para usuários bloqueados)
    if (['termos', 'termos de uso', 'política', 'politica', 'privacidade', 'eula', 'contrato'].includes(textoLower)) {
      const eulaPath = path.join(__dirname, '../docs/cronos-eula.pdf');
      if (fs.existsSync(eulaPath)) {
        const media = MessageMedia.fromFilePath(eulaPath);
        await client.sendMessage(usuarioId, media, { sendMediaAsDocument: true });
      } else {
        await msg.reply('📄 Nossos Termos de Uso estão disponíveis pelo e-mail: *contato@cronosappai.com.br*');
      }
      return;
    }

    // Verificar acesso por assinatura
    const acesso = await pagamento.verificarAcesso(usuarioId);

    if (!acesso.permitido) {
      const usuario = await db.buscarUsuario(usuarioId);
      const msgBloqueio = await pagamento.gerarMensagemBloqueio(usuarioId, usuario?.nome);
      await msg.reply(msgBloqueio);
      return;
    }

    // Novo usuário: iniciar fluxo de onboarding, não processar a primeira mensagem
    if (acesso.ehPrimeiraVez) {
      setOnboardingState(usuarioId, 'aguardando_nome');
      await msg.reply(mensagemApresentacao());
      return;
    }

    const enviarAck = (ackTexto) => msg.reply(ackTexto);
    const resposta = await handleMessage(usuarioId, texto, enviarAck);
    await responderMensagem(msg, usuarioId, resposta);

    if (acesso.aviso) {
      await client.sendMessage(usuarioId, acesso.aviso);
    }
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    await msg.reply('❌ Ocorreu um erro ao processar sua mensagem. Tente novamente.');
  }
});

async function start() {
  console.log('🚀 Iniciando Cronos Assistente Pessoal...');

  // Inicializar tabelas no PostgreSQL
  try {
    await db.initTables();
    console.log('🗄️  Banco de dados PostgreSQL conectado e tabelas criadas.');
  } catch (err) {
    console.error('❌ Erro ao conectar no PostgreSQL:', err.message);
    process.exit(1);
  }

  // Iniciar servidor web (painel financeiro + webhook de pagamento)
  iniciarWebServer(client);

  if (process.env.OPENAI_API_KEY) {
    console.log('🤖 IA ativa (OpenAI) - interpretação de linguagem natural habilitada.');
    console.log('🎤 Transcrição de áudio ativa (Whisper) - envie áudios para registrar transações.');
    console.log('📸 Leitura de imagens ativa (Vision) - envie fotos de boletos e notas fiscais.');
  } else {
    console.log('⚠️  OPENAI_API_KEY não configurada - IA e transcrição de áudio desabilitadas.');
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    console.log('🔍 Pesquisa web ativa (Brave Search).');
  } else {
    console.log('⚠️  BRAVE_SEARCH_API_KEY nao configurada - pesquisa web desabilitada.');
  }

  if (process.env.SERPER_API_KEY) {
    console.log('📍 Busca local ativa (Serper).');
  } else {
    console.log('⚠️  SERPER_API_KEY nao configurada - busca local desabilitada.');
  }

  client.initialize();
}

start();

// Error handlers globais — evita que promises rejeitadas travem o event loop silenciosamente
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  [UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 [UNCAUGHT EXCEPTION]', err);
  // Dá tempo pro log ser escrito antes de encerrar
  setTimeout(() => process.exit(1), 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando bot...');
  if (_sweeperInterval) clearInterval(_sweeperInterval);
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Encerrando bot...');
  if (_sweeperInterval) clearInterval(_sweeperInterval);
  client.destroy();
  process.exit(0);
});
