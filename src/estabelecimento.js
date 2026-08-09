// ─── Normalização de descrição bancária → chave de estabelecimento ───────────
//
// Módulo PURO e sem dependências, de propósito: a mesma função gera a chave na
// GRAVAÇÃO do aprendizado (quando o usuário corrige a categoria de um
// lançamento) e na LEITURA (quando o sync decide a categoria de um lançamento
// novo). Qualquer divergência entre os dois lados quebra a feature em silêncio
// — sem erro, só "não aprendeu" —, então ela mora isolada e testada, fora de
// database.js e de pluggy.js.
//
// Formato real das descrições que a Pluggy devolve (padrões observados em
// produção; nomes abaixo são fictícios):
//
//   "Compra no débito|MERCADO FICTICIO"        -> mercado ficticio
//   "Compra no crédito|IFD*PIZZARIA DO ZE L"   -> pizzaria do ze l
//   "Transferência enviada|FULANO DE TAL"      -> fulano de tal
//   "Transferência Recebida|FULANO DE TAL"     -> fulano de tal
//   "Uber"                                     -> uber
//   "Empresa* Assinatura Mensal"               -> empresa* assinatura mensal
//   "Pagamento de fatura"                      -> pagamento de fatura
//   "IOF de compra internacional"              -> iof de compra internacional
//   "Xyz*Loja Online-Ns2com In 1/4"            -> loja online-ns2com in
//
// Note que débito e crédito no mesmo estabelecimento caem na MESMA chave (é o
// que o usuário espera: "corrigi a pizzaria, corrigiu pra sempre"), e que
// enviada/recebida também — por isso o aprendizado é gravado por (chave, tipo)
// e não só por chave; ver a tabela categoria_aprendida em src/database.js.

// Chave curta demais é genérica demais para aprender com segurança ("ok", "sp")
// — nesses casos preferimos não aprender nada a arriscar categorizar errado
// um monte de lançamento sem relação entre si.
const MIN_CARACTERES_CHAVE = 3;

// Prefixo de gateway/subadquirente colado no nome do estabelecimento
// ("IFD*", "Mlp*", "PAG*"). Limitado a 2-4 letras justamente para NÃO comer
// nomes de marca que legitimamente contêm "*" ("Empresa* Assinatura Mensal",
// 7 letras antes do asterisco, fica intacto).
const PREFIXO_GATEWAY = /^[a-z]{2,4}\*\s*/i;

// Sufixo de parcela: " 1/4", " 2/12", " (3/6)". Sem ele, cada parcela da mesma
// compra viraria uma chave diferente e o aprendizado nunca pegaria.
const SUFIXO_PARCELA = /\s*\(?\s*\d{1,2}\s*\/\s*\d{1,2}\s*\)?$/;

// NFD separa a letra do acento; a faixa U+0300–U+036F é o bloco de diacríticos
// combinantes (cobre também o cedilha de "ç"). Escapes unicode explícitos para
// o arquivo não depender de como o editor salvou os caracteres combinantes.
function removerAcentos(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// normalizarEstabelecimento(descricao) -> string (chave) | null
//
// null significa "não dá para derivar uma chave confiável desta descrição" —
// quem chama trata como "não aprende / não consulta", nunca como erro.
function normalizarEstabelecimento(descricao) {
  if (typeof descricao !== 'string') return null;

  // A Pluggy usa "<operação>|<contraparte>" ("Compra no débito|X",
  // "Transferência enviada|X"). Pegamos o ÚLTIMO trecho não vazio em vez de
  // manter uma lista fixa de prefixos conhecidos: cobre os quatro prefixos que
  // aparecem hoje e também os que a Pluggy vier a usar amanhã, sem release.
  // O risco teórico é um nome de estabelecimento com "|" no meio — não
  // observado em nenhuma descrição real, e mesmo assim geraria uma chave
  // estável (só mais curta), nunca um match errado com outro estabelecimento.
  const segmentos = descricao.split('|');
  let base = segmentos[segmentos.length - 1].trim();
  // "Compra no débito|" (sem contraparte): a operação é conhecida, o
  // estabelecimento não. Aprender aqui viraria "toda compra no débito de
  // origem desconhecida é X" — generalização larga demais. Melhor não aprender.
  if (!base) return null;

  // Gateways podem estar encadeados ("Aaa*Bbb*LOJA") — remove até estabilizar.
  // Termina sempre: cada passada encurta a string ou não muda nada.
  let anterior;
  do {
    anterior = base;
    base = base.replace(PREFIXO_GATEWAY, '').trim();
  } while (base !== anterior);

  base = base.replace(SUFIXO_PARCELA, '');

  const chave = removerAcentos(base)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .trim();

  if (chave.length < MIN_CARACTERES_CHAVE) return null;
  // Só dígitos/pontuação (número de documento, id de operação) nunca se repete
  // entre lançamentos — aprender com isso só sujaria a tabela.
  if (!/[a-z]/.test(chave)) return null;

  return chave;
}

module.exports = { normalizarEstabelecimento, MIN_CARACTERES_CHAVE };
