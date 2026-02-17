const test = require('node:test');
const assert = require('node:assert/strict');
const fmt = require('../src/formatters');

test('formatarData converte YYYY-MM-DD para DD/MM/YYYY', () => {
  assert.equal(fmt.formatarData('2026-02-17'), '17/02/2026');
});

test('formatarMoeda retorna string em BRL', () => {
  const out = fmt.formatarMoeda(1234.56);
  assert.ok(out.includes('R$'));
  assert.ok(out.includes('1.234,56'));
});

test('formatarListaTransacoes vazio retorna mensagem de lista vazia', () => {
  const out = fmt.formatarListaTransacoes([]);
  assert.ok(out.includes('Nenhum'));
});

test('formatarListaTransacoes com itens exibe id e descricao', () => {
  const out = fmt.formatarListaTransacoes([
    {
      id: 7,
      tipo: 'despesa',
      data: '2026-02-17',
      valor: 80,
      status: 'pago',
      descricao: 'Aluguel',
      categoria: 'Moradia',
    },
  ]);
  assert.ok(out.includes('#7'));
  assert.ok(out.includes('Aluguel'));
});
