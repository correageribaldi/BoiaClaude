const db = require('./database');
const fmt = require('./formatters');
const { interpretarMensagem, analisarImagem, formatarResultadosPesquisa, interpretarItemFinanceiro } = require('./ai');
const { pesquisarWeb } = require('./search');
const charts = require('./charts');

// Estado temporário para confirmações pendentes (expira em 5 min)
const confirmacoesPendentes = new Map();

// Estado do fluxo Ponto Zero (expira em 30 min)
const pontoZeroEstados = new Map();

function salvarPontoZero(usuarioId, dados) {
  pontoZeroEstados.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 30 * 60 * 1000,
  });
}

function obterPontoZero(usuarioId) {
  const dados = pontoZeroEstados.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    pontoZeroEstados.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparPontoZero(usuarioId) {
  pontoZeroEstados.delete(usuarioId);
}

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

function mensagemBoasVindas(nome) {
  const nomeExibir = nome || 'amigo(a)';
  return `Fala ${nomeExibir}, aqui é o Cronos, teu Assistente Pessoal. 👋😄

A partir de agora eu vou te ajudar a organizar a vida, otimizar teu tempo e gerenciar teu dinheiro do jeito certo. E sim: eu também vou te lembrar de tudo que você me pedir (sem dó 😂).

Pra ficar bem fácil, olha o que eu consigo fazer por aqui:

✅ *Finanças (bem prático)*
• Registrar receitas e despesas
• Organizar por categoria (mercado, gasolina, contas, lazer, etc.)
• Montar um resumo do mês e te mostrar pra onde o dinheiro tá indo
• Você pode mandar por texto, áudio, ou até foto de boleto/cupom/nota que eu registro pra você

✅ *Tarefas e rotina*
• Criar tarefas e compromissos
• Definir horários e recorrência (todo dia, toda semana, datas específicas)
• Te lembrar do jeito certo pra não ter desculpa… tipo "academia 10:00" — e eu vou cobrar 😅

✅ *Organização do dia a dia*
• Checklists, prioridades, lembretes rápidos
• "Me ajuda a planejar meu dia" e eu te devolvo um plano simples e direto

Agora me diz como você quer começar:
*1.* 🎯 *Ponto Zero* — Em 2 min eu organizo teu financeiro (saldo, contas a pagar/receber e gastos fixos)
*2.* Criar teus primeiros lembretes/tarefas (tipo remédio, academia, contas)
*3.* Ver tudo que eu posso fazer (eu te mando a lista completa)

_Recomendo começar pelo *1* pra eu ter a visão completa das tuas finanças!_`;
}

function foraDoEscopoMsg(nome) {
  const nomeExibir = nome ? `${nome}, ` : '';
  return `${nomeExibir}desculpa, mas eu não consigo te ajudar com isso agora 😅

Mas olha tudo que eu posso fazer por você:

💰 *Finanças*
• Registrar despesas e receitas (texto, áudio ou foto)
• Organizar por categoria
• Ver resumo do mês ou do ano
• Controlar contas pendentes e saldo

⏰ *Lembretes*
• Criar lembretes únicos (_"me lembre daqui 30 min..."_)
• Criar lembretes recorrentes (_"todo dia às 8h..."_)
• Listar e cancelar lembretes

📊 *Consultas*
• Perguntar quanto gastou em algo (_"quanto gastei com comida?"_)
• Ver lista de lançamentos
• Ver saldo e pendentes

🧠 *Assistente rápido*
• Fazer contas (_"quanto é 8000 + 300?"_)
• Conversões (_"quantos km são 10 milhas?"_)
• Dúvidas rápidas do dia a dia

🔍 *Pesquisa na internet*
• Restaurantes, cafés, lojas (_"restaurantes em Canoas"_)
• Preços e produtos (_"preço do iPhone 15"_)
• Serviços e horários (_"academia em Porto Alegre"_)

É só mandar uma mensagem e eu resolvo! 💪`;
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

🔄 *Lembretes recorrentes:*
• _"todo dia às 8h me lembra de tomar o remédio"_
• _"toda segunda às 9h me lembra da reunião"_
• _"me lembre de cortar a grama toda semana às 10h por 6 meses"_
• *recorrentes* - Ver recorrentes ativos
• *cancelar recorrente* <id> - Cancelar recorrente

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

  // Verificar se está no fluxo Ponto Zero
  const pontoZero = obterPontoZero(usuarioId);
  if (pontoZero) {
    return await handlePontoZero(usuarioId, msg, pontoZero);
  }

  // Comando: ponto zero (texto direto)
  if (lower === 'ponto zero' || lower === '1') {
    return await iniciarPontoZero(usuarioId);
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

  // Comando: agenda
  if (lower === 'agenda' || lower === 'agenda hoje' || lower === 'minha agenda') {
    return await handleAgenda(usuarioId, 'hoje');
  }
  if (lower === 'agenda amanha' || lower === 'agenda amanhã') {
    return await handleAgenda(usuarioId, 'amanha');
  }
  if (lower === 'agenda semana' || lower === 'agenda da semana') {
    return await handleAgenda(usuarioId, 'semana');
  }
  if (lower === 'agenda mes' || lower === 'agenda do mes' || lower === 'agenda do mês') {
    return await handleAgenda(usuarioId, 'mes');
  }

  // Comando: lembretes (ANTES de "lista" para não confundir)
  if (lower === 'lembretes' || lower === 'meus lembretes' || lower.includes('listar lembrete') || lower.includes('lista lembrete') || lower.includes('meus lembretes')) {
    // Se menciona "recorrente", listar só os recorrentes
    if (lower.includes('recorrente')) {
      return await handleListarRecorrentes(usuarioId);
    }
    // Caso contrário, listar todos os lembretes (únicos + recorrentes)
    return await handleListarTodosLembretes(usuarioId);
  }

  // Comando: recorrentes
  if (lower === 'recorrentes' || lower === 'lembretes recorrentes' || lower.includes('listar recorrente') || lower.includes('lista recorrente') || lower.includes('atividades recorrentes')) {
    return await handleListarRecorrentes(usuarioId);
  }

  // Comando: cancelar lembrete #ID
  if (lower.startsWith('cancelar lembrete ')) {
    return await handleCancelarLembrete(usuarioId, msg);
  }

  // Comando: cancelar recorrente #ID
  if (lower.startsWith('cancelar recorrente ') || lower.startsWith('parar lembrete ')) {
    return await handleCancelarRecorrente(usuarioId, msg);
  }

  // Comando: lista (transações financeiras - despesas/receitas)
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

  // Comando: pagar / liquidar / receber / recebi
  if (lower.startsWith('pagar ') || lower.startsWith('liquidar ') || lower.startsWith('receber ') || lower.startsWith('recebi ')) {
    return await handleLiquidar(usuarioId, msg);
  }

  // IA interpreta tudo: saudações, transações, consultas, etc. (incluindo reset)
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
  const textoResumo = fmt.formatarResumoMensal(resumo);

  // Gerar gráfico de categorias se houver despesas
  const grafico = await charts.gerarGraficoCategorias(resumo);

  // Retornar objeto com texto e gráfico (se houver)
  if (grafico) {
    return { texto: textoResumo, grafico };
  }

  return textoResumo;
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
    const quando = tipo === 'receita' ? 'receber' : 'pagar';
    msg += `\n\n_Vou te lembrar quando chegar o dia de ${quando}! 📅_`;
  }

  // Verificar limite de gastos (apenas para despesas)
  if (tipo === 'despesa' && categoria) {
    const limiteInfo = await db.verificarLimite(usuarioId, categoria);
    if (limiteInfo) {
      const { limite, gastos, restante, percentual } = limiteInfo;
      let emoji = '';
      if (percentual >= 100) emoji = '🚨';
      else if (percentual >= 80) emoji = '⚠️';
      else if (percentual >= 60) emoji = '📊';
      else emoji = '✅';

      msg += `\n\n${emoji} *Limite de ${categoria}:*\n`;
      msg += `Gasto: ${fmt.formatarMoeda(gastos)} de ${fmt.formatarMoeda(limite)} (${percentual}%)\n`;
      if (restante > 0) {
        msg += `Restam: ${fmt.formatarMoeda(restante)} este mês`;
      } else {
        msg += `⚠️ *Limite excedido em ${fmt.formatarMoeda(Math.abs(restante))}!*`;
      }
    }
  }

  return msg;
}

async function handleLiquidar(usuarioId, msg) {
  const partes = msg.split(/\s+/);
  const idStr = partes[1]?.replace('#', '');
  const id = parseInt(idStr);

  if (!id || isNaN(id)) {
    return `❌ Informe o ID do lançamento.\n\nExemplo: pagar #5 ou receber #5`;
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
    if (fallbackMsg) return fallbackMsg;
    const usuario = await db.buscarUsuario(usuarioId);
    return foraDoEscopoMsg(usuario?.nome || null);
  }

  // Ponto Zero - organizar finanças do zero
  if (resultado.acao === 'ponto_zero') {
    return await iniciarPontoZero(usuarioId);
  }

  // Saudação - verificar se é usuário novo ou existente
  if (resultado.acao === 'saudacao') {
    // Buscar nome e verificar se já tem transações cadastradas
    const usuario = await db.buscarUsuario(usuarioId);
    const nome = usuario?.nome || null;

    // Verificar se o usuário já tem alguma transação (se já usa o bot)
    const transacoes = await db.listarTransacoes(usuarioId, null, 1);
    const jaUsaBot = transacoes && transacoes.length > 0;

    if (jaUsaBot) {
      // Usuário existente - saudação curta e amigável
      const nomeExibir = nome || 'amigo(a)';
      return resultado.resposta.replace(/{{NOME}}/g, nomeExibir);
    } else {
      // Usuário novo - mensagem de boas-vindas completa
      return mensagemBoasVindas(nome);
    }
  }

  // Lembrete único
  if (resultado.acao === 'lembrete') {
    return await handleLembrete(usuarioId, resultado);
  }

  // Lembrete recorrente
  if (resultado.acao === 'lembrete_recorrente') {
    return await handleLembreteRecorrente(usuarioId, resultado);
  }

  // Listar lembretes (únicos + recorrentes)
  if (resultado.acao === 'listar_lembretes') {
    return await handleListarTodosLembretes(usuarioId);
  }

  // Listar apenas recorrentes
  if (resultado.acao === 'listar_recorrentes') {
    return await handleListarRecorrentes(usuarioId);
  }

  // Agenda - visão geral do dia/semana/mês
  if (resultado.acao === 'agenda') {
    return await handleAgenda(usuarioId, resultado.periodo || 'hoje');
  }

  // Consulta - buscar no banco e formatar resultado
  if (resultado.acao === 'consulta') {
    return await handleConsulta(usuarioId, resultado);
  }

  // Conversa casual - resposta humana e natural
  if (resultado.acao === 'conversa') {
    return resultado.resposta;
  }

  // Assistente do dia a dia - respostas rápidas e práticas
  if (resultado.acao === 'assistente') {
    return resultado.resposta;
  }

  // Pesquisa na internet
  if (resultado.acao === 'pesquisa') {
    return await handlePesquisa(resultado);
  }

  // Definir limite de gastos
  if (resultado.acao === 'definir_limite') {
    return await handleDefinirLimite(usuarioId, resultado);
  }

  // Listar limites
  if (resultado.acao === 'listar_limites') {
    return await handleListarLimites(usuarioId);
  }

  // Remover limite
  if (resultado.acao === 'remover_limite') {
    return await handleRemoverLimite(usuarioId, resultado);
  }

  // Mensagem fora do escopo - mostra o que o bot sabe fazer
  if (resultado.acao === 'nenhuma') {
    const usuario = await db.buscarUsuario(usuarioId);
    const nome = usuario?.nome || null;
    return foraDoEscopoMsg(nome);
  }

  // Comando sugerido
  if (resultado.acao === 'comando') {
    // Executar diretamente comandos de saldo/pendentes/resumo/lista
    if (resultado.dica === 'saldo') {
      const saldos = await db.calcularSaldos(usuarioId);
      return fmt.formatarSaldos(saldos);
    }
    if (resultado.dica === 'pendentes') {
      const pendentes = await db.listarPendentes(usuarioId);
      return fmt.formatarPendentes(pendentes);
    }
    if (resultado.dica === 'resumo') {
      // Chamar handleResumo para gerar gráfico também
      return await handleResumo(usuarioId, 'resumo');
    }
    if (resultado.dica === 'lista') {
      const transacoes = await db.listarTransacoes(usuarioId, null, 10);
      return fmt.formatarLista(transacoes, 'todas');
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
      const quando = tipo === 'receita' ? 'receber' : 'pagar';
      msg += `\n\n_Vou te lembrar quando chegar o dia de ${quando}! 📅_`;
    }

    // Verificar limite de gastos (apenas para despesas)
    if (tipo === 'despesa' && categoria) {
      const limiteInfo = await db.verificarLimite(usuarioId, categoria);
      if (limiteInfo) {
        const { limite, gastos, restante, percentual } = limiteInfo;
        let emoji = '';
        if (percentual >= 100) emoji = '🚨';
        else if (percentual >= 80) emoji = '⚠️';
        else if (percentual >= 60) emoji = '📊';
        else emoji = '✅';

        msg += `\n\n${emoji} *Limite de ${categoria}:*\n`;
        msg += `Gasto: ${fmt.formatarMoeda(gastos)} de ${fmt.formatarMoeda(limite)} (${percentual}%)\n`;
        if (restante > 0) {
          msg += `Restam: ${fmt.formatarMoeda(restante)} este mês`;
        } else {
          msg += `⚠️ *Limite excedido em ${fmt.formatarMoeda(Math.abs(restante))}!*`;
        }
      }
    }

    return msg;
  }

  return foraDoEscopoMsg();
}

async function handleMensagemIA(usuarioId, texto) {
  // Detectar reset ANTES da IA interpretar (para funcionar em áudio também)
  const lower = texto.toLowerCase().trim();
  if (lower === 'resetar' || lower === 'começar do zero' || lower === 'limpar tudo' || lower === 'zerar dados') {
    await db.limparDadosUsuario(usuarioId);
    return mensagemBoasVindas();
  }

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

async function handleListarTodosLembretes(usuarioId) {
  const [lembretes, recorrentes] = await Promise.all([
    db.listarLembretesGerais(usuarioId),
    db.listarLembretesRecorrentes(usuarioId),
  ]);

  if (lembretes.length === 0 && recorrentes.length === 0) {
    return '⏰ Você não tem nenhum lembrete ativo no momento.\n\n_Dica: me fala algo como "me lembre daqui 30 min de pegar o Noah" ou "todo dia às 8h me lembra de tomar o remédio"_';
  }

  let msg = '';

  // Lembretes únicos (agendados)
  if (lembretes.length > 0) {
    msg += '⏰ *Lembretes agendados:*\n\n';
    for (const l of lembretes) {
      msg += `🔔 *#${l.id}* - ${l.mensagem}\n   📅 ${l.horario}\n\n`;
    }
    msg += '_Para cancelar: *cancelar lembrete #ID*_\n\n';
  }

  // Lembretes recorrentes
  if (recorrentes.length > 0) {
    msg += '🔄 *Lembretes recorrentes:*\n\n';
    for (const l of recorrentes) {
      let freq;
      if (l.frequencia === 'diario') freq = 'Todo dia';
      else if (l.frequencia === 'semanal') freq = `${DIAS_SEMANA[l.dia_semana]}`;
      else freq = `Dia ${l.dia_mes}/mês`;

      const fim = l.data_fim ? ` (até ${l.data_fim})` : ' (♾️)';
      msg += `🔔 *#R${l.id}* - ${l.mensagem}\n   📅 ${freq} às ${l.horario}${fim}\n\n`;
    }
    msg += '_Para cancelar: *cancelar recorrente #ID*_';
  }

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

const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

async function handleLembreteRecorrente(usuarioId, resultado) {
  const { horario, frequencia, dia_semana, dia_mes, duracao_meses, mensagem } = resultado;

  if (!mensagem || !horario || !frequencia) {
    return '❌ Não consegui entender o lembrete recorrente. Tente algo como:\n\n_"me lembre toda semana às 10h de cortar a grama"_\n_"todo dia às 8h me lembra de tomar o remédio"_';
  }

  // Calcular data de fim se tiver duração
  let dataFim = null;
  if (duracao_meses && duracao_meses > 0) {
    const fim = new Date();
    fim.setMonth(fim.getMonth() + duracao_meses);
    dataFim = fim.toISOString().split('T')[0];
  }

  const id = await db.criarLembreteRecorrente(
    usuarioId, mensagem, horario, frequencia,
    frequencia === 'semanal' ? (dia_semana ?? new Date().getDay()) : null,
    frequencia === 'mensal' ? (dia_mes ?? new Date().getDate()) : null,
    dataFim
  );

  let freqTexto;
  if (frequencia === 'diario') {
    freqTexto = 'Todo dia';
  } else if (frequencia === 'semanal') {
    const dia = dia_semana ?? new Date().getDay();
    freqTexto = `Toda ${DIAS_SEMANA[dia]}`;
  } else {
    const dia = dia_mes ?? new Date().getDate();
    freqTexto = `Todo dia ${dia} do mês`;
  }

  let msg = `🔄 *Lembrete recorrente criado!*\n\n` +
    `📝 ${mensagem}\n` +
    `📅 ${freqTexto} às ${horario}\n`;

  if (dataFim) {
    const [a, m, d] = dataFim.split('-');
    msg += `⏳ Até ${d}/${m}/${a}\n`;
  } else {
    msg += `♾️ Por tempo indeterminado\n`;
  }

  msg += `🆔 #R${id}\n\n_Para cancelar: *cancelar recorrente #${id}*_`;
  return msg;
}

async function handleListarRecorrentes(usuarioId) {
  const lembretes = await db.listarLembretesRecorrentes(usuarioId);

  if (lembretes.length === 0) {
    return '🔄 Nenhum lembrete recorrente ativo.';
  }

  let msg = '🔄 *Seus lembretes recorrentes:*\n\n';
  for (const l of lembretes) {
    let freq;
    if (l.frequencia === 'diario') freq = 'Todo dia';
    else if (l.frequencia === 'semanal') freq = `${DIAS_SEMANA[l.dia_semana]}`;
    else freq = `Dia ${l.dia_mes}/mês`;

    const fim = l.data_fim ? ` (até ${l.data_fim})` : ' (♾️)';
    msg += `🔔 *#R${l.id}* - ${l.mensagem}\n   📅 ${freq} às ${l.horario}${fim}\n\n`;
  }
  msg += '_Para cancelar: *cancelar recorrente #ID*_';
  return msg;
}

async function handleCancelarRecorrente(usuarioId, msg) {
  const idStr = msg.replace(/cancelar recorrente\s*/i, '').replace(/parar lembrete\s*/i, '').replace('#', '').replace('R', '').replace('r', '').trim();
  const id = parseInt(idStr);

  if (!id || isNaN(id)) {
    return '❌ Informe o ID do lembrete recorrente.\n\nExemplo: cancelar recorrente #5';
  }

  const resultado = await db.cancelarLembreteRecorrente(usuarioId, id);
  if (!resultado) {
    return `❌ Lembrete recorrente #${id} não encontrado ou já está desativado.`;
  }

  return `✅ Lembrete recorrente #R${id} cancelado!\n\n_"${resultado.mensagem}"_`;
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

async function handlePesquisa(resultado) {
  const { query, pergunta } = resultado;

  if (!query) {
    return 'Não entendi o que você quer que eu pesquise. Tenta reformular? 🤔';
  }

  if (!process.env.BRAVE_SEARCH_API_KEY) {
    return '🔍 A pesquisa na internet está desabilitada no momento.\n\n_O administrador precisa configurar a BRAVE_SEARCH_API_KEY._';
  }

  console.log(`[PESQUISA] Buscando: "${query}"`);
  const resultados = await pesquisarWeb(query);

  if (!resultados || resultados.length === 0) {
    return `Não encontrei resultados pra "${pergunta || query}" 😕\n\nTenta ser mais específico, tipo incluir a cidade ou o nome do lugar.`;
  }

  console.log(`[PESQUISA] ${resultados.length} resultados encontrados, formatando...`);
  const respostaFormatada = await formatarResultadosPesquisa(pergunta || query, resultados);

  if (!respostaFormatada) {
    // Fallback: formata manualmente se a IA falhar
    let msg = `🔍 *${pergunta || query}*\n\n`;
    const topResultados = resultados.slice(0, 3);

    for (const r of topResultados) {
      const descricaoCurta = r.descricao.length > 100 ? r.descricao.substring(0, 100) + '...' : r.descricao;
      const mapsLink = `https://maps.google.com/?q=${encodeURIComponent(r.titulo)}`;
      msg += `📌 *${r.titulo}*\n${descricaoCurta}\n📍 ${mapsLink}\n\n`;
    }
    msg += '_Dica: Seja mais específico com cidade/bairro para melhores resultados_';
    return msg;
  }

  return respostaFormatada;
}

async function handleDefinirLimite(usuarioId, resultado) {
  const { categoria, valor } = resultado;

  if (!categoria || !valor || valor <= 0) {
    return '❌ Não consegui entender. Tenta algo como: "limitar gastos com Lazer em 500 reais"';
  }

  await db.definirLimite(usuarioId, categoria, valor);
  return `✅ *Limite definido!*\n\n📂 Categoria: ${categoria}\n💰 Limite mensal: ${fmt.formatarMoeda(valor)}\n\n_Vou te avisar sempre que registrar uma despesa nessa categoria!_`;
}

async function handleListarLimites(usuarioId) {
  const limites = await db.listarLimites(usuarioId);

  if (limites.length === 0) {
    return '📊 Você ainda não definiu nenhum limite de gastos.\n\n_Dica: Me fala algo como "limitar gastos com Alimentação em 1000 reais"_';
  }

  let msg = '📊 *Seus limites de gastos:*\n\n';
  for (const l of limites) {
    const info = await db.verificarLimite(usuarioId, l.categoria);
    if (info) {
      const { gastos, limite, restante, percentual } = info;
      let emoji = '';
      if (percentual >= 100) emoji = '🚨';
      else if (percentual >= 80) emoji = '⚠️';
      else if (percentual >= 60) emoji = '📊';
      else emoji = '✅';

      msg += `${emoji} *${l.categoria}*\n`;
      msg += `   Limite: ${fmt.formatarMoeda(limite)}\n`;
      msg += `   Gasto: ${fmt.formatarMoeda(gastos)} (${percentual}%)\n`;
      if (restante > 0) {
        msg += `   Restam: ${fmt.formatarMoeda(restante)}\n\n`;
      } else {
        msg += `   ⚠️ Excedido em ${fmt.formatarMoeda(Math.abs(restante))}\n\n`;
      }
    }
  }

  return msg;
}

async function handleRemoverLimite(usuarioId, resultado) {
  const { categoria } = resultado;

  if (!categoria) {
    return '❌ Qual categoria você quer remover o limite?';
  }

  const removido = await db.removerLimite(usuarioId, categoria);
  if (!removido) {
    return `❌ Não encontrei limite ativo para a categoria "${categoria}".`;
  }

  return `✅ Limite de *${categoria}* removido com sucesso!`;
}

function calcularPeriodo(periodo) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const dia = hoje.getDate();
  const dow = hoje.getDay(); // 0=dom, 1=seg...

  let dataInicio, dataFim, titulo;

  switch (periodo) {
    case 'hoje':
      dataInicio = new Date(ano, mes, dia);
      dataFim = new Date(ano, mes, dia);
      titulo = `hoje (${dataInicio.toLocaleDateString('pt-BR')})`;
      break;
    case 'amanha':
      dataInicio = new Date(ano, mes, dia + 1);
      dataFim = new Date(ano, mes, dia + 1);
      titulo = `amanhã (${dataInicio.toLocaleDateString('pt-BR')})`;
      break;
    case 'semana': {
      // Segunda a domingo da semana atual
      const diffSeg = dow === 0 ? -6 : 1 - dow;
      dataInicio = new Date(ano, mes, dia + diffSeg);
      dataFim = new Date(dataInicio);
      dataFim.setDate(dataFim.getDate() + 6);
      titulo = `esta semana (${dataInicio.toLocaleDateString('pt-BR')} a ${dataFim.toLocaleDateString('pt-BR')})`;
      break;
    }
    case 'mes': {
      dataInicio = new Date(ano, mes, 1);
      const ultimoDia = new Date(ano, mes + 1, 0).getDate();
      dataFim = new Date(ano, mes, ultimoDia);
      const nomesMes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
      titulo = `${nomesMes[mes]} de ${ano}`;
      break;
    }
    default:
      // Tenta interpretar como data específica YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(periodo)) {
        const [a, m, d] = periodo.split('-').map(Number);
        dataInicio = new Date(a, m - 1, d);
        dataFim = new Date(a, m - 1, d);
        titulo = `dia ${dataInicio.toLocaleDateString('pt-BR')}`;
      } else {
        dataInicio = new Date(ano, mes, dia);
        dataFim = new Date(ano, mes, dia);
        titulo = `hoje (${dataInicio.toLocaleDateString('pt-BR')})`;
      }
  }

  // Formatar como YYYY-MM-DD para o banco
  const fmtData = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { dataInicio: fmtData(dataInicio), dataFim: fmtData(dataFim), titulo, dataInicioObj: dataInicio, dataFimObj: dataFim };
}

function recorrenteDisparaNoPerodo(rec, dataInicioObj, dataFimObj) {
  // Verifica se um lembrete recorrente dispara em algum dia do período
  const d = new Date(dataInicioObj);
  while (d <= dataFimObj) {
    if (rec.frequencia === 'diario') return true;
    if (rec.frequencia === 'semanal' && d.getDay() === rec.dia_semana) return true;
    if (rec.frequencia === 'mensal' && d.getDate() === rec.dia_mes) return true;
    d.setDate(d.getDate() + 1);
  }
  return false;
}

async function handleAgenda(usuarioId, periodo) {
  const { dataInicio, dataFim, titulo, dataInicioObj, dataFimObj } = calcularPeriodo(periodo);

  // Buscar tudo em paralelo
  const [transacoes, lembretes, recorrentes] = await Promise.all([
    db.consultarTransacoes(usuarioId, { dataInicio, dataFim, limite: 50 }),
    db.buscarLembretesGeraisPorPeriodo(usuarioId, dataInicio, dataFim),
    db.listarLembretesRecorrentes(usuarioId),
  ]);

  // Filtrar recorrentes que disparam no período
  const recorrentesDoPeriodo = recorrentes.filter(r => recorrenteDisparaNoPerodo(r, dataInicioObj, dataFimObj));

  // Separar transações
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const despesas = transacoes.filter(t => t.tipo === 'despesa');
  const pendentes = transacoes.filter(t => t.status === 'pendente');

  const temAlgo = receitas.length > 0 || despesas.length > 0 || lembretes.length > 0 || recorrentesDoPeriodo.length > 0;

  if (!temAlgo) {
    return `📅 *Sua agenda para ${titulo}*\n\nVocê não tem nada agendado para esse período! 😎\n\n_Dica: registre despesas, receitas ou crie lembretes para organizar seu dia._`;
  }

  let msg = `📅 *Sua agenda para ${titulo}*\n\n`;

  // Receitas do período
  if (receitas.length > 0) {
    const totalReceitas = receitas.reduce((acc, t) => acc + t.valor, 0);
    msg += `💰 *Receitas (${fmt.formatarMoeda(totalReceitas)}):*\n`;
    for (const t of receitas) {
      const status = t.status === 'pendente' ? ' ⏳' : ' ✅';
      msg += `  🟢 ${fmt.formatarMoeda(t.valor)} - _${t.descricao}_ (${t.categoria})${status}\n`;
    }
    msg += '\n';
  }

  // Despesas do período
  if (despesas.length > 0) {
    const totalDespesas = despesas.reduce((acc, t) => acc + t.valor, 0);
    msg += `💸 *Despesas (${fmt.formatarMoeda(totalDespesas)}):*\n`;
    for (const t of despesas) {
      const status = t.status === 'pendente' ? ' ⏳' : ' ✅';
      msg += `  🔴 ${fmt.formatarMoeda(t.valor)} - _${t.descricao}_ (${t.categoria})${status}\n`;
    }
    msg += '\n';
  }

  // Lembretes únicos do período
  if (lembretes.length > 0) {
    msg += `⏰ *Lembretes agendados:*\n`;
    for (const l of lembretes) {
      msg += `  🔔 ${l.hora} - ${l.mensagem}\n`;
    }
    msg += '\n';
  }

  // Recorrentes que disparam no período
  if (recorrentesDoPeriodo.length > 0) {
    msg += `🔄 *Lembretes recorrentes:*\n`;
    for (const r of recorrentesDoPeriodo) {
      let freq;
      if (r.frequencia === 'diario') freq = 'todo dia';
      else if (r.frequencia === 'semanal') freq = `${DIAS_SEMANA[r.dia_semana]}`;
      else freq = `dia ${r.dia_mes}/mês`;
      msg += `  🔔 ${r.horario} - ${r.mensagem} _(${freq})_\n`;
    }
    msg += '\n';
  }

  // Resumo de pendentes
  if (pendentes.length > 0) {
    const totalPendente = pendentes.reduce((acc, t) => acc + t.valor, 0);
    msg += `⚠️ _${pendentes.length} lançamento${pendentes.length > 1 ? 's' : ''} pendente${pendentes.length > 1 ? 's' : ''} (${fmt.formatarMoeda(totalPendente)})_`;
  }

  return msg;
}

// ==================== PONTO ZERO ====================

async function iniciarPontoZero(usuarioId) {
  salvarPontoZero(usuarioId, {
    etapa: 'saldo',
    saldoInicial: 0,
    receitas: [],
    despesas: [],
    recorrentes: [],
  });

  return `E aí! 😄 Bora deixar tudo em dia?\n\nEm 2-3 min eu monto teu *"Ponto Zero"* e deixo tuas finanças organizadas.\n\nPrimeiro: *quanto tu tem disponível hoje*, somando tudo (conta, carteira, pix)? Pode ser aproximado.\n\n_Ex: "R$ 1.850" ou "tenho uns 2 mil"_\n\n_A qualquer momento digite *cancelar* para sair._`;
}

async function handlePontoZero(usuarioId, texto, estado) {
  const lower = texto.toLowerCase().trim();

  // Cancelar a qualquer momento
  if (lower === 'cancelar' || lower === 'sair' || lower === 'parar') {
    limparPontoZero(usuarioId);
    return '❌ Ponto Zero cancelado. Sem problemas! Quando quiser recomeçar é só me falar *"ponto zero"*.';
  }

  const item = await interpretarItemFinanceiro(texto);

  switch (estado.etapa) {
    case 'saldo': {
      if (item.tipo !== 'item' || !item.valor) {
        return 'Não consegui entender o valor 😅\n\nMe diz só o valor aproximado que tu tem disponível hoje.\n_Ex: "R$ 1.850" ou "uns 2 mil"_';
      }
      estado.saldoInicial = item.valor;
      estado.etapa = 'receitas';
      salvarPontoZero(usuarioId, estado);
      return `Perfeito ✅ Saldo atual: *${fmt.formatarMoeda(item.valor)}*\n\nAté o fim do mês, tu tem algo pra *receber*? (salário, freela, pix esperado)\n\n_Se não tem nada pra receber, manda "não"._`;
    }

    case 'receitas': {
      if (item.tipo === 'nao') {
        estado.etapa = 'despesas';
        salvarPontoZero(usuarioId, estado);
        return 'Beleza! E *contas pra pagar* até o fim do mês? Me diz as principais (pode mandar várias de uma vez!).\n\n_Ex: "Internet dia 18, R$ 120 e cartão dia 25, R$ 980"_\n_Se não tem nenhuma, manda "não"._';
      }
      if (item.tipo === 'itens' && item.itens && item.itens.length > 0) {
        let msg = '';
        for (const it of item.itens) {
          estado.receitas.push({ valor: it.valor, descricao: it.descricao, dia: it.dia, categoria: it.categoria });
          msg += `✅ *${it.descricao}* - ${fmt.formatarMoeda(it.valor)}${it.dia ? ` (dia ${it.dia})` : ''}\n`;
        }
        salvarPontoZero(usuarioId, estado);
        return `Anotado! ${item.itens.length} receitas registradas:\n\n${msg}\nTem mais alguma coisa pra receber ou fechou?`;
      }
      if (item.tipo === 'item' && item.valor) {
        estado.receitas.push({ valor: item.valor, descricao: item.descricao, dia: item.dia, categoria: item.categoria });
        salvarPontoZero(usuarioId, estado);
        return `Anotado ✅ *${item.descricao}* - ${fmt.formatarMoeda(item.valor)}${item.dia ? ` (dia ${item.dia})` : ''}\n\nÉ só isso de recebimento ou tem mais alguma coisa pra entrar?`;
      }
      return 'Não entendi 😅 Me diz o que tu vai receber, o valor e o dia.\n_Ex: "Salário dia 28, R$ 3.000"_\n_Ou manda "não" se não tem nada pra receber._';
    }

    case 'despesas': {
      if (item.tipo === 'nao') {
        estado.etapa = 'recorrentes';
        salvarPontoZero(usuarioId, estado);
        return 'Beleza! Agora me diz aquelas *contas que tu paga todo mês* (mesmo que seja pro próximo mês). Pode mandar várias de uma vez!\n_Ex: "aluguel dia 5 R$ 1500, internet dia 10 R$ 120 e academia dia 1 R$ 100"_\n\n_Se não tem nenhuma fixa, manda "não"._';
      }
      if (item.tipo === 'itens' && item.itens && item.itens.length > 0) {
        let msg = '';
        for (const it of item.itens) {
          estado.despesas.push({ valor: it.valor, descricao: it.descricao, dia: it.dia, categoria: it.categoria });
          msg += `✅ *${it.descricao}* - ${fmt.formatarMoeda(it.valor)}${it.dia ? ` (dia ${it.dia})` : ''}\n`;
        }
        salvarPontoZero(usuarioId, estado);
        return `Anotado! ${item.itens.length} despesas registradas:\n\n${msg}\nTem mais alguma despesa pendente ou por enquanto fechou?`;
      }
      if (item.tipo === 'item' && item.valor) {
        estado.despesas.push({ valor: item.valor, descricao: item.descricao, dia: item.dia, categoria: item.categoria });
        salvarPontoZero(usuarioId, estado);
        return `Anotado ✅ *${item.descricao}* - ${fmt.formatarMoeda(item.valor)}${item.dia ? ` (dia ${item.dia})` : ''}\n\nTem mais alguma despesa pendente ou por enquanto fechou?`;
      }
      return 'Não entendi 😅 Me diz a conta, o valor e o dia de vencimento.\n_Ex: "Cartão dia 25, R$ 980"_\n_Ou manda "não" se não tem mais._';
    }

    case 'recorrentes': {
      if (item.tipo === 'nao') {
        estado.etapa = 'painel';
        salvarPontoZero(usuarioId, estado);
        return 'Fechou! ✅\n\nQuer ver teu *painel financeiro* agora? Saldo, pendências e previsão até o fim do mês. 📊\n\n_Manda "sim" pra ver ou "cancelar" pra sair._';
      }
      if (item.tipo === 'itens' && item.itens && item.itens.length > 0) {
        let msg = '';
        for (const it of item.itens) {
          estado.recorrentes.push({ valor: it.valor, descricao: it.descricao, dia: it.dia, categoria: it.categoria });
          msg += `✅ *${it.descricao}* - ${fmt.formatarMoeda(it.valor)}/mês${it.dia ? ` (dia ${it.dia})` : ''}\n`;
        }
        salvarPontoZero(usuarioId, estado);
        return `Anotado! ${item.itens.length} contas fixas registradas:\n\n${msg}\nTem mais alguma conta mensal ou terminou por aqui?`;
      }
      if (item.tipo === 'item' && item.valor) {
        estado.recorrentes.push({ valor: item.valor, descricao: item.descricao, dia: item.dia, categoria: item.categoria });
        salvarPontoZero(usuarioId, estado);
        return `Anotado ✅ *${item.descricao}* - ${fmt.formatarMoeda(item.valor)}/mês${item.dia ? ` (dia ${item.dia})` : ''}\n\nTem mais alguma conta mensal ou terminou por aqui?`;
      }
      return 'Não entendi 😅 Me diz a conta fixa, o valor e o dia.\n_Ex: "Aluguel dia 5, R$ 1.500"_\n_Ou manda "não" se terminou._';
    }

    case 'painel': {
      if (item.tipo === 'sim') {
        return await finalizarPontoZero(usuarioId, estado);
      }
      if (item.tipo === 'nao') {
        // Salvar dados sem mostrar painel
        await salvarDadosPontoZero(usuarioId, estado);
        limparPontoZero(usuarioId);
        return '✅ Tudo registrado! Teus lançamentos já estão no sistema.\n\nQuando quiser ver o resumo é só pedir: *"resumo"* ou *"agenda"* 💪';
      }
      return 'Manda *"sim"* pra ver o painel ou *"não"* pra só salvar os dados.';
    }

    default:
      limparPontoZero(usuarioId);
      return 'Algo deu errado no fluxo 😅 Me manda *"ponto zero"* pra começar de novo.';
  }
}

function calcularDataPendente(dia) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const diaHoje = hoje.getDate();

  let data;
  if (dia && dia > 0) {
    if (dia >= diaHoje) {
      // Ainda não passou neste mês
      data = new Date(ano, mes, dia);
    } else {
      // Já passou, coloca pro próximo mês
      data = new Date(ano, mes + 1, dia);
    }
  } else {
    // Sem dia, usa fim do mês
    const ultimoDia = new Date(ano, mes + 1, 0).getDate();
    data = new Date(ano, mes, ultimoDia);
  }

  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

async function salvarDadosPontoZero(usuarioId, estado) {
  // Salvar receitas como receitas pendentes
  for (const r of estado.receitas) {
    const dataStr = calcularDataPendente(r.dia);
    await db.adicionarTransacao(usuarioId, 'receita', r.valor, r.descricao, r.categoria, dataStr, 'pendente');
  }

  // Salvar despesas como despesas pendentes
  for (const d of estado.despesas) {
    const dataStr = calcularDataPendente(d.dia);
    await db.adicionarTransacao(usuarioId, 'despesa', d.valor, d.descricao, d.categoria, dataStr, 'pendente');
  }

  // Salvar recorrentes como despesas pendentes + criar lembrete recorrente
  for (const r of estado.recorrentes) {
    const dataStr = calcularDataPendente(r.dia);
    await db.adicionarTransacao(usuarioId, 'despesa', r.valor, r.descricao, r.categoria, dataStr, 'pendente');

    // Criar lembrete recorrente mensal
    const horario = '09:00';
    await db.criarLembreteRecorrente(
      usuarioId,
      `💸 Pagar: ${r.descricao} - ${fmt.formatarMoeda(r.valor)}`,
      horario,
      'mensal',
      null,
      r.dia || 1,
      null
    );
  }
}

async function finalizarPontoZero(usuarioId, estado) {
  // Salvar tudo no banco
  await salvarDadosPontoZero(usuarioId, estado);
  limparPontoZero(usuarioId);

  // Montar painel
  const hoje = new Date();
  const diaHoje = hoje.getDate();
  const nomesMes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const mesAtual = nomesMes[hoje.getMonth()];
  const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();

  // Separar itens futuros (ainda pendentes neste mês) dos passados (já incluídos no saldo)
  // Se o dia já passou, o valor já está refletido no saldo informado pelo usuário
  const ehFuturo = (item) => !item.dia || item.dia >= diaHoje;

  const receitasFuturas = estado.receitas.filter(ehFuturo);
  const receitasPassadas = estado.receitas.filter(r => !ehFuturo(r));
  const despesasFuturas = estado.despesas.filter(ehFuturo);
  const despesasPassadas = estado.despesas.filter(d => !ehFuturo(d));
  const recorrentesFuturos = estado.recorrentes.filter(ehFuturo);
  const recorrentesPassados = estado.recorrentes.filter(r => !ehFuturo(r));

  // Projeção só com itens FUTUROS (do dia de hoje pra frente)
  const totalReceitasFuturas = receitasFuturas.reduce((acc, r) => acc + r.valor, 0);
  const totalDespesasFuturas = despesasFuturas.reduce((acc, d) => acc + d.valor, 0);
  const totalRecorrentesFuturos = recorrentesFuturos.reduce((acc, r) => acc + r.valor, 0);
  const previsaoFimMes = estado.saldoInicial + totalReceitasFuturas - totalDespesasFuturas - totalRecorrentesFuturos;

  let msg = `📊 *TEU PONTO ZERO - ${mesAtual.toUpperCase()}*\n\n`;

  // Saldo atual
  msg += `💰 *Saldo atual:* ${fmt.formatarMoeda(estado.saldoInicial)}\n\n`;

  // Receitas futuras (entram na projeção)
  if (receitasFuturas.length > 0) {
    msg += `📈 *A receber (+${fmt.formatarMoeda(totalReceitasFuturas)}):*\n`;
    for (const r of receitasFuturas) {
      msg += `  🟢 ${r.descricao} - ${fmt.formatarMoeda(r.valor)}${r.dia ? ` (dia ${r.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Despesas futuras (entram na projeção)
  if (despesasFuturas.length > 0) {
    msg += `📉 *A pagar (-${fmt.formatarMoeda(totalDespesasFuturas)}):*\n`;
    for (const d of despesasFuturas) {
      msg += `  🔴 ${d.descricao} - ${fmt.formatarMoeda(d.valor)}${d.dia ? ` (dia ${d.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Recorrentes futuros (entram na projeção)
  if (recorrentesFuturos.length > 0) {
    msg += `🔄 *Gastos fixos pendentes este mês (-${fmt.formatarMoeda(totalRecorrentesFuturos)}):*\n`;
    for (const r of recorrentesFuturos) {
      msg += `  🔴 ${r.descricao} - ${fmt.formatarMoeda(r.valor)}/mês${r.dia ? ` (dia ${r.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Itens já pagos/recebidos (não entram na projeção, só informativo)
  const totalPassados = receitasPassadas.length + despesasPassadas.length + recorrentesPassados.length;
  if (totalPassados > 0) {
    msg += `✅ *Já contabilizado no saldo (dia já passou):*\n`;
    for (const r of receitasPassadas) {
      msg += `  🟢 ${r.descricao} - ${fmt.formatarMoeda(r.valor)} (dia ${r.dia}) ✔️\n`;
    }
    for (const d of despesasPassadas) {
      msg += `  🔴 ${d.descricao} - ${fmt.formatarMoeda(d.valor)} (dia ${d.dia}) ✔️\n`;
    }
    for (const r of recorrentesPassados) {
      msg += `  🔴 ${r.descricao} - ${fmt.formatarMoeda(r.valor)}/mês (dia ${r.dia}) ✔️\n`;
    }
    msg += '\n';
  }

  // Linha separadora
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;

  // Previsão
  const emoji = previsaoFimMes >= 0 ? '✅' : '🚨';
  msg += `${emoji} *Previsão até ${ultimoDia}/${String(hoje.getMonth() + 1).padStart(2, '0')}:* ${fmt.formatarMoeda(previsaoFimMes)}\n\n`;

  if (previsaoFimMes >= 0) {
    msg += `Sobram *${fmt.formatarMoeda(previsaoFimMes)}* até o fim do mês! 💪\n`;
  } else {
    msg += `⚠️ Atenção! Faltam *${fmt.formatarMoeda(Math.abs(previsaoFimMes))}* pra fechar o mês.\n`;
  }

  msg += `\n_Tudo registrado! Agora é só ir usando o Cronos no dia a dia._ 🚀\n`;
  msg += `_Dica: peça "resumo" ou "agenda" quando quiser acompanhar._`;

  return msg;
}

module.exports = { handleMessage, handleImageMessage, mensagemBoasVindas };
