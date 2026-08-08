// ─── Cifra de credenciais Pluggy (AES-256-GCM, nível de aplicação) ────────────
//
// Usado para armazenar client_secret da Pluggy em repouso no Postgres.
// A chave mestra NUNCA fica no banco — só em PLUGGY_ENCRYPTION_KEY (.env do VPS).
//
// Formato de armazenamento (decisão documentada — ver checkpoint do Marco 1):
//   - coluna `iv`: IV de 12 bytes (padrão recomendado para GCM), em hex.
//   - coluna `client_secret_encrypted`: "<ciphertext hex>:<authTag hex>".
//     O authTag do GCM é obrigatório para decifrar (AEAD) e vai embutido nesse
//     mesmo campo em vez de ganhar coluna própria, para não expandir o schema
//     além do que foi especificado (id, usuario_id, client_id,
//     client_secret_encrypted, iv, criado_em, atualizado_em).
//
// Chave ausente: NÃO derruba o boot do processo (o Cronos inteiro — WhatsApp,
// painel, crons — não pode cair por causa de uma feature aditiva ainda não
// lançada). Mesmo padrão lazy já usado em jwtSecret() (src/webserver.js:45-49):
// o erro só aparece na hora de efetivamente usar a função, para quem tentar
// usar a feature Pluggy sem a chave configurada.

const crypto = require('crypto');

const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits — tamanho recomendado para GCM

function obterChave() {
  const chaveHex = process.env.PLUGGY_ENCRYPTION_KEY;
  if (!chaveHex) {
    throw new Error('PLUGGY_ENCRYPTION_KEY não configurada no .env — funcionalidade Pluggy indisponível');
  }
  const chave = Buffer.from(chaveHex, 'hex');
  if (chave.length !== 32) {
    throw new Error('PLUGGY_ENCRYPTION_KEY inválida — deve ter 32 bytes (64 caracteres hex)');
  }
  return chave;
}

// encriptar(texto) -> { iv, valorCifrado }
function encriptar(texto) {
  if (typeof texto !== 'string' || !texto) {
    throw new Error('Texto a encriptar deve ser uma string não vazia');
  }
  const chave = obterChave();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);
  const ciphertext = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    valorCifrado: `${ciphertext.toString('hex')}:${authTag.toString('hex')}`,
  };
}

// decriptar(valorCifrado, ivHex) -> texto original
function decriptar(valorCifrado, ivHex) {
  if (typeof valorCifrado !== 'string' || !valorCifrado.includes(':')) {
    throw new Error('valorCifrado em formato inválido');
  }
  if (typeof ivHex !== 'string' || !ivHex) {
    throw new Error('iv ausente ou inválido');
  }

  const chave = obterChave();
  const [ciphertextHex, authTagHex] = valorCifrado.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const texto = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(), // lança se o authTag não bater (integridade violada / chave errada)
  ]);
  return texto.toString('utf8');
}

module.exports = { encriptar, decriptar };
