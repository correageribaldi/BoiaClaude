require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleMessage, handleImageMessage, handleCSVImport, handleLocationMessage, handleContatoCompartilhado, handleAnaliseFinanceiraCSV, obterAnaliseFinanceira, mensagemBoasVindas } = require('./handlers');
const { transcreverAudio } = require('./ai');
const db = require('./database');
const { iniciarLembretes } = require('./lembretes');

const CHROMIUM_PATH = process.env.CHROMIUM_PATH
  || '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('📱 Escaneie o QR Code abaixo para conectar ao WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot conectado ao WhatsApp com sucesso!');
  console.log('📊 Cronos Assistente Pessoal está rodando.');
  console.log('   Envie "ajuda" no WhatsApp para ver os comandos.');

  // Iniciar sistema de lembretes automáticos
  iniciarLembretes(client);
});

client.on('authenticated', () => {
  console.log('🔐 Autenticação realizada com sucesso.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
});

client.on('disconnected', (reason) => {
  console.log('🔌 Desconectado:', reason);
  console.log('   Reiniciando...');
  client.initialize();
});

client.on('message', async (msg) => {
  // Ignorar mensagens de grupo e status
  if (msg.from.includes('@g.us')) return;
  if (msg.from === 'status@broadcast') return;

  const usuarioId = msg.from;

  // Verificar se é o primeiro contato do usuário e registrar
  try {
    const ehNovo = await db.verificarUsuarioNovo(usuarioId);
    if (ehNovo) {
      // Obter nome do contato no WhatsApp
      let nome = null;
      try {
        const contact = await msg.getContact();
        nome = contact.pushname || contact.name || null;
      } catch (_) {}

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
      await msg.reply(resposta);
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
    const resposta = await handleMessage(usuarioId, texto);

    // Verificar se a resposta contém gráfico (objeto) ou é só texto (string)
    if (typeof resposta === 'object' && resposta.texto && resposta.grafico) {
      // Enviar texto primeiro
      await msg.reply(resposta.texto);

      // Enviar gráfico como imagem
      const media = new MessageMedia('image/png', resposta.grafico.toString('base64'), 'grafico.png');
      await msg.reply(media);
      console.log(`[GRAFICO] Gráfico enviado para ${usuarioId}`);
    } else {
      // Resposta normal (só texto)
      await msg.reply(resposta);
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

  if (process.env.OPENAI_API_KEY) {
    console.log('🤖 IA ativa (OpenAI) - interpretação de linguagem natural habilitada.');
    console.log('🎤 Transcrição de áudio ativa (Whisper) - envie áudios para registrar transações.');
    console.log('📸 Leitura de imagens ativa (Vision) - envie fotos de boletos e notas fiscais.');
  } else {
    console.log('⚠️  OPENAI_API_KEY não configurada - IA e transcrição de áudio desabilitadas.');
  }

  if (process.env.BRAVE_SEARCH_API_KEY) {
    console.log('🔍 Pesquisa ativa (Brave Search) - busca na internet habilitada.');
  } else {
    console.log('⚠️  BRAVE_SEARCH_API_KEY não configurada - pesquisa na internet desabilitada.');
  }

  client.initialize();
}

start();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Encerrando bot...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Encerrando bot...');
  client.destroy();
  process.exit(0);
});
