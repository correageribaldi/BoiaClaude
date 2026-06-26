'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paraFala, limparTexto, extrairPartes } = require('../src/render/voice');

// ── limparTexto ────────────────────────────────────────────────────────────────

test('limparTexto remove negrito WhatsApp', () => {
  assert.equal(limparTexto('*Saldo* atual'), 'Saldo atual');
});

test('limparTexto remove itálico WhatsApp', () => {
  assert.equal(limparTexto('_despesa_ do mês'), 'despesa do mês');
});

test('limparTexto remove backtick', () => {
  assert.equal(limparTexto('valor: `R$ 100`'), 'valor: R$ 100');
});

test('limparTexto remove citação WhatsApp', () => {
  assert.equal(limparTexto('> texto citado\nresposta'), 'texto citado\nresposta');
});

test('limparTexto substitui emoji ✅ por confirmado', () => {
  const out = limparTexto('✅ Transação registrada');
  assert.ok(out.includes('confirmado'), `esperado "confirmado" em: ${out}`);
  assert.ok(!out.includes('✅'), `emoji não deveria estar em: ${out}`);
});

test('limparTexto remove emoji decorativo 🚀', () => {
  const out = limparTexto('Meta atingida 🚀');
  assert.ok(!out.includes('🚀'), `emoji não deveria estar em: ${out}`);
});

test('limparTexto remove caracteres especiais residuais pela rede de segurança', () => {
  // Forçar algo que passe pelos substitutos mas ainda tenha marcadores
  const out = limparTexto('*texto* _ainda_ >citação');
  assert.ok(!/[*_>~]/.test(out), `marcadores não deveriam estar em: ${out}`);
});

// ── extrairPartes ──────────────────────────────────────────────────────────────

test('extrairPartes: string retorna parte única', () => {
  const { partes } = extrairPartes('olá mundo');
  assert.deepEqual(partes, ['olá mundo']);
});

test('extrairPartes: { msg, semCitacao } retorna msg', () => {
  const { partes } = extrairPartes({ msg: 'resposta sem citação', semCitacao: true });
  assert.deepEqual(partes, ['resposta sem citação']);
});

test('extrairPartes: { texto, grafico } retorna texto, descarta grafico', () => {
  const { partes } = extrairPartes({ texto: 'resumo do mês', grafico: Buffer.from('fake') });
  assert.deepEqual(partes, ['resumo do mês']);
});

test('extrairPartes: { texto, notificarContatos } retorna texto', () => {
  const { partes } = extrairPartes({ texto: 'aviso', notificarContatos: ['111@c.us'] });
  assert.deepEqual(partes, ['aviso']);
});

test('extrairPartes: array concatena partes', () => {
  const { partes } = extrairPartes([
    'parte 1',
    { msg: 'parte 2', semCitacao: true },
    { texto: 'parte 3', grafico: null },
  ]);
  assert.equal(partes.length, 3);
  assert.equal(partes[0], 'parte 1');
  assert.equal(partes[1], 'parte 2');
  assert.equal(partes[2], 'parte 3');
});

// ── paraFala ───────────────────────────────────────────────────────────────────

test('paraFala: string simples retorna SSML com <speak>', () => {
  const { speech } = paraFala('Olá, mundo!');
  assert.ok(speech.startsWith('<speak>'), `deve começar com <speak>: ${speech}`);
  assert.ok(speech.endsWith('</speak>'), `deve terminar com </speak>: ${speech}`);
  assert.ok(speech.includes('Olá, mundo!'), `deve conter o texto: ${speech}`);
});

test('paraFala: quebras de parágrafo viram <break time="500ms"/>', () => {
  const { speech } = paraFala('Parte um.\n\nParte dois.');
  assert.ok(speech.includes('<break time="500ms"/>'), `deve conter break: ${speech}`);
});

test('paraFala: retorna card com title=Cronos', () => {
  const { card } = paraFala('qualquer coisa');
  assert.equal(card.title, 'Cronos');
  assert.ok(typeof card.content === 'string');
});

test('paraFala: { texto, grafico } descarta gráfico e usa texto', () => {
  const { speech, card } = paraFala({ texto: 'Seu resumo mensal.', grafico: Buffer.from('png') });
  assert.ok(speech.includes('Seu resumo mensal.'));
  assert.ok(card.content.includes('Seu resumo mensal.'));
});

test('paraFala: array de respostas concatena com pausa', () => {
  const { speech } = paraFala(['Primeira resposta.', 'Segunda resposta.']);
  assert.ok(speech.includes('<break time="500ms"/>'), `deve conter break entre partes: ${speech}`);
  assert.ok(speech.includes('Primeira resposta.'));
  assert.ok(speech.includes('Segunda resposta.'));
});

test('paraFala: resposta vazia retorna fala de fallback', () => {
  const { speech } = paraFala('');
  assert.ok(speech.includes('<speak>'), `deve ter speak: ${speech}`);
  assert.ok(speech.includes('Pronto'), `deve ter fallback "Pronto": ${speech}`);
});

test('paraFala: markdown WhatsApp completo é limpo antes da fala', () => {
  const entrada = '*Total do mês:* R$ 1.200\n\n_Despesas_: R$ 800\n\n> Baseado nos últimos 30 dias.';
  const { speech, card } = paraFala(entrada);
  // Checar o card (texto plano) — não deve ter marcadores WhatsApp
  assert.ok(!/[*_~]/.test(card.content), `marcadores não deveriam estar no card: ${card.content}`);
  assert.ok(!card.content.startsWith('>'), `citação não deveria estar no card: ${card.content}`);
  assert.ok(speech.includes('Total do mês'), `deve conter texto sem marcadores: ${speech}`);
  assert.ok(!speech.includes('*'), `asterisco não deveria estar no SSML: ${speech}`);
  assert.ok(!speech.includes('_Total'), `itálico não deveria estar no SSML: ${speech}`);
});

test('paraFala: { msg, semCitacao } usa msg no speech', () => {
  const { speech } = paraFala({ msg: 'Despesa registrada.', semCitacao: true });
  assert.ok(speech.includes('Despesa registrada.'), `deve conter msg: ${speech}`);
});
