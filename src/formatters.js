const MESES = [
  '', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
];

function formatarMoeda(valor) {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(dataStr) {
  const [ano, mes, dia] = dataStr.split('-');
  return `${dia}/${mes}/${ano}`;
}

function formatarResumoMensal(resumo) {
  const { mes, ano, totais, porCategoria } = resumo;
  let receitasPagas = 0, receitasPendentes = 0;
  let despesasPagas = 0, despesasPendentes = 0;
  let qtdReceitas = 0, qtdDespesas = 0;

  for (const t of totais) {
    if (t.tipo === 'receita') {
      qtdReceitas += t.quantidade;
      if (t.status === 'pago') receitasPagas = t.total;
      else receitasPendentes = t.total;
    } else {
      qtdDespesas += t.quantidade;
      if (t.status === 'pago') despesasPagas = t.total;
      else despesasPendentes = t.total;
    }
  }

  const totalReceitas = receitasPagas + receitasPendentes;
  const totalDespesas = despesasPagas + despesasPendentes;
  const saldoAtual = receitasPagas - despesasPagas;
  const saldoPrevisao = totalReceitas - totalDespesas;

  let msg = `📊 *Resumo de ${MESES[mes]}/${ano}*\n\n`;
  msg += `💰 *Receitas:* ${formatarMoeda(totalReceitas)} (${qtdReceitas} lanç.)`;
  if (receitasPendentes > 0) msg += `\n   ├ Recebidas: ${formatarMoeda(receitasPagas)} | A receber: ${formatarMoeda(receitasPendentes)}`;
  msg += `\n💸 *Despesas:* ${formatarMoeda(totalDespesas)} (${qtdDespesas} lanç.)`;
  if (despesasPendentes > 0) msg += `\n   ├ Pagas: ${formatarMoeda(despesasPagas)} | A pagar: ${formatarMoeda(despesasPendentes)}`;
  msg += `\n━━━━━━━━━━━━━━━\n`;
  msg += `${saldoAtual >= 0 ? '✅' : '🔴'} *Saldo Atual:* ${formatarMoeda(saldoAtual)}\n`;
  if (receitasPendentes > 0 || despesasPendentes > 0) {
    msg += `${saldoPrevisao >= 0 ? '🔮✅' : '🔮🔴'} *Saldo Previsão:* ${formatarMoeda(saldoPrevisao)}\n`;
  }

  if (porCategoria.length > 0) {
    const despesasCat = porCategoria.filter(c => c.tipo === 'despesa');
    const receitasCat = porCategoria.filter(c => c.tipo === 'receita');

    if (despesasCat.length > 0) {
      msg += `\n📋 *Despesas por categoria:*\n`;
      for (const c of despesasCat) {
        const pct = totalDespesas > 0 ? ((c.total / totalDespesas) * 100).toFixed(1) : 0;
        msg += `  • ${c.categoria}: ${formatarMoeda(c.total)} (${pct}%)\n`;
      }
    }

    if (receitasCat.length > 0) {
      msg += `\n📋 *Receitas por categoria:*\n`;
      for (const c of receitasCat) {
        msg += `  • ${c.categoria}: ${formatarMoeda(c.total)}\n`;
      }
    }
  }

  if (totalReceitas === 0 && totalDespesas === 0) {
    msg = `📊 *Resumo de ${MESES[mes]}/${ano}*\n\nNenhum lançamento encontrado neste mês.`;
  }

  return msg;
}

function formatarResumoAnual(resumo) {
  const { ano, meses } = resumo;

  if (meses.length === 0) {
    return `📊 *Resumo Anual ${ano}*\n\nNenhum lançamento encontrado neste ano.`;
  }

  let msg = `📊 *Resumo Anual ${ano}*\n\n`;
  let totalReceitasAno = 0;
  let totalDespesasAno = 0;

  // Agrupar por mês
  const porMes = {};
  for (const m of meses) {
    const mesNum = parseInt(m.mes, 10);
    if (!porMes[mesNum]) porMes[mesNum] = { receitas: 0, despesas: 0 };
    if (m.tipo === 'receita') {
      porMes[mesNum].receitas = m.total;
      totalReceitasAno += m.total;
    } else {
      porMes[mesNum].despesas = m.total;
      totalDespesasAno += m.total;
    }
  }

  for (const [mesNum, dados] of Object.entries(porMes)) {
    const saldo = dados.receitas - dados.despesas;
    const emoji = saldo >= 0 ? '✅' : '🔴';
    msg += `${emoji} *${MESES[mesNum]}:* ${formatarMoeda(saldo)} (R: ${formatarMoeda(dados.receitas)} | D: ${formatarMoeda(dados.despesas)})\n`;
  }

  const saldoAno = totalReceitasAno - totalDespesasAno;
  msg += `\n━━━━━━━━━━━━━━━\n`;
  msg += `💰 *Total Receitas:* ${formatarMoeda(totalReceitasAno)}\n`;
  msg += `💸 *Total Despesas:* ${formatarMoeda(totalDespesasAno)}\n`;
  msg += `${saldoAno >= 0 ? '✅' : '🔴'} *Saldo Anual:* ${formatarMoeda(saldoAno)}`;

  return msg;
}

function formatarListaTransacoes(transacoes) {
  if (transacoes.length === 0) {
    return '📋 Nenhum lançamento encontrado.';
  }

  let msg = '📋 *Últimos lançamentos:*\n\n';
  for (const t of transacoes) {
    const emoji = t.tipo === 'receita' ? '🟢' : '🔴';
    const statusTag = t.status === 'pendente' ? ' ⏳' : '';
    msg += `${emoji} #${t.id} | ${formatarData(t.data)} | ${formatarMoeda(t.valor)}${statusTag}\n`;
    msg += `   _${t.descricao}_ (${t.categoria})\n\n`;
  }
  return msg.trim();
}

function formatarPendentes(transacoes) {
  if (transacoes.length === 0) {
    return '✅ Nenhuma conta pendente! Tudo em dia.';
  }

  const despesas = transacoes.filter(t => t.tipo === 'despesa');
  const receitas = transacoes.filter(t => t.tipo === 'receita');

  let msg = '';

  if (despesas.length > 0) {
    const totalDespesas = despesas.reduce((s, t) => s + t.valor, 0);
    msg += '💸 *A pagar:*\n\n';
    for (const t of despesas) {
      msg += `🔴 ${formatarData(t.data)} | ${formatarMoeda(t.valor)}\n`;
      msg += `   _${t.descricao}_ (${t.categoria})\n\n`;
    }
    msg += `*Total:* ${formatarMoeda(totalDespesas)}\n`;
  }

  if (receitas.length > 0) {
    const totalReceitas = receitas.reduce((s, t) => s + t.valor, 0);
    if (msg) msg += `\n━━━━━━━━━━━━━━━\n\n`;
    msg += '💰 *A receber:*\n\n';
    for (const t of receitas) {
      msg += `🟢 ${formatarData(t.data)} | ${formatarMoeda(t.valor)}\n`;
      msg += `   _${t.descricao}_ (${t.categoria})\n\n`;
    }
    msg += `*Total:* ${formatarMoeda(totalReceitas)}\n`;
  }

  return msg;
}

// patrimonio é opcional: quando vem (de db.calcularPatrimonio), o bloco é
// exibido SEMPRE itemizado. "Investimentos" aqui significa ativo real
// sincronizado do banco; reserva manual aparece na própria linha, porque as
// duas podem ser o mesmo dinheiro e somá-las às cegas esconderia isso.
// Patrimônio NUNCA sai como número nu — sempre com a composição visível.
// Linhas de valor zero são omitidas para não poluir quem não usa o recurso,
// mas o total é sempre a soma explícita do que está impresso acima dele.
function formatarPatrimonio(p) {
  const { saldoContas, reservas, investimentos, faturaCartao, total } = p;

  let msg = `\n━━━━━━━━━━━━━━━\n\n💼 *Patrimônio:* ${formatarMoeda(total)}\n`;
  msg += `   Saldo em contas: ${formatarMoeda(saldoContas)}\n`;
  if (reservas > 0)     msg += `   Reservas: +${formatarMoeda(reservas)}\n`;
  if (investimentos > 0) msg += `   Investimentos: +${formatarMoeda(investimentos)}\n`;
  if (faturaCartao > 0)  msg += `   Fatura do cartão: -${formatarMoeda(faturaCartao)}\n`;

  return msg;
}

function formatarSaldos(saldos, patrimonio = null) {
  const { saldoAtual, saldoPrevisao, receitasPagas, despesasPagas, receitasPendentes, despesasPendentes, totalCaixinhas } = saldos;

  let msg = `💼 *Seus saldos:*\n\n`;
  msg += `${saldoAtual >= 0 ? '✅' : '🔴'} *Saldo Atual:* ${formatarMoeda(saldoAtual)}\n`;
  msg += `   Receitas recebidas: ${formatarMoeda(receitasPagas)}\n`;
  msg += `   Despesas pagas: ${formatarMoeda(despesasPagas)}\n`;

  // O bloco de patrimônio só aparece quando ele de fato diverge do saldo em
  // conta — ou seja, quando existe reserva, investimento ou fatura aberta. Sem
  // nenhum dos três, patrimônio e saldo são o mesmo número, e repeti-lo só
  // polui a mensagem de quem ainda não usa esses recursos.
  const patrimonioDivergeDoSaldo = patrimonio
    && (patrimonio.reservas > 0 || patrimonio.investimentos > 0 || patrimonio.faturaCartao > 0);

  if (patrimonioDivergeDoSaldo) {
    msg += formatarPatrimonio(patrimonio);
  } else if (totalCaixinhas > 0) {
    msg += `\n🏦 *Reservas:* +${formatarMoeda(totalCaixinhas)}\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━\n\n`;
  msg += `${saldoPrevisao >= 0 ? '🔮✅' : '🔮🔴'} *Saldo Previsão (mês):* ${formatarMoeda(saldoPrevisao)}\n`;
  if (receitasPendentes > 0) msg += `   A receber: +${formatarMoeda(receitasPendentes)}\n`;
  if (despesasPendentes > 0) msg += `   A pagar: -${formatarMoeda(despesasPendentes)}\n`;

  if (receitasPendentes === 0 && despesasPendentes === 0) {
    msg += `   _Sem pendências - saldo atual = previsão_`;
  }

  return msg;
}

// Investimentos sincronizados do banco (ativo real: emissor, taxa, vencimento).
// NÃO é a mesma coisa que Reservas, que são as caixinhas manuais do usuário.
//
// Agrupa por EMISSOR, não por tipo: uma carteira de renda fixa costuma ter
// dezenas de posições que colapsam numa linha só se agrupadas por tipo
// ("FIXED_INCOME"), enquanto emissor mostra concentração de risco de crédito,
// que é a informação acionável. Listar posição a posição não cabe no WhatsApp.
function formatarInvestimentos(resumo) {
  const { total, totalAplicado, totalLucro, quantidade, porEmissor } = resumo;

  if (!quantidade) {
    return `📈 Não encontrei investimentos sincronizados.\n\n_Conecte seu banco em Configurações para trazer suas aplicações automaticamente._`;
  }

  let msg = `📈 *Seus investimentos:* ${formatarMoeda(total)}\n`;
  msg += `_${quantidade} ${quantidade === 1 ? 'ativo' : 'ativos'}_\n`;

  if (totalAplicado > 0) {
    msg += `\n   Aplicado: ${formatarMoeda(totalAplicado)}\n`;
    if (totalLucro !== 0) {
      const pct = totalAplicado > 0 ? (totalLucro / totalAplicado) * 100 : 0;
      msg += `   Rendimento: ${totalLucro >= 0 ? '+' : ''}${formatarMoeda(totalLucro)} (${pct.toFixed(1)}%)\n`;
    }
  }

  if (porEmissor?.length) {
    msg += `\n*Por emissor:*\n`;
    for (const e of porEmissor.slice(0, 8)) {
      msg += `• ${e.emissor} — ${formatarMoeda(e.total)} _(${e.quantidade})_\n`;
    }
    if (porEmissor.length > 8) {
      msg += `_... e mais ${porEmissor.length - 8} ${porEmissor.length - 8 === 1 ? 'emissor' : 'emissores'}. Veja tudo no painel._\n`;
    }
  }

  return msg;
}

module.exports = {
  formatarMoeda,
  formatarData,
  formatarResumoMensal,
  formatarResumoAnual,
  formatarListaTransacoes,
  formatarPendentes,
  formatarSaldos,
  formatarPatrimonio,
  formatarInvestimentos,
  MESES,
};
