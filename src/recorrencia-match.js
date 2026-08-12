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
// Critério de casamento (decisão do dono do produto): mesma ORIGEM (descrição
// normalizada) + mesmo tipo + data dentro da janela da regra. O valor NÃO
// entra: uma recorrência de R$ 1.850 pode chegar como R$ 1.500 + R$ 350, e
// exigir valor exato faria a segunda entrada virar lançamento avulso.
//
// O valor deixa de ser critério de casamento e vira critério de ENCERRAMENTO:
// enquanto a soma real do mês não alcança o previsto e a janela não fechou, o
// balde daquela recorrência segue aberto e novas entradas acumulam nele (ver
// resolverVinculoRecorrencia em src/database.js).
//
// Consequência direta: duas regras com a mesma origem e a mesma janela ficam
// indistinguíveis — o que antes o valor desempatava. Nesse caso nada é
// vinculado e o conflito é logado; o desempate é do usuário, reorganizando as
// regras. Vincular à regra errada reescreve o histórico em silêncio; não
// vincular deixa um lançamento avulso, que é visível e corrigível.

const { normalizarEstabelecimento } = require('./estabelecimento');

// A janela de uma regra mensal/anual é DADO DA REGRA (recorrencias.dia_inicial
// e dia_limite). Esta constante só alimenta o fallback de regra antiga que
// ainda não tem a janela preenchida, e o backfill da migração — ±5 dias em
// torno de dia_mes, que é o comportamento que o sistema tinha antes de a
// janela ser explícita.
//
// ±5 cobre o motivo real de deslocamento (ocorrência que cai em fim de semana
// ou feriado e é antecipada/postergada, tipicamente 1-3 dias) com folga.
//
// A janela nunca atravessa a virada do mês, seja explícita ou derivada: o
// balde é (recorrencia_id, mês), e uma janela que vazasse para o mês vizinho
// acumularia a entrada no balde errado. Por isso os limites são sempre
// grampeados dentro do mês da própria transação — ver limitesDaJanela.
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
// comparar e somar em centavos inteiros é a precisão em que o dado realmente
// existe, e evita o 0.1 + 0.2 do ponto flutuante. Usado no encerramento do
// balde por valor, não no casamento.
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

// limitesDaJanela(regra, ano, mes) -> { inicio, limite } | null
//
// Janela da regra projetada num mês concreto, em dias daquele mês. Usa a
// janela explícita (dia_inicial/dia_limite) e cai para dia_mes ± padrão nas
// regras antigas que ainda não foram migradas.
//
// Grampeia tudo em [1, último dia do mês]: dia_limite 31 em fevereiro vira 28,
// e uma regra de dia 31 continua fechando no último dia real do mês em vez de
// nunca fechar. Sem isso, metade do calendário deixaria buracos.
//
// Exportada porque o encerramento do balde por data (src/database.js) precisa
// responder "a janela deste mês já passou?" com exatamente o mesmo critério
// que o casamento usa. Duas contas separadas divergiriam com o tempo.
function limitesDaJanela(regra, ano, mes) {
  if (!regra) return null;
  const ultimoDia = diasNoMes(ano, mes);

  let inicio = Number.isInteger(regra.dia_inicial) ? regra.dia_inicial : null;
  let limite = Number.isInteger(regra.dia_limite) ? regra.dia_limite : null;

  if (inicio === null || limite === null) {
    if (!Number.isInteger(regra.dia_mes)) return null;
    const esperado = Math.min(regra.dia_mes, ultimoDia);
    inicio = esperado - JANELA_DIAS_PADRAO;
    limite = esperado + JANELA_DIAS_PADRAO;
  }

  inicio = Math.min(Math.max(inicio, 1), ultimoDia);
  limite = Math.min(Math.max(limite, 1), ultimoDia);
  if (inicio > limite) return null;

  return { inicio, limite };
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

    case 'anual': {
      if (regra.dia_semana !== p.mes) return false;
      const janela = limitesDaJanela(regra, p.ano, p.mes);
      return !!janela && p.dia >= janela.inicio && p.dia <= janela.limite;
    }

    case 'mensal': {
      const janela = limitesDaJanela(regra, p.ano, p.mes);
      return !!janela && p.dia >= janela.inicio && p.dia <= janela.limite;
    }

    // Frequência desconhecida (regra de versão futura, dado corrompido): não
    // casa. Silenciosamente pular é melhor que adivinhar uma convenção.
    default:
      return false;
  }
}

// janelaEncerradaEm(regra, dataISO) -> boolean
//
// "O prazo de acumulação daquele mês já passou nesta data?" Só faz sentido
// para regra com janela de mês (mensal/anual); semanal/diária não tem prazo de
// mês e nunca encerra por data.
function janelaEncerradaEm(regra, dataISO) {
  const p = partesData(dataISO);
  if (!p || !regra) return false;
  if (regra.frequencia !== 'mensal' && regra.frequencia !== 'anual') return false;
  const janela = limitesDaJanela(regra, p.ano, p.mes);
  if (!janela) return false;
  return p.dia > janela.limite;
}

// filtrarRecorrenciasCompativeis(regras, lancamento, opcoes) -> regra[]
//
// Devolve TODAS as regras que casam, de propósito: quem chama é que decide o
// que fazer com o resultado. Uma só → vincula. Nenhuma → segue sem vínculo.
// Mais de uma → ambíguo, e o chamador não vincula a nenhuma (ver
// resolverVinculoRecorrencia em src/database.js). Embutir essa decisão aqui
// esconderia a ambiguidade de quem precisa logá-la.
//
// O filtro de tipo é repetido aqui mesmo já existindo na query
// (buscarRecorrenciasCandidatas): a função precisa valer sozinha, sem depender
// de qual SELECT a alimentou. `valor` não é filtro — ver o cabeçalho.
function filtrarRecorrenciasCompativeis(regras, lancamento, opcoes = {}) {
  if (!Array.isArray(regras) || regras.length === 0) return [];
  if (!lancamento || !partesData(lancamento.data)) return [];

  const chave = normalizarEstabelecimento(lancamento.descricao);
  if (!chave) return [];

  return regras.filter((regra) => {
    if (!regra) return false;
    if (regra.ativo === false) return false;
    if (regra.tipo !== lancamento.tipo) return false;
    if (!regraVigenteNaData(regra, lancamento.data)) return false;
    if (normalizarEstabelecimento(regra.descricao) !== chave) return false;
    return dentroDaJanela(regra, lancamento.data, opcoes);
  });
}

// baldeFechado(estado) -> boolean
//
// Encerramento da acumulação, com as duas condições da especificação: o que
// vier primeiro entre "a soma real alcançou o previsto" e "a janela do mês
// passou". Consolidação manual fecha por decisão do usuário.
//
// Puro para poder ser testado sozinho e para que o painel, o sync e a projeção
// respondam a mesma pergunta com a mesma conta.
function baldeFechado({ valorPrevisto, somaReal, regra, data, consolidado = false }) {
  if (consolidado) return true;
  if (janelaEncerradaEm(regra, data)) return true;

  const previsto = centavos(valorPrevisto);
  const soma = centavos(somaReal);
  if (previsto === null || soma === null) return false;
  // Alcançar exatamente o previsto fecha. Ultrapassar é permitido (o real pode
  // ser maior), só não abre espaço para uma entrada seguinte.
  return soma >= previsto;
}

module.exports = {
  JANELA_DIAS_PADRAO,
  JANELA_DIAS_SEMANAL,
  descricaoEquivalente,
  dentroDaJanela,
  janelaEncerradaEm,
  limitesDaJanela,
  baldeFechado,
  filtrarRecorrenciasCompativeis,
};
