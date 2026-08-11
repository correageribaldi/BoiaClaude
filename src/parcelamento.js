// ─── Parcelamento de compra no cartão (Pluggy creditCardMetadata) ────────────
//
// Módulo PURO e sem dependência de banco/rede, pelo mesmo motivo de
// src/estabelecimento.js: a lógica que decide "quantas parcelas ainda faltam e
// em que mês cada uma cai" é a parte fácil de errar e a parte que NÃO pode ser
// testada só em produção — ela alimenta o card de previsão, onde já houve bug
// de contagem dupla.
//
// ── O que a Pluggy entrega (confirmado na doc oficial, não inferido) ─────────
//
// Transaction.creditCardMetadata traz `installmentNumber` (parcela atual),
// `totalInstallments` (total), `totalAmount` (valor cheio da compra),
// `purchaseDate`, `billId` e `billForecastDate`. É o campo ESTRUTURADO e tem
// prioridade sobre qualquer heurística de texto.
//
// ── Por que a projeção não pode ser cega (o ponto crítico) ──────────────────
//
// A doc da Pluggy (docs.pluggy.ai/docs/credit-card-installments) descreve DOIS
// comportamentos, e qual deles vale depende da INSTITUIÇÃO:
//
//   A) o banco lança TODAS as parcelas logo após a compra — as futuras já
//      chegam como transação, com data da fatura correspondente e
//      status PENDING ("transactions that are available in 'Open' invoices or
//      are future installments ... status will return them as PENDING");
//   B) o banco cria uma parcela por vez, conforme cada fatura fecha.
//
// No caso (A) as parcelas futuras JÁ entram na previsão pelo corte de faturas
// de cartão (projetarFaturasCartao soma transações de cartão pendentes com
// data futura). Projetar de novo a partir de parcela_atual/parcela_total
// dobraria o valor. No caso (B) elas não existem em lugar nenhum e a previsão
// fica cega para o compromisso já assumido.
//
// Por isso projetarParcelasRestantes NÃO projeta "as parcelas que faltam": ela
// projeta apenas as parcelas que faltam E que ainda não existem como
// transação. É o mesmo desenho do corte de recorrências em
// projetarProximosMeses ("ocorrência menos as que já viraram transação"), e
// funciona nos dois comportamentos sem precisar saber de qual banco veio o
// dado — inclusive quando o mesmo usuário tem um cartão de cada tipo.

const { normalizarEstabelecimento } = require('./estabelecimento');

// Compra parcelada real começa em 2x. `totalInstallments: 1` é compra à vista
// (alguns conectores mandam assim) — não há nada a projetar nem a exibir.
const MIN_PARCELAS = 2;
// Teto defensivo contra dado corrompido virar projeção de anos. O maior
// parcelamento usual no Brasil é 24x; 99 é o limite do que cabe em "X/Y" de
// dois dígitos, que é o formato das descrições bancárias.
const MAX_PARCELAS = 99;

// Sufixo "X/Y" no fim da descrição, com captura. Espelha o SUFIXO_PARCELA de
// src/estabelecimento.js (que só remove) — mesma forma, incluindo a variante
// entre parênteses "(3/6)" usada pelos lançamentos parcelados criados pelo
// próprio Cronos.
const SUFIXO_PARCELA_CAPTURA = /(?:^|[\s(])(\d{1,2})\s*\/\s*(\d{1,2})\s*\)?$/;

function parcelamentoValido(atual, total) {
  return Number.isInteger(atual) && Number.isInteger(total)
    && total >= MIN_PARCELAS && total <= MAX_PARCELAS
    && atual >= 1 && atual <= total;
}

// extrairParcelamento(tx, { ehCartao }) -> { atual, total, origem } | null
//
// origem: 'metadata' (campo estruturado da Pluggy) ou 'descricao' (heurística).
// Preferir o campo estruturado não é preciosismo: a heurística de texto é
// ambígua por natureza ("Mensalidade 01/12" tanto pode ser parcela 1 de 12
// quanto uma competência jan/2012), então ela só é aplicada em transação de
// CARTÃO, onde "X/Y" no fim da descrição é convenção consolidada do extrato
// brasileiro. Em conta corrente, sem creditCardMetadata, devolve null.
function extrairParcelamento(tx, opcoes = {}) {
  const meta = tx?.creditCardMetadata;
  const atualMeta = Number(meta?.installmentNumber);
  const totalMeta = Number(meta?.totalInstallments);
  if (parcelamentoValido(atualMeta, totalMeta)) {
    return { atual: atualMeta, total: totalMeta, origem: 'metadata' };
  }

  if (!opcoes.ehCartao) return null;

  const descricao = typeof tx?.description === 'string' ? tx.description : '';
  const m = SUFIXO_PARCELA_CAPTURA.exec(descricao.trim());
  if (!m) return null;

  const atual = Number(m[1]);
  const total = Number(m[2]);
  if (!parcelamentoValido(atual, total)) return null;

  return { atual, total, origem: 'descricao' };
}

// chaveGrupoParcela(descricao, total) -> string | null
//
// "Estas duas linhas são parcelas da MESMA compra?" — a Pluggy é explícita na
// doc de que o Open Finance NÃO devolve um identificador que agrupe as
// parcelas de uma compra, e recomenda heurística por
// installmentNumber/totalInstallments + totalAmount + nome do estabelecimento.
//
// Usamos estabelecimento + total de parcelas, e de propósito NÃO entra o valor
// da parcela: banco arredonda a última parcela em centavos ("10x de 100,00" com
// a décima em 100,03), e um valor no meio da chave transformaria essa última
// parcela num grupo separado — que é exatamente o cenário em que a projeção
// voltaria a contar em dobro.
//
// O preço dessa escolha é conhecido e aceito: duas compras diferentes no mesmo
// estabelecimento com o mesmo número de parcelas caem no mesmo grupo, e aí a
// projeção cobre só uma delas. Erra para MENOS (previsão conservadora), nunca
// para mais — que é a direção segura num número que o usuário usa para decidir
// gasto.
function chaveGrupoParcela(descricao, total) {
  const base = normalizarEstabelecimento(descricao);
  if (!base) return null;
  if (!Number.isInteger(total) || total < MIN_PARCELAS || total > MAX_PARCELAS) return null;
  return `${base}|${total}`;
}

// "2026-08" + 3 -> "2026-11" (vira o ano sozinho, via Date em UTC).
function somarMeses(chaveMes, n) {
  const [ano, mes] = String(chaveMes).split('-').map(Number);
  if (!Number.isInteger(ano) || !Number.isInteger(mes)) return null;
  const d = new Date(Date.UTC(ano, mes - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// projetarParcelasRestantes(linhas, opcoes) -> { 'YYYY-MM': valor }
//
// linhas: parcelas JÁ conhecidas (transações de cartão com parcela_atual/
// parcela_total/parcela_grupo gravados), cada uma como
// { cartao_id, parcela_grupo, parcela_atual, parcela_total, valor, chave }
// (chave = 'YYYY-MM' da data da transação).
//
// opcoes:
//   chavesJanela     — meses que a previsão exibe; fora dela nada é projetado
//   mesAtual         — 'YYYY-MM'; parcela cujo mês já passou não é projetada
//                      (se não apareceu como transação até hoje, não vai
//                      aparecer — projetar seria inventar despesa no passado)
//   faturaJaLancada  — Set de `${cartaoId}|${chaveMes}` com fatura real já
//                      lançada; mesma proteção do corte de faturas
//
// Regra por grupo: pega a MAIOR parcela conhecida como referência e projeta as
// seguintes, pulando todo mês em que aquele grupo já tem transação. Num banco
// que já mandou tudo (comportamento A), a maior parcela conhecida é a última —
// o laço não executa nenhuma vez e a função devolve {} sozinha.
function projetarParcelasRestantes(linhas, opcoes = {}) {
  const { chavesJanela = [], mesAtual = null, faturaJaLancada = new Set() } = opcoes;
  const janela = new Set(chavesJanela);

  const grupos = new Map();
  for (const linha of linhas || []) {
    const atual = Number(linha?.parcela_atual);
    const total = Number(linha?.parcela_total);
    if (!parcelamentoValido(atual, total)) continue;
    if (!linha.parcela_grupo || !linha.chave) continue;

    const id = `${linha.cartao_id}|${linha.parcela_grupo}`;
    const grupo = grupos.get(id) || { ref: null, mesesOcupados: new Set() };
    grupo.mesesOcupados.add(linha.chave);

    // Referência = maior número de parcela; empate desempata pela data mais
    // recente (dado inconsistente não pode fazer a projeção andar para trás).
    const melhor = !grupo.ref
      || atual > grupo.ref.atual
      || (atual === grupo.ref.atual && linha.chave > grupo.ref.chave);
    if (melhor) {
      grupo.ref = {
        atual,
        total,
        valor: Number(linha.valor) || 0,
        chave: linha.chave,
        cartaoId: linha.cartao_id,
      };
    }
    grupos.set(id, grupo);
  }

  const porMes = {};
  for (const { ref, mesesOcupados } of grupos.values()) {
    if (!ref || !(ref.valor > 0)) continue;

    for (let k = ref.atual + 1; k <= ref.total; k++) {
      const alvo = somarMeses(ref.chave, k - ref.atual);
      if (!alvo) break;
      if (!janela.has(alvo)) continue;
      if (mesAtual && alvo < mesAtual) continue;
      // Já existe transação desse grupo nesse mês: a parcela chegou pela
      // Pluggy e já está contada pelos cortes de lançadas/faturas.
      if (mesesOcupados.has(alvo)) continue;
      if (faturaJaLancada.has(`${ref.cartaoId}|${alvo}`)) continue;

      porMes[alvo] = (porMes[alvo] || 0) + ref.valor;
    }
  }

  return porMes;
}

module.exports = {
  extrairParcelamento,
  chaveGrupoParcela,
  projetarParcelasRestantes,
  somarMeses,
  MIN_PARCELAS,
  MAX_PARCELAS,
};
