const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JANELA_DIAS_PADRAO,
  descricaoEquivalente,
  dentroDaJanela,
  filtrarRecorrenciasCompativeis,
} = require('../src/recorrencia-match');

// Todos os dados abaixo são SINTÉTICOS. Nomes fictícios, valores inventados.

// Regra mensal padrão dos testes: dia 5, receita, R$ 4.321,00.
function regraMensal(extra = {}) {
  return {
    id: 1,
    tipo: 'receita',
    valor: 4321,
    descricao: 'Transferência Recebida|Fulano De Tal',
    frequencia: 'mensal',
    dia_mes: 5,
    dia_semana: null,
    data_inicio: '2026-01-05',
    data_fim: null,
    ativo: true,
    ...extra,
  };
}

function lancamento(extra = {}) {
  return {
    tipo: 'receita',
    valor: 4321,
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

// ── dentroDaJanela ───────────────────────────────────────────────────────────

test('dentroDaJanela: mensal aceita ±5 dias em torno do dia esperado', () => {
  const regra = regraMensal({ dia_mes: 10 });
  for (const dia of ['05', '07', '10', '13', '15']) {
    assert.equal(dentroDaJanela(regra, `2026-09-${dia}`), true, `dia ${dia} deveria estar na janela`);
  }
});

test('dentroDaJanela: mensal recusa fora da janela, dos dois lados', () => {
  const regra = regraMensal({ dia_mes: 10 });
  assert.equal(dentroDaJanela(regra, '2026-09-04'), false);
  assert.equal(dentroDaJanela(regra, '2026-09-16'), false);
});

test('dentroDaJanela: janela é sempre dentro do mês da própria transação (não atravessa a virada)', () => {
  // Regra de dia 1: um lançamento em 31/08 está a 1 dia do dia 1 de setembro,
  // mas o slot do índice único dele é AGOSTO. Casar aqui vincularia a
  // transação a um mês e ocuparia o slot de outro.
  const regra = regraMensal({ dia_mes: 1 });
  assert.equal(dentroDaJanela(regra, '2026-08-31'), false);
  assert.equal(dentroDaJanela(regra, '2026-09-01'), true);
});

test('dentroDaJanela: dia_mes 31 em mês curto usa o último dia do mês', () => {
  const regra = regraMensal({ dia_mes: 31 });
  assert.equal(dentroDaJanela(regra, '2026-02-28'), true, 'fevereiro: esperado cai em 28');
  assert.equal(dentroDaJanela(regra, '2026-02-24'), true);
  assert.equal(dentroDaJanela(regra, '2026-02-22'), false);
});

test('dentroDaJanela: semanal só aceita ±1 dia do dia da semana da regra', () => {
  // 2026-09-07 é uma segunda-feira (dia_semana 1).
  const regra = regraMensal({ frequencia: 'semanal', dia_mes: null, dia_semana: 1 });
  assert.equal(dentroDaJanela(regra, '2026-09-07'), true, 'segunda');
  assert.equal(dentroDaJanela(regra, '2026-09-08'), true, 'terça');
  assert.equal(dentroDaJanela(regra, '2026-09-06'), true, 'domingo (distância circular 1)');
  assert.equal(dentroDaJanela(regra, '2026-09-09'), false, 'quarta');
});

test('dentroDaJanela: diário aceita qualquer data (todo dia é dia esperado)', () => {
  const regra = regraMensal({ frequencia: 'diario', dia_mes: null });
  assert.equal(dentroDaJanela(regra, '2026-09-17'), true);
});

test('dentroDaJanela: anual exige o mês da regra (dia_semana carrega o mês, como na projeção)', () => {
  const regra = regraMensal({ frequencia: 'anual', dia_mes: 10, dia_semana: 9 });
  assert.equal(dentroDaJanela(regra, '2026-09-12'), true);
  assert.equal(dentroDaJanela(regra, '2026-10-10'), false, 'mês errado');
});

test('dentroDaJanela: frequência desconhecida não casa', () => {
  const regra = regraMensal({ frequencia: 'quinzenal' });
  assert.equal(dentroDaJanela(regra, '2026-09-05'), false);
});

// ── filtrarRecorrenciasCompativeis ───────────────────────────────────────────

test('casa por descrição + valor exato + janela', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ data: '2026-09-08' }));
  assert.deepEqual(compativeis.map(r => r.id), [1]);
});

test('duas regras com a MESMA descrição e valores diferentes: cada lançamento casa com a sua', () => {
  // Caso que a descrição sozinha não resolve: mesma contraparte, dois
  // combinados diferentes. É o valor que desempata.
  const regras = [
    regraMensal({ id: 10, valor: 4321 }),
    regraMensal({ id: 11, valor: 987.65 }),
  ];

  const casaGrande = filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 4321 }));
  assert.deepEqual(casaGrande.map(r => r.id), [10]);

  const casaPequena = filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 987.65 }));
  assert.deepEqual(casaPequena.map(r => r.id), [11]);
});

test('valor diferente NÃO casa — nem por um centavo (sem tolerância percentual)', () => {
  const regras = [regraMensal({ valor: 4321 })];
  assert.deepEqual(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 4321.01 })), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 4320.99 })), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis(regras, lancamento({ valor: 4300 })), []);
});

test('valor igual escrito com escala diferente casa (4321 = 4321.00)', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal({ valor: 4321.0 })], lancamento({ valor: 4321 }));
  assert.equal(compativeis.length, 1);
});

test('fora da janela NÃO casa, mesmo com descrição e valor idênticos', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal({ dia_mes: 5 })], lancamento({ data: '2026-09-20' }));
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

test('ambiguidade: duas regras idênticas em descrição E valor devolvem as duas (quem chama decide não vincular)', () => {
  const regras = [regraMensal({ id: 20 }), regraMensal({ id: 21, dia_mes: 7 })];
  const compativeis = filtrarRecorrenciasCompativeis(regras, lancamento());
  assert.deepEqual(compativeis.map(r => r.id), [20, 21]);
});

test('descrição sem chave confiável não casa com nada (não sai consultando o mundo)', () => {
  const compativeis = filtrarRecorrenciasCompativeis([regraMensal({ descricao: 'ok' })], lancamento({ descricao: 'ok' }));
  assert.deepEqual(compativeis, []);
});

test('lista vazia, data inválida ou valor não numérico devolvem lista vazia sem estourar', () => {
  assert.deepEqual(filtrarRecorrenciasCompativeis([], lancamento()), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ data: '' })), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis([regraMensal()], lancamento({ valor: null })), []);
  assert.deepEqual(filtrarRecorrenciasCompativeis(null, lancamento()), []);
});

test('janela é configurável e o padrão exportado é 5 dias', () => {
  assert.equal(JANELA_DIAS_PADRAO, 5);
  const regras = [regraMensal({ dia_mes: 5 })];
  assert.equal(filtrarRecorrenciasCompativeis(regras, lancamento({ data: '2026-09-12' })).length, 0);
  assert.equal(
    filtrarRecorrenciasCompativeis(regras, lancamento({ data: '2026-09-12' }), { janelaDias: 10 }).length,
    1
  );
});
