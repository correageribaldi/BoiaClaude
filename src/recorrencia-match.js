// ─── Casamento entre lançamento importado e regra de recorrência ─────────────
//
// Módulo PURO e sem I/O, no mesmo espírito de src/estabelecimento.js: a
// decisão "esta transação que a Pluggy trouxe É a ocorrência daquela
// recorrência" precisa ser testável com dados sintéticos, sem Postgres, e
// precisa ser exatamente a mesma regra em qualquer chamador.
//
// O bug que motiva o módulo: upsertTransacaoPluggy gravava a transação
// importada SEM recorrencia_id. A materialização de projeções (GET
// /api/transactions) pergunta "esta recorrência já tem lançamento neste mês?"
// olhando exatamente essa coluna — como a transferência real entrava com NULL,
// a resposta era "não", o painel materializava um projetado, e o mesmo
// dinheiro aparecia duas vezes. O índice único idx_transacoes_recorrencia_mes
// não pega esse caso: ele é parcial (WHERE recorrencia_id IS NOT NULL) e a
// linha da Pluggy passa por baixo dele com NULL.
//
// Critério de casamento (decisão do dono do produto, deliberadamente rígida):
// mesmo tipo + descrição equivalente + VALOR EXATO + data dentro de uma janela
// em torno do dia esperado da regra. Sem tolerância percentual de valor: entre
// não casar (o usuário vê a duplicata, que é visível e corrigível) e casar
// errado (que reescreve o histórico em silêncio), a escolha é não casar.
//
// O valor é o desempatador de verdade, não a descrição: em dados reais existem
// duas recorrências com descrição IDÊNTICA ("Transferência Recebida|<mesma
// pessoa>") e valores diferentes. Qualquer heurística que case só por texto
// vincula à regra errada — e vincular errado é pior que não vincular.

const { normalizarEstabelecimento } = require('./estabelecimento');

// Janela, em dias corridos, em torno do dia esperado — frequências mensal e
// anual.
//
// ±5 cobre o motivo real de deslocamento (ocorrência que cai em fim de semana
// ou feriado e é antecipada/postergada, tipicamente 1-3 dias) com folga, e
// ainda continua sendo um critério de verdade: 11 dias de ~30, cerca de um
// terço do mês.
//
// Por que não uma janela maior: toda a proteção deste sistema é indexada por
// MÊS — idx_transacoes_recorrencia_mes é (recorrencia_id, mês) e a supressão de
// projeção em /api/transactions também é por recorrência dentro do período.
// Uma janela que atravessasse a virada do mês casaria a transação com a
// ocorrência de um mês enquanto ocupa o slot de outro: o mês vizinho voltaria a
// duplicar, agora com vínculo errado. Por isso o dia esperado é sempre
// calculado DENTRO do mês da própria transação (ver diaDentroDaJanela), e a
// janela precisa caber nele.
const JANELA_DIAS_PADRAO = 5;

// Frequência semanal tem ciclo de 7 dias: a distância circular máxima entre
// dois dias da semana é 3. Uma janela de ±5 casaria QUALQUER data e o critério
// de data simplesmente deixaria de existir. ±1 mantém o critério vivo (cobre o
// pagamento que escorregou um dia) sem virar carimbo.
const JANELA_DIAS_SEMANAL = 1;

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function partesData(dataISO) {
  if (typeof dataISO !== 'string') return null;
  const m = DATA_ISO.exec(dataISO.slice(0, 10));
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { ano, mes, dia };
}

// UTC de propósito: aqui só interessa o dia do calendário que veio na string
// ISO. Usar horário local abriria a porta para o clássico deslocamento de um
// dia dependendo do fuso do servidor.
function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function diaDaSemana(p) {
  return new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay();
}

// NUMERIC(12,2) nos dois lados (recorrencias.valor e transacoes.valor):
// comparar em centavos inteiros é a precisão em que o dado realmente existe, e
// evita o 0.1 + 0.2 do ponto flutuante. Isso NÃO é tolerância — 6500.00 casa
// com 6500, mas 6500.01 não casa com 6500.00.
function centavos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// Descrição equivalente = MESMA chave de estabelecimento dos dois lados.
//
// Reusar normalizarEstabelecimento (em vez de escrever outra normalização) é o
// que faz o casamento enxergar o texto do jeito que o resto do sistema já
// enxerga: acento e caixa não importam, prefixo de operação da Pluggy
// ("Transferência Recebida|") é descartado, gateway ("IFD*") e sufixo de
// parcela (" 3/10") também. Uma segunda normalização paralela divergiria da
// primeira com o tempo e o casamento passaria a errar em silêncio.
//
// Chave null de um dos lados ("não dá para derivar chave confiável": texto
// curto demais, só dígitos, contraparte vazia) significa NÃO CASA. Não casar é
// o lado seguro do erro.
//
// Efeito colateral aceito: normalizarEstabelecimento descarta o prefixo de
// operação, então "Transferência enviada|Fulano" e "Transferência
// Recebida|Fulano" geram a mesma chave. O filtro de `tipo` (receita/despesa)
// separa os dois, e valor exato + janela de data fecham o resto.
function descricaoEquivalente(descricaoA, descricaoB) {
  const chaveA = normalizarEstabelecimento(descricaoA);
  if (!chaveA) return false;
  const chaveB = normalizarEstabelecimento(descricaoB);
  if (!chaveB) return false;
  return chaveA === chaveB;
}

// dia_mes 31 em mês de 30 dias (ou em fevereiro): a ocorrência real acontece no
// último dia do mês. Sem o clamp, toda regra de dia 29/30/31 ficaria fora da
// janela em boa parte do calendário.
function diaDentroDaJanela(p, diaMes, janelaDias) {
  if (!Number.isInteger(diaMes)) return false;
  const esperado = Math.min(diaMes, diasNoMes(p.ano, p.mes));
  return Math.abs(p.dia - esperado) <= janelaDias;
}

// A vigência é conferida contra a DATA DO LANÇAMENTO, não contra CURRENT_DATE:
// um sync retroativo traz transações antigas, e uma regra criada depois não
// pode reivindicar um lançamento anterior ao próprio início. Comparação
// lexicográfica de string funciona porque as datas são sempre YYYY-MM-DD.
function regraVigenteNaData(regra, dataISO) {
  const data = String(dataISO).slice(0, 10);
  if (regra.data_inicio && String(regra.data_inicio).slice(0, 10) > data) return false;
  if (regra.data_fim && String(regra.data_fim).slice(0, 10) < data) return false;
  return true;
}

// dentroDaJanela(regra, dataISO, opcoes) -> boolean
//
// A convenção de cada frequência espelha calcularOcorrenciasNoPerodo
// (src/database.js) — inclusive a de `anual`, que reaproveita dia_semana como
// MÊS da regra. Se as duas divergirem, o casamento passa a apontar para uma
// ocorrência que a projeção nunca gera.
function dentroDaJanela(regra, dataISO, opcoes = {}) {
  const janelaDias = Number.isFinite(opcoes.janelaDias) ? opcoes.janelaDias : JANELA_DIAS_PADRAO;
  const janelaSemanal = Number.isFinite(opcoes.janelaDiasSemanal)
    ? opcoes.janelaDiasSemanal
    : JANELA_DIAS_SEMANAL;

  const p = partesData(dataISO);
  if (!p || !regra) return false;

  switch (regra.frequencia) {
    // Toda data é dia esperado — a janela não acrescentaria informação nenhuma.
    case 'diario':
      return true;

    case 'semanal': {
      if (!Number.isInteger(regra.dia_semana)) return false;
      const bruta = Math.abs(diaDaSemana(p) - regra.dia_semana);
      return Math.min(bruta, 7 - bruta) <= janelaSemanal;
    }

    case 'anual':
      if (regra.dia_semana !== p.mes) return false;
      return diaDentroDaJanela(p, regra.dia_mes, janelaDias);

    case 'mensal':
      return diaDentroDaJanela(p, regra.dia_mes, janelaDias);

    // Frequência desconhecida (regra de versão futura, dado corrompido): não
    // casa. Silenciosamente pular é melhor que adivinhar uma convenção.
    default:
      return false;
  }
}

// filtrarRecorrenciasCompativeis(regras, lancamento, opcoes) -> regra[]
//
// Devolve TODAS as regras que casam, de propósito: quem chama é que decide o
// que fazer com o resultado. Uma só → vincula. Nenhuma → segue sem vínculo.
// Mais de uma → ambíguo, e o chamador não vincula a nenhuma (ver
// resolverVinculoRecorrencia em src/database.js). Embutir essa decisão aqui
// esconderia a ambiguidade de quem precisa logá-la.
//
// Os filtros de tipo e valor são repetidos aqui mesmo já existindo na query
// (buscarRecorrenciasCandidatas): a função precisa valer sozinha, sem depender
// de qual SELECT a alimentou.
function filtrarRecorrenciasCompativeis(regras, lancamento, opcoes = {}) {
  if (!Array.isArray(regras) || regras.length === 0) return [];
  if (!lancamento || !partesData(lancamento.data)) return [];

  const centavosLancamento = centavos(lancamento.valor);
  if (centavosLancamento === null) return [];

  const chave = normalizarEstabelecimento(lancamento.descricao);
  if (!chave) return [];

  return regras.filter((regra) => {
    if (!regra) return false;
    if (regra.ativo === false) return false;
    if (regra.tipo !== lancamento.tipo) return false;
    if (centavos(regra.valor) !== centavosLancamento) return false;
    if (!regraVigenteNaData(regra, lancamento.data)) return false;
    if (normalizarEstabelecimento(regra.descricao) !== chave) return false;
    return dentroDaJanela(regra, lancamento.data, opcoes);
  });
}

module.exports = {
  JANELA_DIAS_PADRAO,
  JANELA_DIAS_SEMANAL,
  descricaoEquivalente,
  dentroDaJanela,
  filtrarRecorrenciasCompativeis,
};
