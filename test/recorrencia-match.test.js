const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JANELA_DIAS_PADRAO,
  descricaoEquivalente,
  dentroDaJanela,
  janelaEncerradaEm,
  limitesDaJanela,
  faixaDaRegra,
  tetoDoBalde,
  cabeNoTeto,
  baldeFechado,
  filtrarRecorrenciasCompativeis,
  escolherRecorrencia,
} = require('../src/recorrencia-match');

// Todos os dados abaixo são SINTÉTICOS. Nomes fictícios, valores inventados.

// Regra mensal padrão dos testes: janela do dia 1 ao dia 10, receita de
// R$ 1.850,00 (que nos testes de acumulação chega como 1.500 + 350).
function regraMensal(extra = {}) {
  return {
    id: 1,
    tipo: 'receita',
    valor: 1850,
    descricao: 'Transferência Recebida|Fulano De Tal',
    frequencia: 'mensal',
    dia_mes: 5,
    dia_semana: null,
    dia_inicial: 1,
    dia_limite: 10,
    data_inicio: '2026-01-05',
    data_fim: null,
    ativo: true,
    ...extra,
  };
}

function lancamento(extra = {}) {
  return {
    tipo: 'receita',
    valor: 1500,
    descricao: 'Transferência Recebida|Fulano De Tal',
    data: '2026-09-05',
    ...extra,
  };
}

// ── descricaoEquivalente ─────────────────────────────────────────────────────

test('descricaoEquivalente: mesma contraparte com caixa/acento diferentes casa', () => {
  assert.equal(
    descricaoEquivalente('Transferência Recebida|FULANO DE TAL', 'transferencia recebida|Fulano de Tal'),
    true
  );
});

test('descricaoEquivalente: contrapartes diferentes não casam', () => {
  assert.equal(
    descricaoEquivalente('Transferência Recebida|Fulano De Tal', 'Transferência Recebida|Sicrano Silva'),
    false
  );
});

test('descricaoEquivalente: descrição sem chave confiável nunca casa (nem com ela mesma)', () => {
  // Contraparte vazia — normalizarEstabelecimento devolve null de propósito.
  assert.equal(descricaoEquivalente('Compra no débito|', 'Compra no débito|'), false);
});

// ── limitesDaJanela ──────────────────────────────────────────────────────────

test('limitesDaJanela: usa a janela explícita da regra', () => {
  assert.deepEqual(limitesDaJanela(regraMensal({ dia_inicial: 3, dia_limite: 12 }), 2026, 9), { inicio: 3, limite: 12 });
});

test('limitesDaJanela: regra antiga sem janela cai no dia_mes ± padrão', () => {
  const antiga = regraMensal({ dia_inicial: null, dia_limite: null, dia_mes: 10 });
  assert.deepEqual(limitesDaJanela(antiga, 2026, 9), { inicio: 5, limite: 15 });
  assert.equal(JANELA_DIAS_PADRAO, 5);
});

test('limitesDaJanela: grampeia dentro do mês (dia 31 em fevereiro vira o último dia)', () => {
  assert.deepEqual(limitesDaJanela(regraMensal({ dia_inicial: 25, dia_limite: 31 }), 2026, 2), { inicio: 25, limite: 28 });
  assert.deepEqual(limitesDaJanela(regraMensal({ dia_inicial: 1, dia_limite: 31 }), 2026, 4), { inicio: 1, limite: 30 });
});

test('limitesDaJanela: regra sem janela e sem dia_mes não tem limites', () => {
  assert.equal(limitesDaJanela(regraMensal({ dia_inicial: null, dia_limite: null, dia_mes: null }), 2026, 9), null);
});

// ── dentroDaJanela ───────────────────────────────────────────────────────────

test('dentroDaJanela: aceita do dia inicial ao dia limite, inclusive', () => {
  const regra = regraMensal({ dia_inicial: 1, dia_limite: 10 });
  for (const dia of ['01', '05', '10']) {
    assert.equal(dentroDaJanela(regra, `2026-09-${dia}`), true, `dia ${dia} deveria estar na janela`);
  }
});

test('dentroDaJanela: recusa fora da janela, dos dois lados', () => {
  const regra = regraMensal({ dia_inicial: 3, dia_limite: 10 });
  assert.equal(dentroDaJanela(regra, '2026-09-02'), false);
  assert.equal(dentroDaJanela(regra, '2026-09-11'), false);
});

test('dentroDaJanela: janela nunca atravessa a virada do mês', () => {
  // O balde é (recorrência, mês). Um lançamento em 31/08 pertence ao balde de
  // agosto, por mais perto que esteja da janela de setembro.
  const regra = regraMensal({ dia_inicial: 1, dia_limite: 5 });
  assert.equal(dentroDaJanela(regra, '2026-08-31'), false);
  assert.equal(dentroDaJanela(regra, '2026-09-01'), true);
});

test('dentroDaJanela: semanal só aceita ±1 dia do dia da semana da regra', () => {
  // 2026-09-07 é uma segunda-feira (dia_semana 1).
  const regra = regraMensal({ frequencia: 'semanal', dia_mes: null, dia_semana: 1, dia_inicial: null, dia_limite: null });
  assert.equal(dentroDaJanela(regra, '2026-09-07'), true, 'segunda');
  assert.equal(dentroDaJanela(regra, '2026-09-08'), true, 'terça');
  assert.equal(dentroDaJanela(regra, '2026-09-06'), true, 'domingo (distância circular 1)');
  assert.equal(dentroDaJanela(regra, '2026-09-09'), false, 'quarta');
});

test('dentroDaJanela: diário aceita qualquer data (todo dia é dia esperado)', () => {
  const regra = regraMensal({ frequencia: 'diario', dia_mes: null, dia_inicial: null, dia_limite: null });
  assert.equal(dentroDaJanela(regra, '2026-09-17'), true);
});

test('dentroDaJanela: anual exige o mês da regra (dia_semana carrega o mês, como na projeção)', () => {
  const regra = regraMensal({ frequencia: 'anual', dia_mes: 10, dia_semana: 9, dia_inicial: 8, dia_limite: 12 });
  assert.equal(dentroDaJanela(regra, '2026-09-12'), true);
  assert.equal(dentroDaJanela(regra, '2026-10-10'), false, 'mês errado');
});

test('dentroDaJanela: frequência desconhecida não casa', () => {
  assert.equal(dentroDaJanela(regraMensal({ frequencia: 'quinzenal' }), '2026-09-05'), false);
});

// ── janelaEncerradaEm ────────────────────────────────────────────────────────

test('janelaEncerradaEm: verdadeiro só depois do dia limite daquele mês', () => {
  const regra = regraMensal({ dia_inicial: 1, dia_limite: 10 });
  assert.equal(janelaEncerradaEm(regra, '2026-09-10'), false, 'o próprio dia limite ainda acumula');
  assert.equal(janelaEncerradaEm(regra, '2026-09-11'), true);
});

test('janelaEncerradaEm: semanal/diária não encerram por data de mês', () => {
  const semanal = regraMensal({ frequencia: 'semanal', dia_semana: 1, dia_inicial: null, dia_limite: null });
  assert.equal(janelaEncerradaEm(semanal, '2026-09-28'), false);
});

// ── filtrarRecorrenciasCompativeis ───────────────────────────────────────────

test('casa por origem + tipo + janela', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ data: '2026-09-08' }));
  assert.deepEqual(compativeis.map(r => r.id), [1]);
});

test('valor diferente do previsto CASA — é o que permite acumular parcial', () => {
  // R$ 1.500 contra uma regra de R$ 1.850: a diferença é o que ainda falta,
  // não motivo para recusar o vínculo.
  const regras = [regraMensal({ valor: 1850 })];
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 1500 })).length, 1);
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 350 })).length, 1);
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 2000 })).length, 1, 'o real pode ultrapassar');
});

test('fora da janela NÃO casa, mesmo com origem e valor idênticos', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal({ dia_inicial: 1, dia_limite: 10 })], lancamento({ data: '2026-09-20' }));
  assert.deepEqual(compativeis, []);
});

test('tipo diferente não casa (mesma contraparte, entrada vs saída)', () => {
  const compativeis = filtrarRecorrenciasCompativeis(
    [regraMensal({ tipo: 'despesa' })],
    lancamento({ tipo: 'receita' })
  );
  assert.deepEqual(compativeis, []);
});

test('regra que ainda não tinha começado não casa com lançamento retroativo', () => {
  const compativeis = filtrarRecorrenciasCompativeis(
    [regraMensal({ data_inicio: '2026-09-01' })],
    lancamento({ data: '2026-08-05' })
  );
  assert.deepEqual(compativeis, []);
});

test('regra encerrada (data_fim no passado) não casa', () => {
  const compativeis = filtrarRecorrenciasCompativeis(
    [regraMensal({ data_fim: '2026-08-31' })],
    lancamento({ data: '2026-09-05' })
  );
  assert.deepEqual(compativeis, []);
});

test('ambiguidade: duas regras com a mesma origem e a mesma janela devolvem as duas', () => {
  // Sem o valor como desempate, duas regras de mesma origem na mesma janela
  // são indistinguíveis — quem chama não vincula a nenhuma.
  const regras = [regraMensal({ id: 20, valor: 1850 }), regraMensal({ id: 21, valor: 400 })];
  const compativeis = filtrarRecorrenciasCompativeis(regras, lancamento());
  assert.deepEqual(compativeis.map(r => r.id), [20, 21]);
});

test('mesma origem em janelas que não se sobrepõem continua sem ambiguidade', () => {
  // É assim que o usuário separa duas recorrências da mesma contraparte.
  const regras = [
    regraMensal({ id: 30, dia_inicial: 1, dia_limite: 10 }),
    regraMensal({ id: 31, dia_inicial: 15, dia_limite: 25 }),
  ];
  assert.deepEqual(filtrarRecorrenciasCompativeis(regras, lancamento({ data: '2026-09-05' })).map(r => r.id), [30]);
  assert.deepEqual(filtrarRecorrenciasCompativeis(regras, lancamento({ data: '2026-09-20' })).map(r => r.id), [31]);
});

test('descrição sem chave confiável não casa com nada', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal({ descricao: 'ok' })], lancamento({ descricao: 'ok' }));
  assert.deepEqual(compativeis, []);
});

test('lista vazia ou data inválida devolvem lista vazia sem estourar', () => {
  assert.deepEqual(filtrarRecorrenciasCompativeis([], lancamento()), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ data: '' })), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis(null, lancamento()), []);
});

// ── baldeFechado ─────────────────────────────────────────────────────────────

test('balde aberto enquanto a soma real não alcança o previsto e a janela não venceu', () => {
  const regra = regraMensal({ valor: 1850, dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 0, regra, data: '2026-09-05' }), false);
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1500, regra, data: '2026-09-08' }), false,
    'faltam R$ 350 e ainda estamos dentro da janela');
});

test('balde fecha ao alcançar o previsto (1.500 + 350 = 1.850)', () => {
  const regra = regraMensal({ valor: 1850, dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1850, regra, data: '2026-09-09' }), true);
});

test('balde fecha se a soma ultrapassa o previsto', () => {
  const regra = regraMensal({ valor: 1850, dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1900, regra, data: '2026-09-09' }), true);
});

test('balde fecha quando a janela vence, mesmo com o previsto não alcançado', () => {
  const regra = regraMensal({ valor: 1850, dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1500, regra, data: '2026-09-11' }), true);
});

test('consolidação do usuário fecha o balde independentemente de valor e data', () => {
  const regra = regraMensal({ valor: 1850, dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 10, regra, data: '2026-09-02', consolidado: true }), true);
});

test('centavos não escorregam no ponto flutuante (0.1 + 0.2)', () => {
  const regra = regraMensal({ valor: 0.3, dia_inicial: 1, dia_limite: 28 });
  assert.equal(baldeFechado({ valorPrevisto: 0.3, somaReal: 0.1 + 0.2, regra, data: '2026-09-05' }), true);
});

// ── Faixa de valor ───────────────────────────────────────────────────────────
//
// Especificação do dono: "configurei um valor entre 1500 e 2500 entre os dias
// 1 e 5" — dois eixos, janela de dias E faixa de valor, com a faixa valendo
// para o TOTAL DO MÊS, não para cada entrada.

// Regra com faixa: previsto R$ 1.850, aceita de R$ 1.500 a R$ 2.500 no mês.
function regraComFaixa(extra = {}) {
  return regraMensal({ valor_min: 1500, valor_max: 2500, ...extra });
}

test('faixaDaRegra: regra sem as colunas preenchidas não tem faixa (as 101 regras antigas)', () => {
  assert.equal(faixaDaRegra(regraMensal()), null);
  assert.equal(faixaDaRegra(regraMensal({ valor_min: null, valor_max: null })), null);
});

test('faixaDaRegra: faixa aberta de um lado só continua valendo', () => {
  assert.deepEqual(faixaDaRegra(regraMensal({ valor_max: 2500 })), { min: null, max: 250000 });
  assert.deepEqual(faixaDaRegra(regraMensal({ valor_min: 1500 })), { min: 150000, max: null });
});

test('faixaDaRegra: faixa invertida é ignorada em vez de matar a regra', () => {
  // Erro de digitação não pode virar "esta regra nunca mais casa com nada".
  assert.equal(faixaDaRegra(regraMensal({ valor_min: 2500, valor_max: 1500 })), null);
});

test('tetoDoBalde: com faixa o teto é valor_max; sem faixa continua o previsto', () => {
  assert.equal(tetoDoBalde(regraComFaixa(), 1850), 250000);
  assert.equal(tetoDoBalde(regraMensal(), 1850), 185000);
});

test('cabeNoTeto: entrada parcial cabe; entrada que sozinha estoura o teto não', () => {
  const regra = regraComFaixa();
  assert.equal(cabeNoTeto(regra, 350), true, 'parcial pequena é o caso da acumulação');
  assert.equal(cabeNoTeto(regra, 2500), true, 'exatamente o teto cabe');
  assert.equal(cabeNoTeto(regra, 2600), false);
});

test('cabeNoTeto: soma acumulada conta — o que já entrou ocupa espaço no balde', () => {
  const regra = regraComFaixa();
  assert.equal(cabeNoTeto(regra, 350, 1500), true, '1.500 + 350 = 1.850, dentro dos 2.500');
  assert.equal(cabeNoTeto(regra, 1200, 1500), false, '1.500 + 1.200 estoura');
});

test('cabeNoTeto: regra sem teto aceita qualquer valor', () => {
  assert.equal(cabeNoTeto(regraMensal(), 99999), true);
  assert.equal(cabeNoTeto(regraMensal({ valor_min: 1500 }), 99999), true, 'piso não elimina');
});

// ── Faixa no filtro ──────────────────────────────────────────────────────────

test('faixa: acumulação preservada — 1.500 e 350 casam com a MESMA regra', () => {
  const regras = [regraComFaixa()];
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 1500, data: '2026-09-01' })).length, 1);
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 350, data: '2026-09-03' })).length, 1,
    'entrada abaixo do piso é parcela do mês, não motivo para recusar');
});

test('faixa: lançamento que sozinho passa do teto não casa', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraComFaixa()], lancamento({ valor: 4000 }));
  assert.deepEqual(compativeis, []);
});

test('faixa: regra sem faixa continua casando com qualquer valor (comportamento de hoje)', () => {
  assert.equal(filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ valor: 99999 })).length, 1);
});

// ── escolherRecorrencia: o desempate que a faixa devolveu ────────────────────

test('escolher: candidata única é escolhida sem precisar de faixa', () => {
  const escolha = escolherRecorrencia([regraMensal({ id: 7 })], { valor: 1500 });
  assert.equal(escolha.regra.id, 7);
  assert.equal(escolha.motivo, 'unica');
});

test('escolher: o caso da especificação — faixa larga x faixa estreita, mesma origem e janela', () => {
  // Duas regras da mesma contraparte na mesma janela. Hoje isso vira avulso;
  // com faixa, os R$ 1.500 só cabem na regra de 1.500–2.500.
  const larga = regraComFaixa({ id: 20 });
  const estreita = regraMensal({ id: 21, valor: 400, valor_min: 300, valor_max: 500 });

  const escolha = escolherRecorrencia([larga, estreita], { valor: 1500 });
  assert.equal(escolha.regra.id, 20);
  assert.equal(escolha.motivo, 'faixa_teto');
});

test('escolher: teto leva em conta o que já entrou no mês de cada candidata', () => {
  const a = regraComFaixa({ id: 20 });                                          // 1.500–2.500
  const b = regraMensal({ id: 21, valor: 3000, valor_min: 100, valor_max: 3000 });
  // A já recebeu 2.400 dos 2.500; os 300 que chegam não cabem mais nela.
  const somaPorRegra = new Map([[20, 2400], [21, 0]]);

  const escolha = escolherRecorrencia([a, b], { valor: 300 }, { somaPorRegra });
  assert.equal(escolha.regra.id, 21);
  assert.equal(escolha.motivo, 'faixa_teto');
});

test('escolher: regra com faixa vence a regra genérica sem faixa', () => {
  const especifica = regraComFaixa({ id: 20 });
  const generica = regraMensal({ id: 21 });

  const escolha = escolherRecorrencia([especifica, generica], { valor: 1600 });
  assert.equal(escolha.regra.id, 20);
  assert.equal(escolha.motivo, 'faixa_especifica');
});

test('escolher: duas regras sem faixa continuam ambíguas — nada é vinculado', () => {
  const escolha = escolherRecorrencia([regraMensal({ id: 20 }), regraMensal({ id: 21 })], { valor: 1500 });
  assert.equal(escolha.regra, null);
  assert.equal(escolha.motivo, 'ambiguo');
});

test('escolher: duas faixas que ambas comportam o lançamento continuam ambíguas', () => {
  const a = regraComFaixa({ id: 20 });
  const b = regraMensal({ id: 21, valor_min: 1000, valor_max: 3000 });

  const escolha = escolherRecorrencia([a, b], { valor: 1500 });
  assert.equal(escolha.regra, null, 'escolher entre duas faixas válidas seria sorteio');
});

test('escolher: nenhuma candidata comportando o lançamento não elege a "menos ruim"', () => {
  const a = regraMensal({ id: 20, valor_max: 500 });
  const b = regraMensal({ id: 21, valor_max: 800 });

  const escolha = escolherRecorrencia([a, b], { valor: 4000 });
  assert.equal(escolha.regra, null);
  assert.equal(escolha.motivo, 'ambiguo');
});

test('escolher: lista vazia devolve motivo próprio, sem estourar', () => {
  assert.deepEqual(escolherRecorrencia([], { valor: 10 }), { regra: null, motivo: 'sem_candidata' });
  assert.deepEqual(escolherRecorrencia(null, { valor: 10 }), { regra: null, motivo: 'sem_candidata' });
});

// ── Faixa × encerramento do balde ────────────────────────────────────────────

test('balde com faixa NÃO fecha ao alcançar o previsto — fecha no teto da faixa', () => {
  // É a interação que muda o comportamento: sem faixa, R$ 1.850 fechavam o mês
  // e a comissão seguinte virava avulso. Com faixa até R$ 2.500, ela entra.
  const regra = regraComFaixa();
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1850, regra, data: '2026-09-06' }), false);
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 2500, regra, data: '2026-09-06' }), true);
});

test('balde com faixa ainda fecha quando a janela do mês vence', () => {
  const regra = regraComFaixa({ dia_inicial: 1, dia_limite: 10 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1600, regra, data: '2026-09-11' }), true);
});

test('balde com faixa ainda fecha por consolidação do usuário', () => {
  const regra = regraComFaixa();
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1600, regra, data: '2026-09-06', consolidado: true }), true);
});

test('balde de regra sem faixa fecha no previsto, exatamente como antes', () => {
  const regra = regraMensal({ valor: 1850 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1850, regra, data: '2026-09-06' }), true);
});

test('faixa invertida no banco não trava o balde: volta a fechar pelo previsto', () => {
  const regra = regraMensal({ valor: 1850, valor_min: 2500, valor_max: 1500 });
  assert.equal(baldeFechado({ valorPrevisto: 1850, somaReal: 1850, regra, data: '2026-09-06' }), true);
});
