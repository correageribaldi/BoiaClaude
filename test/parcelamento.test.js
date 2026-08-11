const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extrairParcelamento, chaveGrupoParcela, projetarParcelasRestantes, somarMeses,
} = require('../src/parcelamento');

// Todos os dados abaixo são SINTÉTICOS — nomes de loja inventados, valores
// redondos. Nada aqui vem de extrato real de usuário.

// ── extrairParcelamento ──────────────────────────────────────────────────────

test('extrairParcelamento: usa o campo estruturado da Pluggy quando existe', () => {
  const tx = {
    description: 'LOJA FICTICIA 7/10',
    creditCardMetadata: { installmentNumber: 7, totalInstallments: 10, totalAmount: 1000 },
  };
  assert.deepEqual(extrairParcelamento(tx, { ehCartao: true }), { atual: 7, total: 10, origem: 'metadata' });
});

test('extrairParcelamento: campo estruturado tem prioridade sobre a descrição divergente', () => {
  // Se os dois discordam, o dado do banco vale — a descrição é texto livre.
  const tx = {
    description: 'LOJA FICTICIA 2/3',
    creditCardMetadata: { installmentNumber: 7, totalInstallments: 10 },
  };
  const r = extrairParcelamento(tx, { ehCartao: true });
  assert.equal(r.atual, 7);
  assert.equal(r.total, 10);
  assert.equal(r.origem, 'metadata');
});

test('extrairParcelamento: sem creditCardMetadata, cai para a descrição em transação de CARTÃO', () => {
  const tx = { description: 'Farmacia Ficticia 2/3' };
  assert.deepEqual(extrairParcelamento(tx, { ehCartao: true }), { atual: 2, total: 3, origem: 'descricao' });
});

test('extrairParcelamento: em CONTA CORRENTE nunca usa a descrição (evita confundir data com parcela)', () => {
  // "Mensalidade 01/12" em conta corrente é competência, não parcela 1 de 12.
  const tx = { description: 'Mensalidade 01/12' };
  assert.equal(extrairParcelamento(tx, { ehCartao: false }), null);
  assert.equal(extrairParcelamento(tx), null, 'sem opção declarada, o padrão é não adivinhar');
});

test('extrairParcelamento: parcela entre parênteses (formato do próprio Cronos) também é lida', () => {
  assert.deepEqual(
    extrairParcelamento({ description: 'Notebook (3/6)' }, { ehCartao: true }),
    { atual: 3, total: 6, origem: 'descricao' }
  );
});

test('extrairParcelamento: compra à vista (totalInstallments 1) não é parcelamento', () => {
  const tx = { description: 'MERCADO FICTICIO', creditCardMetadata: { installmentNumber: 1, totalInstallments: 1 } };
  assert.equal(extrairParcelamento(tx, { ehCartao: true }), null);
});

test('extrairParcelamento: dado inconsistente é descartado (atual > total, zero, negativo)', () => {
  const casos = [
    { installmentNumber: 12, totalInstallments: 3 },
    { installmentNumber: 0, totalInstallments: 10 },
    { installmentNumber: -1, totalInstallments: 10 },
    { installmentNumber: 2, totalInstallments: 0 },
    { installmentNumber: 1.5, totalInstallments: 3 },
  ];
  for (const meta of casos) {
    assert.equal(
      extrairParcelamento({ description: 'LOJA FICTICIA', creditCardMetadata: meta }, { ehCartao: true }),
      null,
      `metadata inválido não pode virar parcelamento: ${JSON.stringify(meta)}`
    );
  }
});

test('extrairParcelamento: "12/03" no fim da descrição não vira parcela (atual maior que total)', () => {
  assert.equal(extrairParcelamento({ description: 'Servico Ficticio 12/03' }, { ehCartao: true }), null);
});

test('extrairParcelamento: transação sem nada devolve null, nunca lança', () => {
  assert.equal(extrairParcelamento(null, { ehCartao: true }), null);
  assert.equal(extrairParcelamento({}, { ehCartao: true }), null);
  assert.equal(extrairParcelamento({ description: 'PIX ENVIADO' }, { ehCartao: true }), null);
});

// ── chaveGrupoParcela ────────────────────────────────────────────────────────

test('chaveGrupoParcela: todas as parcelas da mesma compra caem na MESMA chave', () => {
  const chaves = new Set([
    chaveGrupoParcela('LOJA FICTICIA*PRODUTO 1/10', 10),
    chaveGrupoParcela('LOJA FICTICIA*PRODUTO 7/10', 10),
    chaveGrupoParcela('LOJA FICTICIA*PRODUTO 10/10', 10),
  ]);
  assert.equal(chaves.size, 1, 'o sufixo de parcela não pode entrar na chave');
});

test('chaveGrupoParcela: arredondamento de centavos na última parcela não quebra o grupo', () => {
  // O valor NÃO entra na chave justamente por isso — ver comentário do módulo.
  assert.equal(
    chaveGrupoParcela('LOJA FICTICIA 9/10', 10),
    chaveGrupoParcela('LOJA FICTICIA 10/10', 10)
  );
});

test('chaveGrupoParcela: número de parcelas diferente é grupo diferente', () => {
  assert.notEqual(chaveGrupoParcela('LOJA FICTICIA 2/3', 3), chaveGrupoParcela('LOJA FICTICIA 2/10', 10));
});

test('chaveGrupoParcela: descrição sem chave confiável devolve null', () => {
  assert.equal(chaveGrupoParcela('Compra no débito|', 3), null);
  assert.equal(chaveGrupoParcela('LOJA FICTICIA', 1), null, 'total abaixo de 2 não é parcelamento');
});

// ── somarMeses ───────────────────────────────────────────────────────────────

test('somarMeses: atravessa a virada de ano', () => {
  assert.equal(somarMeses('2026-11', 3), '2027-02');
  assert.equal(somarMeses('2026-12', 1), '2027-01');
  assert.equal(somarMeses('2026-08', 0), '2026-08');
});

// ── projetarParcelasRestantes — o coração do anti-dupla-contagem ─────────────

const JANELA = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];
const OPCOES = { chavesJanela: JANELA, mesAtual: '2026-08' };

function linha(over = {}) {
  return {
    cartao_id: 42,
    parcela_grupo: 'loja ficticia|10',
    parcela_atual: 7,
    parcela_total: 10,
    valor: 100,
    chave: '2026-08',
    ...over,
  };
}

test('banco que manda UMA parcela por vez: projeta só as que faltam, uma por mês', () => {
  const r = projetarParcelasRestantes([linha()], OPCOES);

  assert.deepEqual(r, { '2026-09': 100, '2026-10': 100, '2026-11': 100 });
});

test('banco que já manda TODAS as parcelas: não projeta nada (sem dupla contagem)', () => {
  // Cenário do comportamento (A) da Pluggy: as parcelas futuras já existem
  // como transação pendente e já entram pelo corte de faturas de cartão.
  const linhas = [];
  for (let k = 7; k <= 10; k++) {
    linhas.push(linha({ parcela_atual: k, chave: somarMeses('2026-08', k - 7) }));
  }

  const r = projetarParcelasRestantes(linhas, OPCOES);

  assert.deepEqual(r, {}, 'parcela que o banco já lançou não pode ser projetada de novo');
});

test('cenário misto: projeta apenas o mês que ainda não tem a parcela lançada', () => {
  // Banco mandou 7/10 (ago) e 8/10 (set), mas ainda não 9/10 e 10/10.
  const linhas = [
    linha({ parcela_atual: 7, chave: '2026-08' }),
    linha({ parcela_atual: 8, chave: '2026-09' }),
  ];

  const r = projetarParcelasRestantes(linhas, OPCOES);

  assert.deepEqual(r, { '2026-10': 100, '2026-11': 100 });
});

test('parcela já lançada num mês fora de ordem também suprime a projeção daquele mês', () => {
  // Defesa extra: mesmo que a referência seja 7/10, se outubro já tem linha do
  // grupo, outubro não pode receber projeção.
  const linhas = [
    linha({ parcela_atual: 7, chave: '2026-08' }),
    linha({ parcela_atual: 9, chave: '2026-10' }),
  ];

  const r = projetarParcelasRestantes(linhas, OPCOES);

  assert.equal(r['2026-10'], undefined, 'mês já ocupado pelo grupo não recebe projeção');
  assert.equal(r['2026-11'], 100, 'a parcela seguinte à referência (9/10) segue projetada');
});

test('mês anterior ao atual nunca é projetado (não inventa despesa no passado)', () => {
  const r = projetarParcelasRestantes(
    [linha({ parcela_atual: 5, chave: '2026-06' })],
    OPCOES
  );

  assert.equal(r['2026-06'], undefined);
  assert.equal(r['2026-07'], undefined);
  assert.equal(r['2026-08'], 100, 'a parcela que cai no mês corrente ainda vale');
  assert.equal(r['2026-09'], 100);
});

test('parcela fora da janela exibida é ignorada', () => {
  const r = projetarParcelasRestantes(
    [linha({ parcela_atual: 1, parcela_total: 24, parcela_grupo: 'loja ficticia|24' })],
    OPCOES
  );

  assert.deepEqual(Object.keys(r).sort(), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
});

test('fatura real já lançada no mês bloqueia a projeção daquele cartão/mês', () => {
  const r = projetarParcelasRestantes([linha()], {
    ...OPCOES,
    faturaJaLancada: new Set(['42|2026-09']),
  });

  assert.equal(r['2026-09'], undefined, 'a fatura lançada já contém essa parcela');
  assert.equal(r['2026-10'], 100);
});

test('cartões diferentes com o mesmo estabelecimento são grupos independentes', () => {
  const linhas = [
    linha({ cartao_id: 42, valor: 100 }),
    linha({ cartao_id: 43, valor: 250 }),
  ];

  const r = projetarParcelasRestantes(linhas, OPCOES);

  assert.equal(r['2026-09'], 350, 'as duas compras somam no mesmo mês');
});

test('linhas sem parcela_grupo ou com parcelamento inválido são ignoradas', () => {
  const linhas = [
    linha({ parcela_grupo: null }),
    linha({ parcela_atual: null }),
    linha({ parcela_total: 1 }),
    linha({ parcela_atual: 11, parcela_total: 10 }),
    linha({ chave: null }),
  ];

  assert.deepEqual(projetarParcelasRestantes(linhas, OPCOES), {});
});

test('valor zerado ou negativo não vira projeção', () => {
  assert.deepEqual(projetarParcelasRestantes([linha({ valor: 0 })], OPCOES), {});
  assert.deepEqual(projetarParcelasRestantes([linha({ valor: -100 })], OPCOES), {});
});

test('entrada vazia devolve objeto vazio, nunca lança', () => {
  assert.deepEqual(projetarParcelasRestantes([], OPCOES), {});
  assert.deepEqual(projetarParcelasRestantes(null, OPCOES), {});
  assert.deepEqual(projetarParcelasRestantes([linha()], {}), {}, 'sem janela não há o que projetar');
});
