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
  let totalReceitas = 0;
  let totalDespesas = 0;
  let qtdReceitas = 0;
  let qtdDespesas = 0;

  for (const t of totais) {
    if (t.tipo === 'receita') {
      totalReceitas = t.total;
      qtdReceitas = t.quantidade;
    } else {
      totalDespesas = t.total;
      qtdDespesas = t.quantidade;
    }
  }

  const saldo = totalReceitas - totalDespesas;

  let msg = `📊 *Resumo de ${MESES[mes]}/${ano}*\n\n`;
  msg += `💰 *Receitas:* ${formatarMoeda(totalReceitas)} (${qtdReceitas} lançamentos)\n`;
  msg += `💸 *Despesas:* ${formatarMoeda(totalDespesas)} (${qtdDespesas} lançamentos)\n`;
  msg += `━━━━━━━━━━━━━━━\n`;
  msg += `${saldo >= 0 ? '✅' : '🔴'} *Saldo:* ${formatarMoeda(saldo)}\n`;

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
    msg += `${emoji} #${t.id} | ${formatarData(t.data)} | ${formatarMoeda(t.valor)}\n`;
    msg += `   _${t.descricao}_ (${t.categoria})\n\n`;
  }
  return msg.trim();
}

module.exports = {
  formatarMoeda,
  formatarData,
  formatarResumoMensal,
  formatarResumoAnual,
  formatarListaTransacoes,
  MESES,
};
