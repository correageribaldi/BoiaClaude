const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

connection.on('error', (err) => {
  console.error('[REDIS] Erro de conexão:', err.message);
});

connection.on('connect', () => {
  console.log('[REDIS] Conectado ao Redis.');
});

const reminderQueue = new Queue('reminders', { connection });

module.exports = { reminderQueue, connection };
