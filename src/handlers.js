const db = require('./database');
const fmt = require('./formatters');
const { interpretarMensagem } = require('./ai');

function parseValor(str) {
  // Aceita formatos: 100 | 100.50 | 100,50 | 1.000,50 | R$ 100,50
  const limpo = str.replace(/r\$\s*/i, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const valor = parseFloat(limpo);
  if (isNaN(valor) || valor <= 0) return null;
  return valor;
}

function parseData(str) {
  if (!str) return null;
  // Aceita dd/mm/aaaa ou dd/mm
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
  return `🤖 *Assistente Financeiro BoiaClaude*

Olá! Eu ajudo você a controlar suas finanças pelo WhatsApp.

📝 *Cadastrar lançamentos:*
• *despesa* <valor> <descrição> [categoria] [data]
• *receita* <valor> <descrição> [categoria] [data]

_Exemplos:_
• despesa 50 Almoço restaurante Alimentação
• receita 3000 Salário mensal Salário
• despesa 150,90 Conta de luz Moradia 05/02
• despesa 89.90 Uber Transporte 15/01/2025

📊 *Resumos:*
• *resumo* - Resumo do mês atual
• *resumo* <mês> - Resumo de um mês (ex: resumo 01)
• *resumo anual* - Resumo do ano
• *resumo anual* <ano> - Resumo de um ano específico

📋 *Listagens:*
• *lista* - Últimos 10 lançamentos
• *lista despesas* - Últimas despesas
• *lista receitas* - Últimas receitas

🗑️ *Outros:*
• *excluir* <id> - Excluir um lançamento
• *categorias* - Ver categorias disponíveis
• *ajuda* - Mostrar esta mensagem

🤖 *Linguagem natural (IA):*
Você também pode escrever naturalmente:
• _"gastei 50 reais no almoço"_
• _"recebi 3000 de salário"_
• _"paguei 120 de conta de luz ontem"_`;
}

async function handleMessage(usuarioId, texto) {
  const msg = texto.trim();
  const lower = msg.toLowerCase();

  // Comando: ajuda / menu / help / start
  if (['ajuda', 'menu', 'help', '/start', 'oi', 'olá', 'ola', 'hi', 'hello'].includes(lower)) {
    return ajudaMsg();
  }

  // Comando: categorias
  if (lower === 'categorias') {
    const cats = await db.listarCategorias();
    return `📂 *Categorias disponíveis:*\n\n${cats.map(c => `• ${c}`).join('\n')}`;
  }

  // Comando: despesa / receita
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

  // Mensagem não reconhecida → tentar interpretar com IA
  return await handleMensagemIA(usuarioId, msg);
}

async function handleTransacao(usuarioId, msg) {
  const partes = msg.split(/\s+/);
  const tipo = partes[0].toLowerCase(); // despesa ou receita

  if (partes.length < 3) {
    return `❌ Formato: *${tipo}* <valor> <descrição> [categoria] [data]\n\nExemplo: ${tipo} 50 Almoço restaurante Alimentação`;
  }

  const valor = parseValor(partes[1]);
  if (!valor) {
    return `❌ Valor inválido: "${partes[1]}"\n\nUse formatos como: 50 | 100,50 | 1.500,00`;
  }

  // Tentar identificar data (último argumento no formato dd/mm ou dd/mm/aaaa)
  let data = null;
  let fimDescricao = partes.length;
  const ultimaParte = partes[partes.length - 1];
  if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(ultimaParte)) {
    data = parseData(ultimaParte);
    fimDescricao--;
  }

  // Tentar identificar categoria (verificar se alguma palavra bate com categorias)
  const categorias = await db.listarCategorias();
  let categoria = null;

  // Checar se a penúltima (ou última, se não tem data) palavra é uma categoria
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

  // Resumo anual
  if (lower.startsWith('resumo anual')) {
    const partes = lower.split(/\s+/);
    const ano = partes[2] && /^\d{4}$/.test(partes[2]) ? parseInt(partes[2]) : undefined;
    const resumo = await db.resumoAnual(usuarioId, ano);
    return fmt.formatarResumoAnual(resumo);
  }

  // Resumo mensal
  const partes = lower.split(/\s+/);
  let mes, ano;

  if (partes[1]) {
    // resumo 01 ou resumo 01/2025
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

async function handleMensagemIA(usuarioId, texto) {
  const resultado = await interpretarMensagem(texto);

  if (!resultado) {
    return `Não entendi sua mensagem. Digite *ajuda* para ver os comandos disponíveis.`;
  }

  if (resultado.acao === 'nenhuma') {
    return `Não identifiquei uma transação financeira na sua mensagem.\n\nDigite *ajuda* para ver como registrar despesas e receitas.`;
  }

  if (resultado.acao === 'comando') {
    return `Parece que você quer usar um comando. Tente digitar: *${resultado.dica || 'ajuda'}*`;
  }

  if (resultado.acao === 'transacao') {
    const { tipo, valor, descricao, categoria, data } = resultado;

    if (!tipo || !valor || !descricao) {
      return `Não consegui extrair todas as informações. Tente ser mais específico.\n\nExemplo: _"gastei 50 reais no almoço"_`;
    }

    if (valor <= 0) {
      return `❌ O valor precisa ser positivo.`;
    }

    // Converter data dd/mm/aaaa para yyyy-mm-dd
    let dataFormatada = null;
    if (data) {
      dataFormatada = parseData(data);
    }

    const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFormatada);
    const emoji = tipo === 'receita' ? '✅💰' : '✅💸';
    const dataExibir = dataFormatada ? fmt.formatarData(dataFormatada) : 'Hoje';

    return `${emoji} *${tipo.charAt(0).toUpperCase() + tipo.slice(1)} registrada!*\n\n` +
      `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
      `📝 Descrição: ${descricao}\n` +
      `📂 Categoria: ${categoria || 'Outros'}\n` +
      `📅 Data: ${dataExibir}\n` +
      `🆔 ID: #${result.lastInsertRowid}\n\n` +
      `🤖 _Interpretado por IA_`;
  }

  return `Não entendi sua mensagem. Digite *ajuda* para ver os comandos disponíveis.`;
}

module.exports = { handleMessage };
