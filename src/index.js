const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { handleMessage } = require('./handlers');

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
  console.log('📊 Assistente Financeiro BoiaClaude está rodando.');
  console.log('   Envie "ajuda" no WhatsApp para ver os comandos.');
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
  // Ignorar mensagens de grupo, status e mídia
  if (msg.from.includes('@g.us')) return;
  if (msg.from === 'status@broadcast') return;
  if (msg.hasMedia) return;

  const texto = msg.body;
  if (!texto || texto.trim().length === 0) return;

  // Usar o número do remetente como ID do usuário
  const usuarioId = msg.from;

  try {
    const resposta = await handleMessage(usuarioId, texto);
    await msg.reply(resposta);
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    await msg.reply('❌ Ocorreu um erro ao processar sua mensagem. Tente novamente.');
  }
});

console.log('🚀 Iniciando Assistente Financeiro BoiaClaude...');
if (process.env.OPENAI_API_KEY) {
  console.log('🤖 IA ativa (OpenAI) - interpretação de linguagem natural habilitada.');
} else {
  console.log('⚠️  OPENAI_API_KEY não configurada - IA desabilitada, apenas comandos diretos.');
}
client.initialize();

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
