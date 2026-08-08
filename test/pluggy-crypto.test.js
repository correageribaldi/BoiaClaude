const test = require('node:test');
const assert = require('node:assert/strict');

// Chave de teste — 32 bytes em hex. NÃO é segredo real, é fixture de teste.
const CHAVE_TESTE_A = 'a'.repeat(64);
const CHAVE_TESTE_B = 'b'.repeat(64);

function comChave(chaveHex, fn) {
  const anterior = process.env.PLUGGY_ENCRYPTION_KEY;
  process.env.PLUGGY_ENCRYPTION_KEY = chaveHex;
  delete require.cache[require.resolve('../src/pluggyCrypto')];
  try {
    return fn(require('../src/pluggyCrypto'));
  } finally {
    if (anterior === undefined) delete process.env.PLUGGY_ENCRYPTION_KEY;
    else process.env.PLUGGY_ENCRYPTION_KEY = anterior;
    delete require.cache[require.resolve('../src/pluggyCrypto')];
  }
}

test('encriptar/decriptar: round-trip preserva o texto original', () => {
  comChave(CHAVE_TESTE_A, ({ encriptar, decriptar }) => {
    const original = 'segredo-de-teste-nao-real-123';
    const { iv, valorCifrado } = encriptar(original);

    assert.ok(iv.length === 24, 'IV de 12 bytes deve virar 24 chars em hex');
    assert.ok(valorCifrado.includes(':'), 'valorCifrado deve conter ciphertext:authTag');
    assert.notEqual(valorCifrado, original, 'valor cifrado nunca deve igualar o texto plano');

    const decifrado = decriptar(valorCifrado, iv);
    assert.equal(decifrado, original);
  });
});

test('encriptar: dois registros do mesmo texto geram IVs diferentes (sem reuso)', () => {
  comChave(CHAVE_TESTE_A, ({ encriptar }) => {
    const a = encriptar('mesmo-texto');
    const b = encriptar('mesmo-texto');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.valorCifrado, b.valorCifrado);
  });
});

test('decriptar: chave diferente da usada para encriptar falha (não decifra silenciosamente)', () => {
  const { iv, valorCifrado } = comChave(CHAVE_TESTE_A, ({ encriptar }) => encriptar('valor-sensivel'));

  comChave(CHAVE_TESTE_B, ({ decriptar }) => {
    assert.throws(() => decriptar(valorCifrado, iv));
  });
});

test('decriptar: authTag corrompido (payload adulterado) falha', () => {
  comChave(CHAVE_TESTE_A, ({ encriptar, decriptar }) => {
    const { iv, valorCifrado } = encriptar('valor-original');
    const [ciphertext, authTag] = valorCifrado.split(':');
    const authTagAdulterado = authTag.slice(0, -2) + (authTag.slice(-2) === '00' ? '11' : '00');
    assert.throws(() => decriptar(`${ciphertext}:${authTagAdulterado}`, iv));
  });
});

test('encriptar: sem PLUGGY_ENCRYPTION_KEY lança erro claro (não deixa gravar sem proteção)', () => {
  const anterior = process.env.PLUGGY_ENCRYPTION_KEY;
  delete process.env.PLUGGY_ENCRYPTION_KEY;
  delete require.cache[require.resolve('../src/pluggyCrypto')];
  try {
    const { encriptar } = require('../src/pluggyCrypto');
    assert.throws(() => encriptar('qualquer-coisa'), /PLUGGY_ENCRYPTION_KEY/);
  } finally {
    if (anterior === undefined) delete process.env.PLUGGY_ENCRYPTION_KEY;
    else process.env.PLUGGY_ENCRYPTION_KEY = anterior;
    delete require.cache[require.resolve('../src/pluggyCrypto')];
  }
});

test('encriptar: chave com tamanho inválido (não 32 bytes) lança erro claro', () => {
  comChave('abcd', ({ encriptar }) => {
    assert.throws(() => encriptar('qualquer-coisa'), /32 bytes/);
  });
});

test('encriptar: recusa string vazia', () => {
  comChave(CHAVE_TESTE_A, ({ encriptar }) => {
    assert.throws(() => encriptar(''));
  });
});
