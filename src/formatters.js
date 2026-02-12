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

  let totalDespesas = 0;
  let totalReceitas = 0;

  let msg = '⏳ *Contas pendentes:*\n\n';
  for (const t of transacoes) {
    const emoji = t.tipo === 'receita' ? '🟢' : '🔴';
    msg += `${emoji} #${t.id} | ${formatarData(t.data)} | ${formatarMoeda(t.valor)}\n`;
    msg += `   _${t.descricao}_ (${t.categoria})\n\n`;
    if (t.tipo === 'despesa') totalDespesas += t.valor;
    else totalReceitas += t.valor;
  }

  msg += `━━━━━━━━━━━━━━━\n`;
  if (totalDespesas > 0) msg += `💸 *Total a pagar:* ${formatarMoeda(totalDespesas)}\n`;
  if (totalReceitas > 0) msg += `💰 *Total a receber:* ${formatarMoeda(totalReceitas)}\n`;
  msg += `\n_Para liquidar: *pagar #ID*_`;

  return msg;
}

function formatarSaldos(saldos) {
  const { saldoAtual, saldoPrevisao, receitasPagas, despesasPagas, receitasPendentes, despesasPendentes } = saldos;

  let msg = `💼 *Seus saldos:*\n\n`;
  msg += `${saldoAtual >= 0 ? '✅' : '🔴'} *Saldo Atual:* ${formatarMoeda(saldoAtual)}\n`;
  msg += `   Receitas recebidas: ${formatarMoeda(receitasPagas)}\n`;
  msg += `   Despesas pagas: ${formatarMoeda(despesasPagas)}\n`;
  msg += `\n━━━━━━━━━━━━━━━\n\n`;
  msg += `${saldoPrevisao >= 0 ? '🔮✅' : '🔮🔴'} *Saldo Previsão:* ${formatarMoeda(saldoPrevisao)}\n`;
  if (receitasPendentes > 0) msg += `   A receber: +${formatarMoeda(receitasPendentes)}\n`;
  if (despesasPendentes > 0) msg += `   A pagar: -${formatarMoeda(despesasPendentes)}\n`;

  if (receitasPendentes === 0 && despesasPendentes === 0) {
    msg += `   _Sem pendências - saldo atual = previsão_`;
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
  MESES,
};
