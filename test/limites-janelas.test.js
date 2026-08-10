// Janelas de controle de limite: semana ISO (segunda a domingo) e mês.
// A semana ISO foi escolhida por não deslizar com o mês — ver o bloco de
// decisão em src/database.js (seção "Janelas de controle de limite").

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'a'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

test('semana ISO: segunda a domingo, para qualquer dia da semana', () => {
  // 2026-08-05 é uma quarta-feira. Segunda = 03, domingo = 09.
  for (const dia of ['2026-08-03', '2026-08-05', '2026-08-09']) {
    assert.equal(db.inicioSemanaISO(dia), '2026-08-03', `início errado para ${dia}`);
    assert.equal(db.fimSemanaISO(dia), '2026-08-09', `fim errado para ${dia}`);
  }
});

test('semana ISO: segunda seguinte já é outra janela (virada de semana)', () => {
  assert.equal(db.inicioSemanaISO('2026-08-09'), '2026-08-03', 'domingo ainda é a semana anterior');
  assert.equal(db.inicioSemanaISO('2026-08-10'), '2026-08-10', 'segunda abre janela nova');
  assert.notEqual(db.chaveSemanaISO('2026-08-09'), db.chaveSemanaISO('2026-08-10'));
});

test('semana ISO: janela atravessa a virada de mês sem se partir', () => {
  // 2026-08-31 é segunda; a semana vai até 2026-09-06 (mês seguinte).
  assert.equal(db.inicioSemanaISO('2026-09-02'), '2026-08-31');
  assert.equal(db.fimSemanaISO('2026-08-31'), '2026-09-06');
  assert.equal(
    db.chaveSemanaISO('2026-08-31'),
    db.chaveSemanaISO('2026-09-06'),
    'mesma semana ISO dos dois lados da virada de mês'
  );
});

test('semana ISO: virada de ano usa o ano ISO (semana única, não duas metades)', () => {
  // 2025-12-29 (segunda) a 2026-01-04 (domingo) é a semana 1 de 2026 pelo ISO.
  assert.equal(db.chaveSemanaISO('2025-12-29'), '2026-W01');
  assert.equal(db.chaveSemanaISO('2026-01-04'), '2026-W01');
  assert.equal(db.inicioSemanaISO('2026-01-01'), '2025-12-29');
});

test('semana ISO: numeração bate com a referência do padrão', () => {
  assert.equal(db.chaveSemanaISO('2026-01-05'), '2026-W02');
  assert.equal(db.chaveSemanaISO('2026-08-05'), '2026-W32');
  // 2027-01-01 é sexta → ainda pertence à semana 53 de 2026.
  assert.equal(db.chaveSemanaISO('2027-01-01'), '2026-W53');
});

test('janelasDeControle: mês vai do dia 1 ao último dia, inclusive fevereiro bissexto', () => {
  const agosto = db.janelasDeControle('2026-08-15');
  assert.equal(agosto.mes.inicio, '2026-08-01');
  assert.equal(agosto.mes.fim, '2026-08-31');
  assert.equal(agosto.mes.chave, '2026-08');

  const fev = db.janelasDeControle('2028-02-10'); // 2028 é bissexto
  assert.equal(fev.mes.fim, '2028-02-29');

  const fevComum = db.janelasDeControle('2026-02-10');
  assert.equal(fevComum.mes.fim, '2026-02-28');
});

test('janelasDeControle: virada de mês troca a chave (reset natural do anti-repetição)', () => {
  assert.equal(db.janelasDeControle('2026-08-31').mes.chave, '2026-08');
  assert.equal(db.janelasDeControle('2026-09-01').mes.chave, '2026-09');
});

test('faixaDeAlerta: degraus 60 / 80 / 100, com 0 abaixo de 60', () => {
  assert.equal(db.faixaDeAlerta(0), 0);
  assert.equal(db.faixaDeAlerta(59), 0);
  assert.equal(db.faixaDeAlerta(60), 60);
  assert.equal(db.faixaDeAlerta(79), 60);
  assert.equal(db.faixaDeAlerta(80), 80);
  assert.equal(db.faixaDeAlerta(99), 80);
  assert.equal(db.faixaDeAlerta(100), 100);
  assert.equal(db.faixaDeAlerta(240), 100);
});
