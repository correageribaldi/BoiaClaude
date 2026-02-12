require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleMessage, handleImageMessage } = require('./handlers');
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
  } else if (msg.hasMedia) {
    // Ignorar outros tipos de mídia (vídeos, documentos, stickers, etc.)
    return;
  } else {
    texto = msg.body;
  }

  if (!texto || texto.trim().length === 0) return;

  try {
    const resposta = await handleMessage(usuarioId, texto);
    await msg.reply(resposta);
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
