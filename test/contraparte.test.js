// Chave de teste — NÃO é segredo real (mesmo padrão dos demais testes).
process.env.PLUGGY_ENCRYPTION_KEY = 'a'.repeat(64);

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashContraparte, hashDocumento, documentoDaContraparte, normalizarDocumento,
} = require('../src/contraparte');

// TODOS os documentos abaixo são sintéticos e inválidos como CPF/CNPJ real
// (dígito verificador não confere de propósito) — só têm o formato certo.
const CPF_A = '111.222.333-96';
const CPF_A_SEM_MASCARA = '11122233396';
const CPF_B = '444.555.666-07';
const CNPJ_A = '11.222.333/0001-81';

// ── normalizarDocumento ──────────────────────────────────────────────────────

test('normalizarDocumento: tira máscara e aceita CPF (11) e CNPJ (14)', () => {
  assert.equal(normalizarDocumento(CPF_A), '11122233396');
  assert.equal(normalizarDocumento(CNPJ_A), '11222333000181');
  assert.equal(normalizarDocumento('  111 222 333 96 '), '11122233396');
});

test('normalizarDocumento: recusa o que não tem cara de documento', () => {
  for (const valor of ['', '000', 'N/A', '1234567', '123456789012345678', null, undefined, {}]) {
    assert.equal(normalizarDocumento(valor), null, `não deveria aceitar: ${JSON.stringify(valor)}`);
  }
});

test('normalizarDocumento: recusa preenchimento genérico de sistema bancário', () => {
  assert.equal(normalizarDocumento('00000000000'), null);
  assert.equal(normalizarDocumento('99999999999999'), null);
});

// ── hashDocumento ────────────────────────────────────────────────────────────

test('hashDocumento: mesmo documento gera sempre a mesma chave', () => {
  assert.equal(hashDocumento(CPF_A), hashDocumento(CPF_A));
});

test('hashDocumento: máscara não muda a chave (é o mesmo documento)', () => {
  assert.equal(hashDocumento(CPF_A), hashDocumento(CPF_A_SEM_MASCARA));
});

test('hashDocumento: documentos diferentes geram chaves diferentes', () => {
  const chaves = new Set([hashDocumento(CPF_A), hashDocumento(CPF_B), hashDocumento(CNPJ_A)]);
  assert.equal(chaves.size, 3, 'não pode haver colisão entre documentos distintos');
});

test('hashDocumento: a saída não contém o documento nem parte dele', () => {
  const hash = hashDocumento(CPF_A);
  assert.match(hash, /^[0-9a-f]{64}$/, 'deve ser hex de SHA-256');
  assert.equal(hash.includes('11122233396'), false);
  for (const pedaco of ['111222', '22333', '33396']) {
    assert.equal(hash.includes(pedaco), false, `hash não pode conter "${pedaco}"`);
  }
});

test('hashDocumento: chave mestra diferente produz hash diferente (não é SHA-256 puro)', () => {
  const original = process.env.PLUGGY_ENCRYPTION_KEY;
  const comChaveA = hashDocumento(CPF_A);
  process.env.PLUGGY_ENCRYPTION_KEY = 'b'.repeat(64);
  const comChaveB = hashDocumento(CPF_A);
  process.env.PLUGGY_ENCRYPTION_KEY = original;

  assert.notEqual(comChaveA, comChaveB,
    'sem segredo no hash, o espaço de CPF (10^11) seria revertido por força bruta');
  assert.equal(hashDocumento(CPF_A), comChaveA, 'voltando a chave, a chave de aprendizado volta a bater');
});

test('hashDocumento: sem chave mestra configurada devolve null (nunca grava hash fraco)', () => {
  const original = process.env.PLUGGY_ENCRYPTION_KEY;
  delete process.env.PLUGGY_ENCRYPTION_KEY;
  assert.equal(hashDocumento(CPF_A), null);

  process.env.PLUGGY_ENCRYPTION_KEY = 'chave-curta-invalida';
  assert.equal(hashDocumento(CPF_A), null, 'chave de tamanho errado também desliga a feature');

  process.env.PLUGGY_ENCRYPTION_KEY = original;
});

test('hashDocumento: documento inválido devolve null, nunca lança', () => {
  assert.equal(hashDocumento(null), null);
  assert.equal(hashDocumento('12345'), null);
});

// ── documentoDaContraparte / hashContraparte ────────────────────────────────

const PAYMENT_DATA = {
  payer:    { name: 'PAGADOR FICTICIO', documentNumber: { type: 'CPF', value: CPF_A } },
  receiver: { name: 'RECEBEDOR FICTICIO', documentNumber: { type: 'CNPJ', value: CNPJ_A } },
};

test('documentoDaContraparte: em DESPESA a contraparte é quem recebeu', () => {
  assert.equal(documentoDaContraparte(PAYMENT_DATA, 'despesa'), CNPJ_A);
});

test('documentoDaContraparte: em RECEITA a contraparte é quem pagou', () => {
  assert.equal(documentoDaContraparte(PAYMENT_DATA, 'receita'), CPF_A);
});

test('hashContraparte: despesa e receita do mesmo paymentData não geram a mesma chave', () => {
  assert.notEqual(hashContraparte(PAYMENT_DATA, 'despesa'), hashContraparte(PAYMENT_DATA, 'receita'));
});

test('hashContraparte: sem paymentData (compra no cartão, por exemplo) devolve null', () => {
  assert.equal(hashContraparte(null, 'despesa'), null);
  assert.equal(hashContraparte({}, 'despesa'), null);
  assert.equal(hashContraparte({ receiver: {} }, 'despesa'), null);
  assert.equal(hashContraparte({ receiver: { documentNumber: {} } }, 'despesa'), null);
});

test('hashContraparte: a mesma contraparte em lançamentos com descrições diferentes cai na mesma chave', () => {
  // É exatamente o ganho da feature sobre a chave textual.
  const lancamento1 = { receiver: { name: 'JOAO S FICTICIO', documentNumber: { type: 'CPF', value: CPF_A } } };
  const lancamento2 = { receiver: { name: 'JOAO DA SILVA FICTICIA ME', documentNumber: { type: 'CPF', value: CPF_A_SEM_MASCARA } } };

  assert.equal(hashContraparte(lancamento1, 'despesa'), hashContraparte(lancamento2, 'despesa'));
});
