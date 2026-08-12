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
// normalizada) + mesmo tipo + data dentro da janela da regra + o lançamento
// cabendo na FAIXA DE VALOR da regra (recorrencias.valor_min/valor_max).
//
// A faixa é o segundo eixo da especificação — "entre 1500 e 2500 entre os dias
// 1 e 5" — e entra com um cuidado que o valor exato não tinha: ela vale para o
// TOTAL ACUMULADO do mês, nunca para a entrada isolada. Uma recorrência de
// R$ 1.850 pode chegar como R$ 1.500 + R$ 350, e exigir que cada entrada
// estivesse dentro da faixa faria a segunda virar lançamento avulso.
//
// Daí a assimetria deliberada entre os dois lados da faixa:
//
//   valor_max ELIMINA. Um lançamento que sozinho já passa do teto não pode
//   pertencer àquele mês por nenhuma combinação de acumulação — a soma só
//   cresce. É o critério que desempata duas regras da mesma origem.
//
//   valor_min NÃO elimina, por construção. Toda entrada parcial é menor que o
//   piso enquanto o mês não fecha; testar contra ele mataria a acumulação, que
//   é exatamente o bug que este módulo existe para não recriar. O piso é
//   declaração de expectativa (aparece na tela e marca a regra como
//   "específica" no desempate), não filtro.
//
// O valor também é critério de ENCERRAMENTO: enquanto a soma real do mês não
// alcança o teto e a janela não fechou, o balde daquela recorrência segue
// aberto e novas entradas acumulam nele (ver resolverVinculoRecorrencia em
// src/database.js). Com faixa configurada o teto é `valor_max`; sem faixa
// continua sendo `recorrencias.valor`, como antes.
//
// Ambiguidade que sobra depois da faixa (duas regras da mesma origem, mesma
// janela, ambas cabendo) continua não vinculando nada, e o conflito é logado.
// Vincular à regra errada reescreve o histórico em silêncio; não vincular
// deixa um lançamento avulso, que é visível e corrigível.

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
// existe, e evita o 0.1 + 0.2 do ponto flutuante.
function centavos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

// faixaDaRegra(regra) -> { min, max } em centavos, ou null quando a regra não
// tem faixa nenhuma.
//
// null é o caso das 101 regras que já existiam quando as colunas nasceram: sem
// faixa, tudo se comporta exatamente como antes. Qualquer um dos dois lados
// pode vir null isoladamente (faixa aberta de um lado só).
//
// Faixa invertida (min > max) é dado impossível — não existe lançamento que a
// satisfaça, e tratá-la ao pé da letra transformaria um erro de digitação em
// "esta regra nunca mais casa com nada", em silêncio. Devolve null: a regra
// volta a se comportar como se não tivesse faixa. A validação que impede a
// inversão de ser gravada mora em normalizarRegraCasamento (src/database.js);
// aqui é a rede de baixo, para dado que já esteja no banco.
// Leitura ESTRITA, e não `centavos` direto: Number(null) é 0, e a coluna vazia
// chega do Postgres como null. Passar por centavos sem este filtro daria
// { min: 0, max: 0 } para toda regra sem faixa — teto zero, balde fechado no
// primeiro lançamento, todas as recorrências do banco quebradas de uma vez.
// centavos continua permissivo porque os outros usos dele (soma real) querem
// mesmo tratar ausência como zero.
function centavosOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  return centavos(valor);
}

function faixaDaRegra(regra) {
  if (!regra) return null;
  const min = centavosOuNulo(regra.valor_min);
  const max = centavosOuNulo(regra.valor_max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) return null;
  return { min, max };
}

// tetoDoBalde(regra, valorPrevisto) -> centavos | null
//
// O ponto em que a acumulação do mês para de aceitar entrada nova. Com faixa é
// `valor_max`; sem faixa é o previsto da regra, que era o único critério antes
// de a faixa existir.
//
// Consequência a ter em mente ao ler a tela: com faixa, o balde NÃO fecha mais
// ao alcançar `recorrencias.valor`. Uma regra de R$ 1.850 com faixa até
// R$ 2.500 segue aberta depois dos R$ 1.850 — é isso que permite a comissão
// que chega depois entrar na mesma recorrência em vez de virar avulso. A
// projeção (faltaDaOcorrencia) continua olhando `recorrencias.valor`: o que
// ainda se ESPERA receber é o previsto, o teto é só até onde se ACEITA.
function tetoDoBalde(regra, valorPrevisto) {
  const faixa = faixaDaRegra(regra);
  if (faixa && faixa.max !== null) return faixa.max;
  return centavos(valorPrevisto);
}

// cabeNoTeto(regra, valorLancamento, somaAcumulada) -> boolean
//
// "Este lançamento ainda cabe no mês daquela regra?" — soma acumulada + valor
// contra `valor_max`. Sem faixa (ou sem teto) cabe sempre.
//
// somaAcumulada 0 é o padrão de propósito: é o piso da soma real, e faz a
// resposta valer como eliminação segura mesmo para quem não tem como saber o
// estado do balde (o filtro puro). Quem sabe — o desempate, que recebe as
// somas do mês — passa o valor real e elimina com mais precisão.
//
// Valor não numérico não elimina: sem dado confiável, o lado seguro do erro é
// deixar os outros critérios (origem, tipo, janela) decidirem.
function cabeNoTeto(regra, valorLancamento, somaAcumulada = 0) {
  const faixa = faixaDaRegra(regra);
  if (!faixa || faixa.max === null) return true;
  const valor = centavos(valorLancamento);
  if (valor === null) return true;
  const soma = centavos(somaAcumulada) || 0;
  return soma + valor <= faixa.max;
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
// de qual SELECT a alimentou.
//
// O valor entra por um lado só: o lançamento que SOZINHO estoura `valor_max`
// não pode pertencer àquele mês (a soma só cresce). Nada é testado contra
// `valor_min` — ver o cabeçalho para o porquê de o piso não poder filtrar.
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
    if (!cabeNoTeto(regra, lancamento.valor)) return false;
    return dentroDaJanela(regra, lancamento.data, opcoes);
  });
}

// escolherRecorrencia(compativeis, lancamento, opcoes) -> { regra, motivo }
//
// O desempate que a faixa de valor devolveu ao sistema. Antes dela, duas
// regras da mesma origem na mesma janela eram indistinguíveis e o lançamento
// virava avulso — perda de vínculo justamente no caso que o usuário tinha
// configurado com mais cuidado.
//
// `opcoes.somaPorRegra` é um Map<recorrencia_id, soma real do mês>. Sem ele o
// desempate assume soma 0, o que só torna a eliminação mais conservadora.
//
// Dois critérios, nesta ordem, ambos por ELIMINAÇÃO — nenhum deles escolhe
// entre candidatas equivalentes, porque escolher no empate é sortear:
//
//   (1) Teto: descarta quem não teria como receber este lançamento sem
//       estourar o próprio `valor_max`. É o critério da especificação — regra
//       de R$ 1.500–2.500 e regra de R$ 300–500, mesma contraparte, mesma
//       janela: a entrada de R$ 1.500 só cabe na primeira.
//
//   (2) Específica vence genérica: se, entre as que sobraram, exatamente uma
//       tem faixa configurada, ela vence a(s) sem faixa. A faixa é um ato
//       deliberado do usuário para distinguir aquela regra; a regra sem faixa
//       é a de propósito geral.
//
// Sobrando mais de uma candidata, devolve regra null e motivo 'ambiguo' — o
// comportamento de antes, preservado de propósito.
function escolherRecorrencia(compativeis, lancamento = {}, opcoes = {}) {
  const lista = Array.isArray(compativeis) ? compativeis.filter(Boolean) : [];
  if (lista.length === 0) return { regra: null, motivo: 'sem_candidata' };
  if (lista.length === 1) return { regra: lista[0], motivo: 'unica' };

  const somaPorRegra = opcoes.somaPorRegra instanceof Map ? opcoes.somaPorRegra : new Map();
  const somaDe = (regra) => somaPorRegra.get(regra.id) || 0;

  const cabem = lista.filter((regra) => cabeNoTeto(regra, lancamento.valor, somaDe(regra)));
  if (cabem.length === 1) return { regra: cabem[0], motivo: 'faixa_teto' };
  // Nenhuma comporta o lançamento: não há candidata legítima, e escolher a
  // "menos ruim" seria inventar. Segue como avulso.
  if (cabem.length === 0) return { regra: null, motivo: 'ambiguo' };

  const comFaixa = cabem.filter((regra) => faixaDaRegra(regra) !== null);
  if (comFaixa.length === 1) return { regra: comFaixa[0], motivo: 'faixa_especifica' };

  return { regra: null, motivo: 'ambiguo' };
}

// baldeFechado(estado) -> boolean
//
// Encerramento da acumulação, com as duas condições da especificação: o que
// vier primeiro entre "a soma real alcançou o teto" e "a janela do mês passou".
// Consolidação manual fecha por decisão do usuário.
//
// O teto é `valor_max` quando a regra tem faixa e `valorPrevisto` quando não
// tem — ver tetoDoBalde. `valorPrevisto` continua no argumento (em vez de sair
// só da regra) porque quem chama nem sempre fecha contra `recorrencias.valor`:
// a projeção do mês pode ter valor próprio.
//
// Puro para poder ser testado sozinho e para que o painel, o sync e a projeção
// respondam a mesma pergunta com a mesma conta.
function baldeFechado({ valorPrevisto, somaReal, regra, data, consolidado = false }) {
  if (consolidado) return true;
  if (janelaEncerradaEm(regra, data)) return true;

  const teto = tetoDoBalde(regra, valorPrevisto);
  const soma = centavos(somaReal);
  if (teto === null || soma === null) return false;
  // Alcançar exatamente o teto fecha. Ultrapassar é permitido (a última entrada
  // pode passar do limite), só não abre espaço para uma entrada seguinte.
  return soma >= teto;
}

module.exports = {
  JANELA_DIAS_PADRAO,
  JANELA_DIAS_SEMANAL,
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
};
