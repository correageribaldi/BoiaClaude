const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JANELA_DIAS_PADRAO,
  descricaoEquivalente,
  dentroDaJanela,
  janelaEncerradaEm,
  limitesDaJanela,
  baldeFechado,
  filtrarRecorrenciasCompativeis,
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
