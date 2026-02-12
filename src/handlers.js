const db = require('./database');
const fmt = require('./formatters');
const { interpretarMensagem, analisarImagem } = require('./ai');

// Estado temporário para confirmações pendentes (expira em 5 min)
const confirmacoesPendentes = new Map();

function salvarConfirmacao(usuarioId, dados) {
  confirmacoesPendentes.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 5 * 60 * 1000,
  });
}

function obterConfirmacao(usuarioId) {
  const dados = confirmacoesPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    confirmacoesPendentes.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparConfirmacao(usuarioId) {
  confirmacoesPendentes.delete(usuarioId);
}

function parseValor(str) {
  const limpo = str.replace(/r\$\s*/i, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const valor = parseFloat(limpo);
  if (isNaN(valor) || valor <= 0) return null;
  return valor;
}

function parseData(str) {
  if (!str) return null;
  const partes = str.trim().split('/');
  if (partes.length === 2) {
    const [dia, mes] = partes;
    const ano = new Date().getFullYear();
    return `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  }
  if (partes.length === 3) {
    const [dia, mes, ano] = partes;
    const anoCompleto = ano.length === 2 ? `20${ano}` : ano;
    return `${anoCompleto}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  }
  return null;
}

function ajudaMsg() {
  return `🤖 *Cronos Assistente Pessoal*

Olá! Eu ajudo você a controlar suas finanças pelo WhatsApp.

📝 *Cadastrar lançamentos:*
• *despesa* <valor> <descrição> [categoria] [data]
• *receita* <valor> <descrição> [categoria] [data]

_Exemplos:_
• despesa 50 Almoço restaurante Alimentação
• receita 3000 Salário mensal Salário
• despesa 150,90 Conta de luz Moradia 05/02

💼 *Controle financeiro:*
• *saldo* - Ver saldo atual e previsão
• *pendentes* - Listar contas a pagar/receber
• *pagar* <id> - Marcar como pago/recebido

📊 *Resumos:*
• *resumo* - Resumo do mês atual
• *resumo* <mês> - Resumo de um mês (ex: resumo 01)
• *resumo anual* - Resumo do ano

📋 *Listagens:*
• *lista* - Últimos 10 lançamentos
• *lista despesas* - Últimas despesas
• *lista receitas* - Últimas receitas

⏰ *Lembretes:*
• _"me lembre daqui 10 min de pegar o Noah"_
• _"lembra às 15:00 da reunião"_
• *lembretes* - Ver lembretes ativos
• *cancelar lembrete* <id> - Cancelar lembrete

🗑️ *Outros:*
• *excluir* <id> - Excluir um lançamento
• *categorias* - Ver categorias disponíveis
• *ajuda* - Mostrar esta mensagem

💬 *Linguagem natural:*
Você também pode escrever naturalmente:
• _"gastei 50 reais no almoço"_ (registra como paga)
• _"tenho que pagar 200 de internet dia 15"_ (registra como pendente)
• _"vou receber 5000 de salário dia 05"_ (receita pendente)
• _"quanto gastei com comida esta semana?"_

🎤 *Áudio:* Envie mensagens de voz!
📸 *Imagens:* Envie fotos de boletos e notas!`;
}

async function handleMessage(usuarioId, texto) {
  const msg = texto.trim();
  const lower = msg.toLowerCase();

  // Verificar se há confirmação pendente de imagem
  const confirmacao = obterConfirmacao(usuarioId);
  if (confirmacao) {
    return await handleConfirmacaoImagem(usuarioId, lower, confirmacao);
  }

  // Comando: ajuda / menu / help
  if (['ajuda', 'menu', 'help', '/start'].includes(lower)) {
    return ajudaMsg();
  }

  // Comando: categorias
  if (lower === 'categorias') {
    const cats = await db.listarCategorias();
    return `📂 *Categorias disponíveis:*\n\n${cats.map(c => `• ${c}`).join('\n')}`;
  }

  // Comando: despesa / receita (direto)
  if (lower.startsWith('despesa ') || lower.startsWith('receita ')) {
    return await handleTransacao(usuarioId, msg);
  }

  // Comando: resumo
  if (lower.startsWith('resumo')) {
    return await handleResumo(usuarioId, msg);
  }

  // Comando: lista
  if (lower.startsWith('lista')) {
    return await handleLista(usuarioId, msg);
  }

  // Comando: excluir
  if (lower.startsWith('excluir ')) {
    return await handleExcluir(usuarioId, msg);
  }

  // Comando: saldo
  if (lower === 'saldo') {
    const saldos = await db.calcularSaldos(usuarioId);
    return fmt.formatarSaldos(saldos);
  }

  // Comando: pendentes
  if (lower === 'pendentes' || lower === 'a pagar' || lower === 'contas') {
    const pendentes = await db.listarPendentes(usuarioId);
    return fmt.formatarPendentes(pendentes);
  }

  // Comando: pagar / liquidar
  if (lower.startsWith('pagar ') || lower.startsWith('liquidar ')) {
    return await handleLiquidar(usuarioId, msg);
  }

  // Comando: meus lembretes
  if (lower === 'lembretes' || lower === 'meus lembretes') {
    return await handleListarLembretes(usuarioId);
  }

  // Comando: cancelar lembrete #ID
  if (lower.startsWith('cancelar lembrete ')) {
    return await handleCancelarLembrete(usuarioId, msg);
  }

  // IA interpreta tudo: saudações, transações, consultas, etc.
  return await handleMensagemIA(usuarioId, msg);
}

async function handleTransacao(usuarioId, msg) {
  const partes = msg.split(/\s+/);
  const tipo = partes[0].toLowerCase();

  if (partes.length < 3) {
    return `❌ Formato: *${tipo}* <valor> <descrição> [categoria] [data]\n\nExemplo: ${tipo} 50 Almoço restaurante Alimentação`;
  }

  const valor = parseValor(partes[1]);
  if (!valor) {
    return `❌ Valor inválido: "${partes[1]}"\n\nUse formatos como: 50 | 100,50 | 1.500,00`;
  }

  let data = null;
  let fimDescricao = partes.length;
  const ultimaParte = partes[partes.length - 1];
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(ultimaParte)) {
    data = parseData(ultimaParte);
    fimDescricao--;
  }

  const categorias = await db.listarCategorias();
  let categoria = null;

  const possivelCat = partes[fimDescricao - 1];
  const catEncontrada = categorias.find(c => c.toLowerCase() === possivelCat.toLowerCase());
  if (catEncontrada && fimDescricao > 3) {
    categoria = catEncontrada;
    fimDescricao--;
  }

  const descricao = partes.slice(2, fimDescricao).join(' ');
  if (!descricao) {
    return `❌ Informe uma descrição para o lançamento.`;
  }

  const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data);
  const emoji = tipo === 'receita' ? '✅💰' : '✅💸';
  const dataFormatada = data ? fmt.formatarData(data) : 'Hoje';

  return `${emoji} *${tipo.charAt(0).toUpperCase() + tipo.slice(1)} registrada!*\n\n` +
    `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
    `📝 Descrição: ${descricao}\n` +
    `📂 Categoria: ${categoria || 'Outros'}\n` +
    `📅 Data: ${dataFormatada}\n` +
    `🆔 ID: #${result.lastInsertRowid}`;
}

async function handleResumo(usuarioId, msg) {
  const lower = msg.toLowerCase().trim();

  if (lower.startsWith('resumo anual')) {
    const partes = lower.split(/\s+/);
    const ano = partes[2] && /^\d{4}$/.test(partes[2]) ? parseInt(partes[2]) : undefined;
    const resumo = await db.resumoAnual(usuarioId, ano);
    return fmt.formatarResumoAnual(resumo);
  }

  const partes = lower.split(/\s+/);
  let mes, ano;

  if (partes[1]) {
    const subPartes = partes[1].split('/');
    mes = parseInt(subPartes[0]);
    if (subPartes[1]) ano = parseInt(subPartes[1]);
  }

  const resumo = await db.resumoMensal(usuarioId, mes, ano);
  return fmt.formatarResumoMensal(resumo);
}

async function handleLista(usuarioId, msg) {
  const lower = msg.toLowerCase().trim();
  let tipo = null;

  if (lower.includes('despesa')) tipo = 'despesa';
  else if (lower.includes('receita')) tipo = 'receita';

  const transacoes = await db.listarTransacoes(usuarioId, tipo, 10);
  return fmt.formatarListaTransacoes(transacoes);
}

async function handleExcluir(usuarioId, msg) {
  const partes = msg.split(/\s+/);
  const idStr = partes[1]?.replace('#', '');
  const id = parseInt(idStr);

  if (!id || isNaN(id)) {
    return `❌ Informe o ID do lançamento para excluir.\n\nExemplo: excluir 5`;
  }

  const result = await db.excluirTransacao(usuarioId, id);
  if (result.changes === 0) {
    return `❌ Lançamento #${id} não encontrado.`;
  }

  return `🗑️ Lançamento #${id} excluído com sucesso!`;
}

async function handleConfirmacaoImagem(usuarioId, resposta, dados) {
  // Cancelar
  if (resposta === '0' || resposta === 'cancelar') {
    limparConfirmacao(usuarioId);
    return '❌ Lançamento cancelado.';
  }

  let status;
  if (resposta === '1' || resposta === 'pago' || resposta === 'sim' || resposta === 'já paguei' || resposta === 'ja paguei') {
    status = 'pago';
  } else if (resposta === '2' || resposta === 'pendente' || resposta === 'a pagar') {
    status = 'pendente';
  } else {
    // Resposta não reconhecida - manter a confirmação ativa
    return `Responda com:\n*1* - Já paguei/recebi\n*2* - A pagar/receber\n*0* - Cancelar`;
  }

  limparConfirmacao(usuarioId);

  const { tipo, valor, descricao, categoria, data } = dados;
  const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data, status);
  const dataExibir = data ? fmt.formatarData(data) : 'Hoje';

  let emoji, label;
  if (status === 'pendente') {
    emoji = tipo === 'receita' ? '⏳💰' : '⏳💸';
    label = tipo === 'receita' ? 'Receita a receber' : 'Despesa a pagar';
  } else {
    emoji = tipo === 'receita' ? '✅💰' : '✅💸';
    label = tipo === 'receita' ? 'Receita registrada' : 'Despesa registrada';
  }

  let msg = `${emoji} *${label}!*\n\n` +
    `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
    `📝 Descrição: ${descricao}\n` +
    `📂 Categoria: ${categoria || 'Outros'}\n` +
    `📅 Data: ${dataExibir}\n` +
    `🆔 ID: #${result.lastInsertRowid}`;

  if (status === 'pendente') {
    msg += `\n\n_Quando pagar, envie: *pagar #${result.lastInsertRowid}*_`;
  }

  return msg;
}

async function handleLiquidar(usuarioId, msg) {
  const partes = msg.split(/\s+/);
  const idStr = partes[1]?.replace('#', '');
  const id = parseInt(idStr);

  if (!id || isNaN(id)) {
    return `❌ Informe o ID do lançamento.\n\nExemplo: pagar #5`;
  }

  const transacao = await db.liquidarTransacao(usuarioId, id);
  if (!transacao) {
    return `❌ Lançamento #${id} não encontrado ou já está pago.`;
  }

  const emoji = transacao.tipo === 'receita' ? '💰' : '💸';
  const acao = transacao.tipo === 'receita' ? 'Recebido' : 'Pago';

  return `✅${emoji} *${acao}!* Lançamento #${transacao.id} liquidado.\n\n` +
    `📝 ${transacao.descricao}\n` +
    `💵 ${fmt.formatarMoeda(transacao.valor)}\n` +
    `📂 ${transacao.categoria}`;
}

async function processarResultadoIA(usuarioId, resultado, fallbackMsg) {
  if (!resultado) {
    return fallbackMsg || `Não entendi sua mensagem. Digite *ajuda* para ver os comandos disponíveis.`;
  }

  // Saudação - resposta amigável da IA
  if (resultado.acao === 'saudacao') {
    return resultado.resposta;
  }

  // Lembrete geral
  if (resultado.acao === 'lembrete') {
    return await handleLembrete(usuarioId, resultado);
  }

  // Consulta - buscar no banco e formatar resultado
  if (resultado.acao === 'consulta') {
    return await handleConsulta(usuarioId, resultado);
  }

  // Mensagem não financeira - resposta gentil da IA
  if (resultado.acao === 'nenhuma') {
    return resultado.resposta || `Não identifiquei uma transação financeira na sua mensagem.\n\nDigite *ajuda* para ver como registrar despesas e receitas.`;
  }

  // Comando sugerido
  if (resultado.acao === 'comando') {
    // Executar diretamente comandos de saldo/pendentes
    if (resultado.dica === 'saldo') {
      const saldos = await db.calcularSaldos(usuarioId);
      return fmt.formatarSaldos(saldos);
    }
    if (resultado.dica === 'pendentes') {
      const pendentes = await db.listarPendentes(usuarioId);
      return fmt.formatarPendentes(pendentes);
    }
    return `Parece que você quer usar um comando. Tente digitar: *${resultado.dica || 'ajuda'}*`;
  }

  // Transação via IA
  if (resultado.acao === 'transacao') {
    const { tipo, valor, descricao, categoria, data, status } = resultado;

    if (!tipo || !valor || !descricao) {
      return `Não consegui extrair todas as informações. Tente ser mais específico.\n\nExemplo: _"gastei 50 reais no almoço"_`;
    }

    if (valor <= 0) {
      return `❌ O valor precisa ser positivo.`;
    }

    // data já vem em YYYY-MM-DD do novo prompt
    let dataFinal = data || null;
    // Se vier no formato dd/mm/aaaa (fallback), converter
    if (dataFinal && dataFinal.includes('/')) {
      dataFinal = parseData(dataFinal);
    }

    const statusFinal = status === 'pendente' ? 'pendente' : 'pago';
    const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal);
    const dataExibir = dataFinal ? fmt.formatarData(dataFinal) : 'Hoje';

    let emoji, label;
    if (statusFinal === 'pendente') {
      emoji = tipo === 'receita' ? '⏳💰' : '⏳💸';
      label = tipo === 'receita' ? 'Receita a receber' : 'Despesa a pagar';
    } else {
      emoji = tipo === 'receita' ? '✅💰' : '✅💸';
      label = tipo === 'receita' ? 'Receita registrada' : 'Despesa registrada';
    }

    let msg = `${emoji} *${label}!*\n\n` +
      `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
      `📝 Descrição: ${descricao}\n` +
      `📂 Categoria: ${categoria || 'Outros'}\n` +
      `📅 Data: ${dataExibir}\n` +
      `🆔 ID: #${result.lastInsertRowid}`;

    if (statusFinal === 'pendente') {
      msg += `\n\n_Quando pagar, envie: *pagar #${result.lastInsertRowid}*_`;
    }

    return msg;
  }

  return `Não entendi sua mensagem. Digite *ajuda* para ver os comandos disponíveis.`;
}

async function handleMensagemIA(usuarioId, texto) {
  const resultado = await interpretarMensagem(texto);

  if (!resultado) {
    const saudacoes = ['oi', 'olá', 'ola', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'e aí', 'eai'];
    if (saudacoes.some(s => texto.toLowerCase().includes(s))) {
      return ajudaMsg();
    }
  }

  return await processarResultadoIA(usuarioId, resultado);
}

async function handleImageMessage(usuarioId, base64Data, mimetype) {
  const resultado = await analisarImagem(base64Data, mimetype);

  if (!resultado) {
    return '❌ Não consegui analisar a imagem. Envie uma foto clara de um boleto, nota fiscal ou cupom.';
  }

  // Se não for transação (ex: imagem não financeira), processar normalmente
  if (resultado.acao !== 'transacao') {
    return resultado.resposta || 'Não identifiquei um documento financeiro nesta imagem.';
  }

  const { tipo, valor, descricao, categoria, data } = resultado;

  if (!tipo || !valor || !descricao) {
    return '❌ Não consegui extrair as informações do documento. Tente enviar uma foto mais nítida.';
  }

  let dataFinal = data || null;
  if (dataFinal && dataFinal.includes('/')) {
    dataFinal = parseData(dataFinal);
  }

  // Salvar dados temporários e perguntar o status
  salvarConfirmacao(usuarioId, { tipo, valor, descricao, categoria, data: dataFinal });

  const dataExibir = dataFinal ? fmt.formatarData(dataFinal) : 'Hoje';
  const emoji = tipo === 'receita' ? '💰' : '💸';

  return `📄${emoji} *Documento identificado:*\n\n` +
    `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
    `📝 Descrição: ${descricao}\n` +
    `📂 Categoria: ${categoria || 'Outros'}\n` +
    `📅 Data: ${dataExibir}\n\n` +
    `Esse lançamento já foi pago ou ainda está pendente?\n\n` +
    `*1* - ✅ Já paguei / Já recebi\n` +
    `*2* - ⏳ A pagar / A receber\n` +
    `*0* - ❌ Cancelar`;
}

async function handleLembrete(usuarioId, resultado) {
  const { minutos, horario, mensagem, amanha } = resultado;

  if (!mensagem) {
    return '❌ Não entendi o que devo lembrar. Tente algo como:\n\n_"me lembre daqui 10 minutos de pegar o Noah"_\n_"lembra às 15:00 da reunião"_';
  }

  let disparaEm;
  const agora = new Date();

  if (horario) {
    // Horário fixo (ex: "às 15:00")
    const [h, m] = horario.split(':').map(Number);
    disparaEm = new Date(agora);
    disparaEm.setHours(h, m, 0, 0);

    // Se for amanhã ou se o horário já passou hoje
    if (amanha || disparaEm <= agora) {
      disparaEm.setDate(disparaEm.getDate() + 1);
    }
  } else if (minutos && minutos > 0) {
    // Daqui X minutos
    disparaEm = new Date(agora.getTime() + minutos * 60 * 1000);
  } else {
    return '❌ Não entendi quando devo te lembrar. Tente algo como:\n\n_"me lembre daqui 30 minutos"_\n_"me avisa às 14:00"_';
  }

  const id = await db.criarLembreteGeral(usuarioId, mensagem, disparaEm);

  // Formatar horário para exibição
  const horaStr = disparaEm.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const hoje = new Date();
  const amanhaDia = new Date(hoje);
  amanhaDia.setDate(amanhaDia.getDate() + 1);

  let quando;
  if (disparaEm.toDateString() === hoje.toDateString()) {
    quando = `hoje às ${horaStr}`;
  } else if (disparaEm.toDateString() === amanhaDia.toDateString()) {
    quando = `amanhã às ${horaStr}`;
  } else {
    quando = `${disparaEm.toLocaleDateString('pt-BR')} às ${horaStr}`;
  }

  if (minutos && minutos > 0 && !horario) {
    const mins = minutos;
    let tempoStr;
    if (mins < 60) {
      tempoStr = `${mins} minuto${mins > 1 ? 's' : ''}`;
    } else {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      tempoStr = `${h} hora${h > 1 ? 's' : ''}`;
      if (m > 0) tempoStr += ` e ${m} min`;
    }
    return `⏰ *Lembrete criado!*\n\n📝 ${mensagem}\n🕐 Daqui ${tempoStr} (${quando})\n🆔 #${id}\n\n_Para cancelar: *cancelar lembrete #${id}*_`;
  }

  return `⏰ *Lembrete criado!*\n\n📝 ${mensagem}\n🕐 ${quando}\n🆔 #${id}\n\n_Para cancelar: *cancelar lembrete #${id}*_`;
}

async function handleListarLembretes(usuarioId) {
  const lembretes = await db.listarLembretesGerais(usuarioId);

  if (lembretes.length === 0) {
    return '⏰ Nenhum lembrete ativo no momento.';
  }

  let msg = '⏰ *Seus lembretes:*\n\n';
  for (const l of lembretes) {
    msg += `🔔 *#${l.id}* - ${l.mensagem}\n   📅 ${l.horario}\n\n`;
  }
  msg += '_Para cancelar: *cancelar lembrete #ID*_';
  return msg;
}

async function handleCancelarLembrete(usuarioId, msg) {
  const idStr = msg.replace(/cancelar lembrete\s*/i, '').replace('#', '').trim();
  const id = parseInt(idStr);

  if (!id || isNaN(id)) {
    return '❌ Informe o ID do lembrete.\n\nExemplo: cancelar lembrete #5';
  }

  const resultado = await db.cancelarLembreteGeral(usuarioId, id);
  if (!resultado) {
    return `❌ Lembrete #${id} não encontrado ou já foi enviado.`;
  }

  return `✅ Lembrete #${id} cancelado!\n\n_"${resultado.mensagem}"_`;
}

async function handleConsulta(usuarioId, consulta) {
  const filtros = {
    tipo: consulta.tipo || null,
    categoria: consulta.categoria || null,
    dataInicio: consulta.dataInicio || null,
    dataFim: consulta.dataFim || null,
    descricao: consulta.descricao || null,
  };

  const [transacoes, totais] = await Promise.all([
    db.consultarTransacoes(usuarioId, filtros),
    db.consultarTotalTransacoes(usuarioId, filtros),
  ]);

  if (totais.quantidade === 0) {
    return `🔍 *${consulta.pergunta || 'Consulta'}*\n\nNenhum lançamento encontrado para esta busca.`;
  }

  let msg = `🔍 *${consulta.pergunta || 'Consulta'}*\n\n`;
  msg += `💰 *Total:* ${fmt.formatarMoeda(totais.total)} (${totais.quantidade} lançamento${totais.quantidade > 1 ? 's' : ''})\n`;

  if (transacoes.length > 0) {
    msg += `\n📋 *Detalhes:*\n`;
    for (const t of transacoes.slice(0, 10)) {
      const emoji = t.tipo === 'receita' ? '🟢' : '🔴';
      msg += `${emoji} ${fmt.formatarData(t.data)} | ${fmt.formatarMoeda(t.valor)} | _${t.descricao}_ (${t.categoria})\n`;
    }

    if (transacoes.length > 10) {
      msg += `\n_... e mais ${transacoes.length - 10} lançamentos_`;
    }
  }

  // sem rodapé de IA
  return msg;
}

module.exports = { handleMessage, handleImageMessage };
