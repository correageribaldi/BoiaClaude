// normalizarEstabelecimento é o coração do aprendizado de categoria: a mesma
// função gera a chave na gravação (usuário corrige) e na leitura (sync
// decide). Se as duas pontas divergirem, a feature falha em SILÊNCIO — nada
// quebra, só nunca aprende. Daí a cobertura detalhada aqui.
//
// Todos os casos abaixo reproduzem PADRÕES DE FORMATO reais das descrições que
// a Pluggy devolve, com nomes fictícios (nenhum dado de usuário real).

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizarEstabelecimento } = require('../src/estabelecimento');

// ── Padrões reais de descrição da Pluggy ────────────────────────────────────

const CASOS_REAIS = [
  // prefixo operacional com "|"
  ['Compra no débito|MERCADO FICTICIO', 'mercado ficticio'],
  ['Compra no crédito|MERCADO FICTICIO', 'mercado ficticio'],
  // prefixo operacional + marcador de gateway
  ['Compra no débito|IFD*PIZZARIA DO ZE L', 'pizzaria do ze l'],
  // transferência (nome de pessoa como contraparte)
  ['Transferência enviada|FULANO DE TAL', 'fulano de tal'],
  ['Transferência Recebida|FULANO DE TAL', 'fulano de tal'],
  // descrição simples, sem prefixo nenhum
  ['Uber', 'uber'],
  // marca com "*" no próprio nome — NÃO é marcador de gateway
  ['Empresa* Assinatura Mensal', 'empresa* assinatura mensal'],
  // descrições operacionais do banco
  ['Pagamento de fatura', 'pagamento de fatura'],
  ['IOF de compra internacional', 'iof de compra internacional'],
  // gateway + sufixo de parcela
  ['Xyz*Loja Online-Ns2com In 1/4', 'loja online-ns2com in'],
];

for (const [descricao, esperado] of CASOS_REAIS) {
  test(`normalizarEstabelecimento: "${descricao}" -> "${esperado}"`, () => {
    assert.equal(normalizarEstabelecimento(descricao), esperado);
  });
}

// ── Propriedades que a feature depende ──────────────────────────────────────

test('débito e crédito no mesmo estabelecimento geram a MESMA chave', () => {
  assert.equal(
    normalizarEstabelecimento('Compra no débito|PADARIA DO BAIRRO'),
    normalizarEstabelecimento('Compra no crédito|PADARIA DO BAIRRO')
  );
});

test('todas as parcelas da mesma compra geram a MESMA chave', () => {
  const chave = normalizarEstabelecimento('Xyz*Loja Online-Ns2com In 1/4');
  for (const parcela of ['2/4', '3/4', '4/4', '12/12']) {
    assert.equal(
      normalizarEstabelecimento(`Xyz*Loja Online-Ns2com In ${parcela}`),
      chave,
      `parcela ${parcela} deveria cair na mesma chave`
    );
  }
});

test('parcela entre parênteses também é removida', () => {
  assert.equal(normalizarEstabelecimento('LOJA EXEMPLO (3/6)'), 'loja exemplo');
});

test('estabelecimentos diferentes NÃO colidem', () => {
  assert.notEqual(
    normalizarEstabelecimento('Compra no débito|MERCADO FICTICIO'),
    normalizarEstabelecimento('Compra no débito|MERCADO FICTICIO DOIS')
  );
});

test('caixa, acento e espaço duplicado não mudam a chave', () => {
  const variacoes = [
    'Compra no débito|CAFÉ  CENTRAL',
    'compra no debito|café central',
    'COMPRA NO DÉBITO|Cafe   Central',
  ];
  const chaves = new Set(variacoes.map(normalizarEstabelecimento));
  assert.equal(chaves.size, 1, `esperava uma chave só, veio ${[...chaves].join(' | ')}`);
  assert.equal([...chaves][0], 'cafe central');
});

test('cedilha vira c (normalização de acento cobre ç)', () => {
  assert.equal(normalizarEstabelecimento('Transferência enviada|CONSTRUÇÃO LTDA'), 'construcao ltda');
});

test('gateways encadeados são removidos até sobrar o estabelecimento', () => {
  assert.equal(normalizarEstabelecimento('Aaa*Bbb*LOJA EXEMPLO'), 'loja exemplo');
});

// ── Casos em que é melhor NÃO aprender (retorna null) ───────────────────────

test('descrição vazia ou sem contraparte depois do "|" não gera chave', () => {
  assert.equal(normalizarEstabelecimento(''), null);
  assert.equal(normalizarEstabelecimento('   '), null);
  assert.equal(normalizarEstabelecimento('|'), null);
  // operação conhecida, estabelecimento não — aprender aqui viraria
  // "toda compra no débito sem contraparte é X"
  assert.equal(normalizarEstabelecimento('Compra no débito|'), null);
  assert.equal(normalizarEstabelecimento('Transferência enviada|   '), null);
});

test('entrada que não é string não quebra — retorna null', () => {
  assert.equal(normalizarEstabelecimento(null), null);
  assert.equal(normalizarEstabelecimento(undefined), null);
  assert.equal(normalizarEstabelecimento(42), null);
  assert.equal(normalizarEstabelecimento({}), null);
});

test('chave curta demais é genérica demais para aprender', () => {
  assert.equal(normalizarEstabelecimento('ok'), null);
  assert.equal(normalizarEstabelecimento('Compra no débito|SP'), null);
});

test('descrição só com dígitos/pontuação (id de operação) não vira chave', () => {
  assert.equal(normalizarEstabelecimento('Transferência enviada|000123456789'), null);
  assert.equal(normalizarEstabelecimento('---'), null);
});

// ── Determinismo (pureza) ───────────────────────────────────────────────────

test('a função é pura: mesma entrada, mesma saída, sem efeito colateral', () => {
  const entrada = 'Compra no débito|IFD*PIZZARIA DO ZE L';
  const original = entrada;
  const primeira = normalizarEstabelecimento(entrada);
  const segunda = normalizarEstabelecimento(entrada);
  assert.equal(primeira, segunda);
  assert.equal(entrada, original, 'não pode mutar a entrada');
});
