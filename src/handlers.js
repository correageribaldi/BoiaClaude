const db = require('./database');
const fmt = require('./formatters');
const pagamento = require('./pagamento');
const { interpretarMensagem, analisarImagem, formatarResultadosPesquisa, interpretarItemFinanceiro, categorizarExtrato, gerarDiagnosticoFinanceiro, extrairHorario, dataHojeBRISO, responderAssistente, analisarViabilidadeCompra, classificarCategoriaBudget, interpretarConfirmacaoPagamento, extrairValorMonetario, extrairNomeOnboarding } = require('./ai');

// Helper: converte Date para YYYY-MM-DD no timezone de São Paulo (evita bug UTC do toISOString)
function dateParaISO(d) {
  const partes = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/');
  return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
}

function normalizarTextoBusca(texto) {
  if (!texto) return '';
  return String(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\bamanh[^\s]*\b/g, 'amanha')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mapa de nomes de dias da semana → número (0=dom, 1=seg, ..., 6=sab)
const DIAS_SEMANA = {
  domingo: 0, dom: 0,
  segunda: 1, 'segunda-feira': 1, seg: 1,
  terca: 2, terça: 2, 'terca-feira': 2, 'terça-feira': 2, ter: 2,
  quarta: 3, 'quarta-feira': 3, qua: 3,
  quinta: 4, 'quinta-feira': 4, qui: 4,
  sexta: 5, 'sexta-feira': 5, sex: 5,
  sabado: 6, sábado: 6, 'sab': 6, 'sáb': 6,
};

// Detecta menção a dia da semana no texto do usuário e retorna o nome normalizado
function extrairDiaSemanaDoTexto(texto) {
  const t = normalizarTextoBusca(texto);
  // Ordem importa: checar nomes completos primeiro, depois abreviados
  const padroes = [
    { regex: /segunda[\s-]?feira/, nome: 'segunda' },
    { regex: /ter[cç]a[\s-]?feira/, nome: 'terca' },
    { regex: /quarta[\s-]?feira/, nome: 'quarta' },
    { regex: /quinta[\s-]?feira/, nome: 'quinta' },
    { regex: /sexta[\s-]?feira/, nome: 'sexta' },
    { regex: /s[aá]bado/, nome: 'sabado' },
    { regex: /domingo/, nome: 'domingo' },
    { regex: /\bsegunda\b/, nome: 'segunda' },
    { regex: /\bter[cç]a\b/, nome: 'terca' },
    { regex: /\bquarta\b/, nome: 'quarta' },
    { regex: /\bquinta\b/, nome: 'quinta' },
    { regex: /\bsexta\b/, nome: 'sexta' },
  ];
  for (const p of padroes) {
    if (p.regex.test(t)) return p.nome;
  }
  return null;
}

// Converte nome de dia da semana ou referência relativa em YYYY-MM-DD
function resolverData(valor) {
  if (!valor) return null;
  const v = normalizarTextoBusca(valor);

  console.log(`[resolverData] entrada: "${valor}" → normalizado: "${v}"`);

  // Já é YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    console.log(`[resolverData] já é ISO: ${v}`);
    return v;
  }

  // Obter "hoje" correto no timezone de São Paulo (evita bug UTC vs -03)
  const agoraRaw = new Date();
  const hojeISO = dateParaISO(agoraRaw);
  const [anoH, mesH, diaH] = hojeISO.split('-').map(Number);
  // Criar date ao meio-dia para evitar shift de timezone em qualquer operação
  const hoje = new Date(anoH, mesH - 1, diaH, 12, 0, 0);

  console.log(`[resolverData] agoraRaw UTC: ${agoraRaw.toISOString()}`);
  console.log(`[resolverData] hojeISO (SP): ${hojeISO}`);
  console.log(`[resolverData] hoje (noon): ${hoje.toISOString()}, getDay()=${hoje.getDay()}`);

  // Referências relativas
  if (v === 'hoje') return hojeISO;
  if (v === 'amanha') {
    const d = new Date(hoje);
    d.setDate(d.getDate() + 1);
    return dateParaISO(d);
  }
  if (v === 'ontem') {
    const d = new Date(hoje);
    d.setDate(d.getDate() - 1);
    return dateParaISO(d);
  }
  if (v === 'anteontem') {
    const d = new Date(hoje);
    d.setDate(d.getDate() - 2);
    return dateParaISO(d);
  }

  // "dia 20" ou "dia 20 do proximo mes"
  const diaProxMes = v.match(/^dia\s+(\d{1,2})\s+do\s+proximo\s+mes$/);
  if (diaProxMes) {
    const diaAlvo = parseInt(diaProxMes[1], 10);
    if (diaAlvo >= 1 && diaAlvo <= 31) {
      let anoAlvo = anoH;
      let mesAlvo = mesH + 1;
      if (mesAlvo > 12) {
        mesAlvo = 1;
        anoAlvo += 1;
      }
      const ultimoDiaMes = new Date(anoAlvo, mesAlvo, 0).getDate();
      if (diaAlvo <= ultimoDiaMes) {
        return `${anoAlvo}-${String(mesAlvo).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`;
      }
    }
  }

  const diaMes = v.match(/^dia\s+(\d{1,2})$/);
  if (diaMes) {
    const diaAlvo = parseInt(diaMes[1], 10);
    if (diaAlvo >= 1 && diaAlvo <= 31) {
      let anoAlvo = anoH;
      let mesAlvo = mesH;
      if (diaAlvo < diaH) {
        mesAlvo += 1;
        if (mesAlvo > 12) {
          mesAlvo = 1;
          anoAlvo += 1;
        }
      }
      const ultimoDiaMes = new Date(anoAlvo, mesAlvo, 0).getDate();
      if (diaAlvo <= ultimoDiaMes) {
        return `${anoAlvo}-${String(mesAlvo).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`;
      }
    }
  }

  // Dia da semana → próxima ocorrência
  const diaSemanaAlvo = DIAS_SEMANA[v];
  if (diaSemanaAlvo !== undefined) {
    const diaAtual = hoje.getDay();
    let diff = diaSemanaAlvo - diaAtual;
    if (diff <= 0) diff += 7;
    const d = new Date(hoje);
    d.setDate(d.getDate() + diff);
    const resultado = dateParaISO(d);

    console.log(`[resolverData] dia da semana: "${v}" → alvo=${diaSemanaAlvo}, atual=${diaAtual}, diff=${diff}`);
    console.log(`[resolverData] d após setDate: ${d.toISOString()}`);
    console.log(`[resolverData] resultado final: ${resultado}`);

    return resultado;
  }

  // DD/MM/YYYY
  if (v.includes('/')) {
    const partes = v.split('/');
    if (partes.length >= 2) {
      const dia = partes[0].padStart(2, '0');
      const mes = partes[1].padStart(2, '0');
      const ano = partes[2] || anoH.toString();
      return `${ano}-${mes}-${dia}`;
    }
  }

  console.log(`[resolverData] não conseguiu resolver: "${v}"`);
  return null;
}
const { pesquisarWeb, pesquisarLocal } = require('./search');
const charts = require('./charts');

// Estado temporário para confirmações pendentes (expira em 5 min)
const confirmacoesPendentes = new Map();

// Estado para transações com dados incompletos (expira em 5 min)
const transacaoPendente = new Map();

function salvarTransacaoPendente(usuarioId, dados) {
  transacaoPendente.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 5 * 60 * 1000,
  });
}

function obterTransacaoPendente(usuarioId) {
  const dados = transacaoPendente.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    transacaoPendente.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparTransacaoPendente(usuarioId) {
  transacaoPendente.delete(usuarioId);
}

// Estado do assessor de compra aguardando valor (expira em 5 min)
const assessorCompraPendenteMap = new Map();

function salvarAssessorCompra(usuarioId, dados) {
  assessorCompraPendenteMap.set(usuarioId, { ...dados, expiraEm: Date.now() + 5 * 60 * 1000 });
}

function obterAssessorCompra(usuarioId) {
  const dados = assessorCompraPendenteMap.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    assessorCompraPendenteMap.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparAssessorCompra(usuarioId) {
  assessorCompraPendenteMap.delete(usuarioId);
}

// Verifica o que falta e pergunta o próximo campo
function perguntarProximoCampo(pendente) {
  const { descricao, tipo } = pendente;
  const acao = tipo === 'receita' ? 'recebimento' : 'pagamento';

  if (!pendente.valor) {
    return { campo: 'valor', msg: `💰 Qual o valor ${tipo === 'receita' ? 'desse recebimento' : 'desse pagamento'} de *${descricao}*?` };
  }
  if (!pendente.data) {
    return { campo: 'data', msg: `📅 Pra que dia é ${tipo === 'receita' ? 'esse recebimento' : 'esse pagamento'} de *${descricao}*?\n\n_Ex: "sexta-feira", "dia 20", "amanhã", "hoje"_` };
  }
  return null; // tudo preenchido
}

// Lembretes aguardando horário (expira em 5 min)
const lembretesPendentes = new Map();

function salvarLembretePendente(usuarioId, dados) {
  lembretesPendentes.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 5 * 60 * 1000,
  });
}

function obterLembretePendente(usuarioId) {
  const dados = lembretesPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    lembretesPendentes.delete(usuarioId);
    return null;
  }
  return dados;
}

// Estado de confirmação de lembretes financeiros (aguardando resposta do usuário após rodada)
// Expira em 4 horas (cobre o intervalo entre rodadas)
const confirmacaoLembrete = new Map();

function registrarLembreteAtivo(usuarioId, transacaoIds, transacoesInfo) {
  confirmacaoLembrete.set(usuarioId, {
    transacaoIds,    // array de IDs internos do banco (t.id)
    transacoesInfo,  // array de { id, numero_usuario, descricao, valor, tipo } para mensagens
    expiraEm: Date.now() + 4 * 60 * 60 * 1000,
  });
}

function obterConfirmacaoLembrete(usuarioId) {
  const dados = confirmacaoLembrete.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    confirmacaoLembrete.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparConfirmacaoLembrete(usuarioId) {
  confirmacaoLembrete.delete(usuarioId);
}

// Estado do fluxo Finanças em Dia (expira em 30 min)
const pontoZeroEstados = new Map();

function salvarPontoZero(usuarioId, dados) {
  pontoZeroEstados.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 30 * 60 * 1000,
  });
  // Persistir no banco (fire-and-forget) para sobreviver a restarts
  db.salvarFluxoAtivoDB(usuarioId, dados).catch(e => console.error('[DB] fluxo ativo:', e));
}

async function obterPontoZero(usuarioId) {
  const dados = pontoZeroEstados.get(usuarioId);
  if (dados) {
    if (Date.now() > dados.expiraEm) { pontoZeroEstados.delete(usuarioId); }
    else return dados;
  }
  // Fallback: ler do banco (após restart do servidor)
  try {
    const dadosDB = await db.buscarFluxoAtivoDB(usuarioId);
    if (dadosDB) {
      pontoZeroEstados.set(usuarioId, { ...dadosDB, expiraEm: Date.now() + 30 * 60 * 1000 });
      return dadosDB;
    }
  } catch (e) {
    console.error('[DB] buscarFluxoAtivoDB:', e.message);
  }
  return null;
}

function limparPontoZero(usuarioId) {
  pontoZeroEstados.delete(usuarioId);
  db.limparFluxoAtivoDB(usuarioId).catch(e => console.error('[DB] limpar fluxo:', e));
}

// Estado da análise financeira 50/30/20 (expira em 30 min)
const analiseFinanceiraEstados = new Map();

const REGRA_503020 = {
  necessidades: {
    categorias: ['Alimentacao', 'Transporte', 'Moradia', 'Saude', 'Educacao'],
    meta: 0.50,
    emoji: '🏠',
    label: 'Necessidades',
  },
  desejos: {
    categorias: ['Lazer', 'Vestuario', 'Compras', 'Outros'],
    meta: 0.30,
    emoji: '🎯',
    label: 'Desejos',
  },
  poupanca: {
    categorias: ['Investimentos', 'Poupanca'],
    meta: 0.20,
    emoji: '💰',
    label: 'Poupança / Investimentos',
  },
};

// Mapeamento de categorias de transação → bucket de orçamento (Finanças em Dia)
const MAPA_BUDGET = {
  'Variáveis':     ['Alimentacao', 'Transporte', 'Saude', 'Educacao', 'Moradia', 'Outros', 'Vestuario', 'Compras'],
  'Lazer':         ['Lazer'],
  'Investimentos': ['Investimentos', 'Poupanca'],
  'Objetivos':     ['Objetivos'],
};

function mapearCategoriaBudget(categoria) {
  for (const [budget, cats] of Object.entries(MAPA_BUDGET)) {
    if (cats.includes(categoria)) return budget;
  }
  return null;
}

// Resolve o bucket de orçamento para qualquer categoria:
// 1. Mapa hardcoded (síncrono, rápido)
// 2. Banco de dados (categorias com budget_cat salvo)
// 3. IA (classifica uma vez e persiste para sempre)
async function resolverBudgetCategoria(categoria) {
  const hardcoded = mapearCategoriaBudget(categoria);
  if (hardcoded) return hardcoded;

  const dbBudget = await db.buscarBudgetCat(categoria);
  if (dbBudget) return dbBudget;

  const aiClassified = await classificarCategoriaBudget(categoria);
  await db.salvarBudgetCat(categoria, aiClassified);
  console.log(`[BUDGET] Categoria "${categoria}" classificada pela IA como "${aiClassified}"`);
  return aiClassified;
}

function formatarBlocoLimite(limiteInfo, categoriaTx, budgetCat) {
  const { limite, limiteEfetivo, gastos, restante, percentual, proporcional, diasMes, diasUsuario } = limiteInfo;
  let emoji = '';
  if (percentual >= 100) emoji = '🚨';
  else if (percentual >= 80) emoji = '⚠️';
  else if (percentual >= 60) emoji = '📊';
  else emoji = '✅';

  const label = budgetCat !== categoriaTx
    ? `${budgetCat} _(${categoriaTx})_`
    : budgetCat;

  let bloco = `\n\n${emoji} *Orçamento ${label}:*\n`;
  if (proporcional) {
    bloco += `_Limite do mês: ${fmt.formatarMoeda(limiteEfetivo)} de ${fmt.formatarMoeda(limite)} (proporcional)_\n`;
  }
  const barraTotal = 10;
  const barraCheios = Math.min(Math.round(percentual / 10), barraTotal);
  const barra = '█'.repeat(barraCheios) + '░'.repeat(barraTotal - barraCheios);
  bloco += `${barra} ${percentual}%\n`;
  bloco += `Usado: ${fmt.formatarMoeda(gastos)} | Disponível: `;
  if (restante > 0) {
    bloco += `*${fmt.formatarMoeda(restante)}*`;
  } else {
    bloco += `*🚨 Excedido em ${fmt.formatarMoeda(Math.abs(restante))}*`;
  }
  return bloco;
}

function salvarAnaliseFinanceira(usuarioId, dados) {
  analiseFinanceiraEstados.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 30 * 60 * 1000,
  });
}

function obterAnaliseFinanceira(usuarioId) {
  const dados = analiseFinanceiraEstados.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    analiseFinanceiraEstados.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparAnaliseFinanceira(usuarioId) {
  analiseFinanceiraEstados.delete(usuarioId);
}

// Localização do usuário para buscas locais (expira em 30 min)
const localizacaoUsuario = new Map();

function salvarLocalizacao(usuarioId, lat, lng) {
  localizacaoUsuario.set(usuarioId, {
    lat,
    lng,
    expiraEm: Date.now() + 30 * 60 * 1000,
  });
}

function obterLocalizacao(usuarioId) {
  const dados = localizacaoUsuario.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    localizacaoUsuario.delete(usuarioId);
    return null;
  }
  return dados;
}

function normalizarTextoBuscaLocal(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function textoIndicaBuscaLocal(texto) {
  const t = normalizarTextoBuscaLocal(texto);
  if (!t) return false;

  return /\b(perto de mim|aqui perto|nas proximidades|na regiao|por aqui|nearby|perto|proxim[oa]s?)\b/.test(t);
}

function textoCurtoPodeSerBuscaLocal(texto) {
  const t = normalizarTextoBuscaLocal(texto).trim();
  if (!t) return false;
  if (t.length > 80) return false;

  if (/\b(preco|cotacao|noticia|noticias|historia|significado|como|quando|por que|porque|quem|o que|tempo|clima|receita)\b/.test(t)) {
    return false;
  }

  const palavras = t.split(/\s+/).filter(Boolean);
  return palavras.length <= 6;
}

function limparMarcadoresDeProximidade(texto) {
  if (!texto) return '';

  const limpo = normalizarTextoBuscaLocal(texto)
    .replace(/\b(perto de mim|aqui perto|nas proximidades|na regiao|por aqui|nearby)\b/g, ' ')
    .replace(/\b(perto|proximo|proxima|proximos|proximas)\b/g, ' ')
    .replace(/\b(me mostra|procura|pesquisa|buscar|quero|tem|algum|alguma)\b/g, ' ')
    .replace(/\b(boa|boas|bom|bons|melhor|melhores)\b/g, ' ')
    .replace(/[?!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return limpo;
}

function montarResultadoBuscaLocal(resultado, textoOriginal) {
  const queryTexto = limparMarcadoresDeProximidade(textoOriginal);
  const queryFallback = (resultado?.query || resultado?.pergunta || textoOriginal || '').trim();
  const query = queryTexto || queryFallback;

  return {
    acao: 'busca_local',
    query,
    pergunta: resultado?.pergunta || query,
  };
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

// Estado para remoção de contato compartilhado por seleção (expira em 5 min)
const removerContatoPendente = new Map();

function salvarRemocaoContatoPendente(usuarioId, dados) {
  removerContatoPendente.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 5 * 60 * 1000,
  });
}

function obterRemocaoContatoPendente(usuarioId) {
  const dados = removerContatoPendente.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    removerContatoPendente.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparRemocaoContatoPendente(usuarioId) {
  removerContatoPendente.delete(usuarioId);
}

// ── Onboarding de novos usuários ─────────────────────────────────────────────
// Estados: 'aguardando_nome' → 'aguardando_inicio' → null (concluído)
const onboardingEstados = new Map();

function setOnboardingState(usuarioId, estado) {
  if (estado === null) {
    onboardingEstados.delete(usuarioId);
  } else {
    onboardingEstados.set(usuarioId, { estado, expiraEm: Date.now() + 30 * 60 * 1000 });
  }
  // Persistir no banco (fire-and-forget) para sobreviver a restarts
  db.salvarOnboardingEstadoDB(usuarioId, estado).catch(e => console.error('[DB] onboarding estado:', e));
}

async function getOnboardingState(usuarioId) {
  const dados = onboardingEstados.get(usuarioId);
  if (dados) {
    if (Date.now() > dados.expiraEm) { onboardingEstados.delete(usuarioId); }
    else return dados.estado;
  }
  // Fallback: ler do banco (após restart do servidor)
  try {
    const estadoDB = await db.buscarOnboardingEstadoDB(usuarioId);
    if (estadoDB) {
      onboardingEstados.set(usuarioId, { estado: estadoDB, expiraEm: Date.now() + 30 * 60 * 1000 });
    }
    return estadoDB;
  } catch (e) {
    console.error('[DB] buscarOnboardingEstadoDB:', e.message);
    return null;
  }
}

function mensagemApresentacao() {
  return (
    `Fala! 👋 Eu sou o *Cronos*.\n` +
    `Teu assistente pessoal no WhatsApp, começo organizando tuas finanças, mas vou bem além disso.\n\n` +
    `💰 *Finanças sem complicação*\n` +
    `Receitas, despesas, saldo, contas do mês e gastos recorrentes, limites por categoria, tudo direto na conversa.\n` +
    `Sem app, sem planilha, sem bagunça.\n\n` +
    `🧠 *Assistente pra tudo*\n` +
    `• Lembretes e compromissos (inclusive recorrentes)\n` +
    `• Respostas pra qualquer pergunta _(tipo: "me dá uma receita de bolo")_\n` +
    `• Ajuda no dia a dia: organização, decisões e tarefas\n\n` +
    `📍 *Pesquiso lugares perto de você*\n` +
    `Quer encontrar mercado, restaurante, farmácia ou algum serviço?\n` +
    `Você me manda sua localização por aqui e eu te mostro os melhores lugares próximos de você (pelas avaliações do Google) e mando o link pra abrir no Maps.\n\n` +
    `_E isso é só o começo… ao longo do tempo vou aprendendo e te ajudando no seu dia a dia 😉_`
  );
}

function mensagemPerguntaNome() {
  return (
    `Agora me diz uma coisa…\n` +
    `Como você prefere que eu te chame?\n\n` +
    `Seu nome, apelido ou algo estilo _"meu rei"_, _"minha rainha"_, _"chefe supremo"_? 😅`
  );
}

async function handleOnboardingNome(usuarioId, texto) {
  if (!texto.trim() || texto.trim().length < 1) {
    return `Me diz como quer ser chamado(a)! Pode ser seu nome, apelido… até _"Imperador do Cosmos"_ eu aceito 👑`;
  }

  const nome = await extrairNomeOnboarding(texto.trim());
  if (!nome || nome.length < 1 || nome.length > 50) {
    return `Me diz como quer ser chamado(a)! Pode ser seu nome, apelido… até _"Imperador do Cosmos"_ eu aceito 👑`;
  }

  await db.atualizarNomeUsuario(usuarioId, nome);
  setOnboardingState(usuarioId, 'aguardando_inicio');

  return (
    `A partir de agora eu te chamo de *${nome}* 😊\n\n` +
    `Agora me diz...\n` +
    `Como você prefere começar?\n\n` +
    `🎯 *Organizar tudo agora*\n` +
    `Eu te faço algumas perguntas rápidas e já deixo teu financeiro completo (saldo, receitas, despesas e contas do mês).\n\n` +
    `📝 *Ir cadastrando aos poucos*\n` +
    `Você vai me dizendo o que gastou ou recebeu no dia a dia, e eu organizo automaticamente.\n\n` +
    `👉 Recomendo organizar tudo agora pra você já ter uma visão clara do teu dinheiro. 💪`
  );
}

async function handleOnboardingInicio(usuarioId, texto) {
  const lower = texto.toLowerCase().trim();

  const querOrganizar = /organizar|agora|tudo|^1$|🎯/.test(lower);
  const querPoucos   = /poucos|gradual|^2$|📝|cadastrando/.test(lower);

  if (querOrganizar && !querPoucos) {
    setOnboardingState(usuarioId, null);
    return await iniciarPontoZero(usuarioId);
  }

  if (querPoucos && !querOrganizar) {
    setOnboardingState(usuarioId, null);
    return (
      `Ótimo! É bem simples. 😊\n\n` +
      `É só me contar o que você gastou ou recebeu, assim:\n\n` +
      `_"gastei 50 de gasolina"_\n` +
      `_"paguei 150 de conta de luz"_\n` +
      `_"recebi 2000 de salário"_\n` +
      `_"comprei R$ 80 no mercado"_\n\n` +
      `Pode mandar por texto, áudio ou foto de nota/boleto — eu registro e organizo tudo pra você!`
    );
  }

  // Fora de contexto: piada com o que disse + volta à pergunta
  setOnboardingState(usuarioId, 'aguardando_inicio');
  const promptPiada = (
    `O usuário está no onboarding de um app financeiro chamado Cronos. ` +
    `Ele acabou de ser perguntado se prefere "Organizar tudo agora" (opção 1) ou "Ir cadastrando aos poucos" (opção 2). ` +
    `Em vez de responder, ele mandou: "${texto}". ` +
    `Faça uma piada curta e espirituosa (máx 2 frases) sobre o que ele disse, com um toque financeiro se possível. ` +
    `Depois devolva com leveza à pergunta original, pedindo para escolher entre as duas opções. ` +
    `Não use emojis em excesso. Responda em português brasileiro.`
  );
  const piada = await responderAssistente(promptPiada);
  return (
    `${piada}\n\n` +
    `Mas voltando... 😄\n` +
    `🎯 *Organizar tudo agora* — te faço algumas perguntas rápidas\n` +
    `📝 *Ir cadastrando aos poucos* — você vai mandando conforme acontecer`
  );
}

// Estado de cadastro do painel web (aguardando usuário/senha) — expira em 5 min
const cadastroPainelEstados = new Map();

function salvarCadastroPainel(usuarioId, dados) {
  cadastroPainelEstados.set(usuarioId, { ...dados, expiraEm: Date.now() + 5 * 60 * 1000 });
}
function obterCadastroPainel(usuarioId) {
  const dados = cadastroPainelEstados.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { cadastroPainelEstados.delete(usuarioId); return null; }
  return dados;
}
function limparCadastroPainel(usuarioId) {
  cadastroPainelEstados.delete(usuarioId);
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

function isDataIsoValida(valor) {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
  const [ano, mes, dia] = valor.split('-').map(Number);
  const dt = new Date(ano, mes - 1, dia);
  return dt.getFullYear() === ano && (dt.getMonth() + 1) === mes && dt.getDate() === dia;
}

function normalizarDataConsulta(valor, campo, pergunta) {
  if (!valor || typeof valor !== 'string') return null;

  const bruto = valor.trim();
  if (!bruto) return null;

  let resolvida = resolverData(bruto);
  if (!resolvida && bruto.includes('/')) {
    resolvida = parseData(bruto);
  }

  if (isDataIsoValida(resolvida)) {
    return resolvida;
  }

  if (isDataIsoValida(bruto)) {
    return bruto;
  }

  console.warn(`[CONSULTA] Ignorando ${campo} invalida da IA: "${valor}" (pergunta="${pergunta || ''}")`);
  return null;
}

function extrairDataEspecificaNoTexto(texto) {
  const t = normalizarTextoBusca(texto);
  if (!t) return null;

  const isoMatch = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch && isDataIsoValida(isoMatch[1])) {
    return isoMatch[1];
  }

  const brMatch = t.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
  if (brMatch) {
    const dataBr = parseData(brMatch[1]);
    if (isDataIsoValida(dataBr)) return dataBr;
  }

  const diaProxMes = t.match(/\bdia\s+(\d{1,2})\s+do\s+proximo\s+mes\b/);
  if (diaProxMes) {
    const data = resolverData(`dia ${diaProxMes[1]} do proximo mes`);
    if (isDataIsoValida(data)) return data;
  }

  const diaMes = t.match(/\bdia\s+(\d{1,2})\b/);
  if (diaMes) {
    const data = resolverData(`dia ${diaMes[1]}`);
    if (isDataIsoValida(data)) return data;
  }

  if (/\banteontem\b/.test(t)) return resolverData('anteontem');
  if (/\bontem\b/.test(t)) return resolverData('ontem');
  if (/\bamanha\b/.test(t)) return resolverData('amanha');
  if (/\bhoje\b/.test(t)) return resolverData('hoje');

  const diaSemana = extrairDiaSemanaDoTexto(t);
  if (diaSemana) {
    const data = resolverData(diaSemana);
    if (isDataIsoValida(data)) return data;
  }

  return null;
}

function textoIndicaDataUnica(texto) {
  const t = normalizarTextoBusca(texto);
  if (!t) return false;

  if (/\bhoje\b|\bamanha\b|\bontem\b|\banteontem\b/.test(t)) return true;
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(t)) return true;
  if (/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(t)) return true;
  if (/\bdia\s+\d{1,2}\b/.test(t)) return true;
  if (extrairDiaSemanaDoTexto(t)) return true;

  return false;
}

function intervaloSemana(offsetSemanas = 0) {
  const hojeISO = dateParaISO(new Date());
  const [ano, mes, dia] = hojeISO.split('-').map(Number);
  const base = new Date(ano, mes - 1, dia, 12, 0, 0);
  const dow = base.getDay(); // 0=dom, 1=seg
  const diffSegunda = dow === 0 ? -6 : 1 - dow;

  const inicio = new Date(base);
  inicio.setDate(base.getDate() + diffSegunda + (offsetSemanas * 7));
  const fim = new Date(inicio);
  fim.setDate(inicio.getDate() + 6);

  return { dataInicio: dateParaISO(inicio), dataFim: dateParaISO(fim) };
}

function intervaloMes(offsetMeses = 0) {
  const hojeISO = dateParaISO(new Date());
  const [ano, mes] = hojeISO.split('-').map(Number);
  const primeiro = new Date(ano, (mes - 1) + offsetMeses, 1, 12, 0, 0);
  const ultimo = new Date(primeiro.getFullYear(), primeiro.getMonth() + 1, 0, 12, 0, 0);
  return { dataInicio: dateParaISO(primeiro), dataFim: dateParaISO(ultimo) };
}

function extrairPeriodoNaturalNoTexto(texto) {
  const t = normalizarTextoBusca(texto);
  if (!t) return null;

  const dataUnica = extrairDataEspecificaNoTexto(t);
  if (dataUnica) {
    return { dataInicio: dataUnica, dataFim: dataUnica, rotulo: fmt.formatarData(dataUnica), dataUnica: true };
  }

  if (t.includes('semana que vem') || t.includes('proxima semana')) {
    const p = intervaloSemana(1);
    return { ...p, rotulo: 'semana que vem', dataUnica: false };
  }

  if (t.includes('esta semana') || t.includes('essa semana') || t.includes('nessa semana') || t.includes('nesta semana') || t === 'semana') {
    const p = intervaloSemana(0);
    return { ...p, rotulo: 'esta semana', dataUnica: false };
  }

  if (t.includes('mes que vem') || t.includes('proximo mes')) {
    const p = intervaloMes(1);
    return { ...p, rotulo: 'proximo mes', dataUnica: false };
  }

  if (t.includes('este mes') || t.includes('esse mes') || t.includes('nesse mes') || t.includes('neste mes') || t === 'mes') {
    const p = intervaloMes(0);
    return { ...p, rotulo: 'este mes', dataUnica: false };
  }

  return null;
}

function extrairPeriodoLista(texto) {
  return extrairPeriodoNaturalNoTexto(texto);
}

function normalizarNumeroContato(input) {
  if (!input) return null;
  let digits = input.replace(/\D/g, '');

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.length < 12 || digits.length > 13) {
    return null;
  }

  return `${digits}@c.us`;
}

function extrairNumerosDeVCard(vcardText) {
  if (!vcardText || typeof vcardText !== 'string') return [];

  const encontrados = new Set();

  const waidRegex = /waid=(\d{8,20})/gi;
  let m;
  while ((m = waidRegex.exec(vcardText)) !== null) {
    if (m[1]) encontrados.add(m[1]);
  }

  const telRegex = /^TEL[^:]*:(.+)$/gim;
  while ((m = telRegex.exec(vcardText)) !== null) {
    if (!m[1]) continue;
    const digits = m[1].replace(/\D/g, '');
    if (digits) encontrados.add(digits);
  }

  return [...encontrados];
}

function formatarContatoExibicao(contatoId) {
  const digits = (contatoId || '').replace(/\D/g, '');
  if (!digits) return contatoId;

  // BR com código do país (55 + DDD + número local 8/9 dígitos)
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    if (local.length === 9) {
      return `+55 (${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
    }
    if (local.length === 8) {
      return `+55 (${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
    }
  }

  // BR sem código do país
  if (digits.length === 11 || digits.length === 10) {
    const ddd = digits.slice(0, 2);
    const local = digits.slice(2);
    if (local.length === 9) {
      return `(${ddd}) ${local.slice(0, 5)}-${local.slice(5)}`;
    }
    if (local.length === 8) {
      return `(${ddd}) ${local.slice(0, 4)}-${local.slice(4)}`;
    }
  }

  return `+${digits}`;
}

async function vincularContatoPorNumero(usuarioId, numeroInformado) {
  if (!numeroInformado) {
    return {
      texto: '❌ Informe o número do contato.\n\nExemplo: *adicionar contato 51999998888*',
      vinculoCriado: false,
    };
  }

  const contatoId = normalizarNumeroContato(numeroInformado);
  if (!contatoId) {
    return {
      texto: '❌ Número inválido. Envie com DDD e país.\n\nExemplo: *adicionar contato 5511999998888*',
      vinculoCriado: false,
    };
  }

  const resultado = await db.vincularContato(usuarioId, contatoId);
  const numeroFmt = formatarContatoExibicao(contatoId);

  if (resultado.status === 'self') {
    return { texto: '❌ Esse número é o seu próprio contato.', vinculoCriado: false };
  }
  if (resultado.status === 'invalid_contact') {
    return { texto: '❌ Não consegui validar esse número de contato.', vinculoCriado: false };
  }
  if (resultado.status === 'already_linked') {
    return {
      texto: `ℹ️ O contato *${numeroFmt}* já está vinculado à sua conta.`,
      vinculoCriado: false,
      contatoId,
    };
  }
  if (resultado.status === 'linked_to_other') {
    return {
      texto: `❌ O contato *${numeroFmt}* já está vinculado a outra conta do Cronos.`,
      vinculoCriado: false,
      contatoId,
    };
  }

  return {
    texto: `✅ Contato *${numeroFmt}* vinculado com sucesso!\n\nQuando essa pessoa mandar mensagem pro Cronos, ela vai acessar a mesma conta e as mesmas movimentações.`,
    vinculoCriado: true,
    contatoId,
  };
}

function mensagemBoasVindas(nome) {
  const nomeExibir = nome || 'amigo(a)';
  return `Fala ${nomeExibir}, aqui é o *Cronos*! 👋

Sou teu assistente financeiro no WhatsApp. Receitas, despesas, saldo, contas do mês — tudo aqui na conversa, sem app, sem planilha.

Como você prefere começar?

🎯 *Organizar tudo agora* — Respondo algumas perguntas rápidas e já monto teu financeiro completo (saldo, receitas e despesas do mês).

📝 *Ir cadastrando aos poucos* — Vai mandando o que gastar ou receber no dia a dia e eu vou organizando automaticamente.

_Recomendo organizar tudo agora pra já ter uma visão clara de como tá teu dinheiro!_ 💪`;
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
• *adicionar contato* <número> - Compartilhar a conta com outro WhatsApp
• *contatos* - Ver contatos vinculados
• *remover contato* - Remover um contato compartilhado (seleção por número)
• Ou envie o contato anexado pelo WhatsApp para vincular automaticamente
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

function mensagemConviteCompartilhado(nomeNovoUsuario, nomeUsuarioMaster) {
  const nomeNovo = nomeNovoUsuario || 'tudo bem';
  const nomeMaster = nomeUsuarioMaster || 'um usuário';

  return `Olá, ${nomeNovo}! 👋

O ${nomeMaster} te adicionou como usuário secundário no *Cronos Assistente Pessoal*.

A partir de agora, tudo que você registrar aqui será compartilhado com o usuário master e vice-versa.

Veja tudo o que você pode fazer:

${ajudaMsg()}

_Aproveite!_`;
}

function buildPainelUrl() {
  const port = parseInt(process.env.PORT) || 3000;
  let base = (process.env.PAINEL_BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  // Só adiciona porta se for localhost (sem domínio configurado)
  if (!process.env.PAINEL_BASE_URL) {
    base = `${base}:${port}`;
  }
  return base;
}

async function handleMeuPainel(usuarioId) {
  try {
    const conta = await db.buscarUsuarioPainelPorUserId(usuarioId);
    const url = buildPainelUrl();

    if (conta) {
      return [
        `🖥️ *Seu painel financeiro está disponível!*\n\nFaça login com:\n👤 Usuário: *${conta.username}*\n🔑 Sua senha cadastrada\n\n_Esqueceu a senha? Digite "redefinir senha do painel"._`,
        url,
      ];
    }

    // Primeira vez — iniciar cadastro
    salvarCadastroPainel(usuarioId, { etapa: 'aguardando_username' });
    return `🖥️ *Vamos configurar seu acesso ao painel web!*\n\nPrimeiro, escolha um *nome de usuário* para o login:\n\n_(Somente letras, números e underline. Ex: "joao_silva")_`;
  } catch (err) {
    console.error('[PAINEL] Erro ao verificar conta:', err.message);
    return `Ops, tive um problema. Tenta novamente!`;
  }
}

async function handleRedefinirSenhaPainel(usuarioId) {
  try {
    const conta = await db.buscarUsuarioPainelPorUserId(usuarioId);
    if (!conta) {
      return `Você ainda não tem uma conta no painel. Digite *meu painel* para criar.`;
    }
    // Reutiliza o fluxo de cadastro, mas só para nova senha
    salvarCadastroPainel(usuarioId, { etapa: 'aguardando_nova_senha', username: conta.username, redefinindo: true });
    return `🔑 Redefinindo senha do painel.\n\nDigite sua *nova senha*:\n_(Mínimo 6 caracteres)_`;
  } catch (err) {
    return `Ops, erro ao processar. Tenta novamente!`;
  }
}

async function handleCadastroPainel(usuarioId, msg, estado) {
  const texto = msg.trim();

  if (estado.etapa === 'aguardando_username') {
    // Validar username
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(texto)) {
      return `❌ Nome de usuário inválido.\n\nUse entre 3 e 20 caracteres: letras, números ou underline (_).\n\nTenta outro nome:`;
    }
    const disponivel = await db.usernameDisponivel(texto);
    if (!disponivel) {
      return `❌ O nome de usuário *${texto}* já está em uso.\n\nEscolha outro:`;
    }
    // Salvar username e pedir senha
    salvarCadastroPainel(usuarioId, { etapa: 'aguardando_senha', username: texto.toLowerCase() });
    return `✅ Ótimo! Usuário: *${texto.toLowerCase()}*\n\nAgora crie uma *senha* para o painel:\n\n_(Mínimo 6 caracteres. Não compartilhe com ninguém!)_`;
  }

  if (estado.etapa === 'aguardando_senha') {
    if (texto.length < 6) {
      return `❌ Senha muito curta. Use pelo menos 6 caracteres.\n\nTenta novamente:`;
    }
    if (texto.length > 100) {
      return `❌ Senha muito longa. Use no máximo 100 caracteres.`;
    }

    try {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(texto, 12);
      await db.criarUsuarioPainel(usuarioId, estado.username, hash);
      limparCadastroPainel(usuarioId);

      const url = buildPainelUrl();
      return [
        `🎉 *Conta criada com sucesso!*\n\nFaça login com:\n👤 Usuário: *${estado.username}*\n🔑 A senha que você acabou de criar\n\n_Guarde bem sua senha! Para acessar novamente, basta digitar "meu painel"._`,
        url,
      ];
    } catch (err) {
      console.error('[PAINEL] Erro ao criar conta:', err.message);
      limparCadastroPainel(usuarioId);
      return `Ops, tive um erro ao criar sua conta. Tenta de novo digitando "meu painel".`;
    }
  }

  if (estado.etapa === 'aguardando_nova_senha') {
    if (texto.length < 6) {
      return `❌ Senha muito curta. Use pelo menos 6 caracteres.\n\nTenta novamente:`;
    }
    if (texto.length > 100) {
      return `❌ Senha muito longa. Use no máximo 100 caracteres.`;
    }
    try {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(texto, 12);
      // Atualizar hash diretamente
      const { pool } = require('./database');
      await pool.query(
        `UPDATE painel_usuarios SET password_hash = $1 WHERE username = $2`,
        [hash, estado.username]
      );
      limparCadastroPainel(usuarioId);
      return `✅ *Senha do painel atualizada com sucesso!*\n\nFaça login com:\n👤 Usuário: *${estado.username}*\n🔑 Sua nova senha`;
    } catch (err) {
      console.error('[PAINEL] Erro ao redefinir senha:', err.message);
      limparCadastroPainel(usuarioId);
      return `Ops, erro ao atualizar a senha. Tenta novamente!`;
    }
  }

  limparCadastroPainel(usuarioId);
  return null;
}

// Palavras que indicam que o usuário confirmou pagamento/recebimento
const PALAVRAS_PAGAMENTO_CONFIRMADO = [
  'paguei', 'ja paguei', 'já paguei', 'pago', 'já pago', 'ja pago',
  'sim', 'confirmado', 'feito', 'ok', 'okay', 'sim paguei',
  'recebi', 'já recebi', 'ja recebi', 'recebido',
  'foi', 'pronto', 'done', 'realizado', 'efetuado',
  'acabei de pagar', 'acabei de receber',
];

// Subset de palavras inequivocamente de pagamento — usadas para fallback via DB (sem estado em memória)
const PALAVRAS_CONFIRMACAO_FORTE = [
  'paguei', 'ja paguei', 'já paguei', 'pago', 'já pago', 'ja pago',
  'sim paguei', 'acabei de pagar', 'acabei de receber',
  'recebi', 'já recebi', 'ja recebi', 'recebido',
];

function normalizarTexto(lower) {
  return lower
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fallback: quando não há estado em memória, confirma pagamento via lembretes_enviados do dia
async function tentarConfirmacaoPorDB(usuarioId, lower) {
  // Buscar pendentes primeiro — se não houver, não vale nem verificar intent
  const pendentes = await db.buscarPendentesLembradosHoje(usuarioId);
  if (pendentes.length === 0) return null;

  // Fast path: palavras fortes e inequívocas de pagamento
  const normalizado = normalizarTexto(lower);
  let confirmou = PALAVRAS_CONFIRMACAO_FORTE.some(p =>
    normalizado === p || normalizado.startsWith(p + ' ') || normalizado.endsWith(' ' + p)
  );

  // Slow path: IA interpreta linguagem natural ("já fiz", "mandei o pix", "quitei", etc.)
  if (!confirmou) {
    confirmou = await interpretarConfirmacaoPagamento(lower);
  }

  if (!confirmou) return null;

  const pagas = [];
  for (const t of pendentes) {
    const result = await db.liquidarTransacaoPorId(t.id);
    if (result) pagas.push(result);
  }

  if (pagas.length === 0) {
    return `✅ Essas transações já estão marcadas como pagas. Tudo certo!`;
  }

  if (pagas.length === 1) {
    const t = pagas[0];
    const acao = t.tipo === 'despesa' ? 'paga' : 'recebida';
    return `✅ *${t.descricao}* marcada como ${acao}! Ótimo! 🎉`;
  }

  const lista = pagas.map(t => `  • *${t.descricao}* (${fmt.formatarMoeda(t.valor)})`).join('\n');
  return `✅ *${pagas.length} contas* marcadas como pagas:\n${lista}\n\nÓtimo! 🎉`;
}

async function handleConfirmacaoLembrete(usuarioId, lower, estado) {
  const normalizado = normalizarTexto(lower);

  // Fast path: palavras-chave conhecidas
  let confirmou = PALAVRAS_PAGAMENTO_CONFIRMADO.some(p =>
    normalizado === p || normalizado.startsWith(p + ' ') || normalizado.endsWith(' ' + p)
  );

  // Slow path: IA interpreta linguagem natural ("já fiz", "mandei o pix", "quitei", etc.)
  if (!confirmou) {
    confirmou = await interpretarConfirmacaoPagamento(lower);
  }

  if (!confirmou) {
    // Não é confirmação de pagamento — limpar estado e processar como mensagem normal
    limparConfirmacaoLembrete(usuarioId);
    return null;
  }

  // Marcar todas as transações do lembrete como pagas
  const { transacaoIds, transacoesInfo } = estado;
  limparConfirmacaoLembrete(usuarioId);

  const pagas = [];
  for (const id of transacaoIds) {
    try {
      const result = await db.liquidarTransacaoPorId(id);
      if (result) pagas.push(result);
    } catch (err) {
      console.error(`[CONFIRMACAO_LEMBRETE] Erro ao liquidar transacao ${id}:`, err.message);
    }
  }

  if (pagas.length === 0) {
    return `✅ Essas transações já estão marcadas como pagas. Tudo certo!`;
  }

  if (pagas.length === 1) {
    const t = pagas[0];
    const acao = t.tipo === 'despesa' ? 'pagamento' : 'recebimento';
    return `✅ *${t.descricao}* marcada como ${acao === 'pagamento' ? 'paga' : 'recebida'}! Ótimo, tudo anotado aqui! 🎉`;
  }

  const lista = pagas.map(t => `  • *${t.descricao}* (${fmt.formatarMoeda(t.valor)})`).join('\n');
  return `✅ *${pagas.length} contas* marcadas como pagas:\n${lista}\n\nÓtimo, tudo anotado! 🎉`;
}

// Mensagens de ack enquanto o bot vai buscar informações
function gerarMensagemAck(acao, contexto = '') {
  const ctx = contexto.toLowerCase();
  const isComida = /receita|bolo|prato|cozin|jantar|almoç|sabor|ingrediente|tempero|culiná|pão|doce|torta|massa|sopa|arroz|feijão|frango|carne/.test(ctx);
  const isTreinamento = /exerc|treino|academia|muscu|corrida|yoga|pilates|malhar|alongar/.test(ctx);

  if (acao === 'assistente' && isComida) {
    const msgs = [
      'Se algum dia eu puder sentir sabor, vou querer isso... já procuro! 🍽️',
      'Me deu uma fome digital só de ler isso. Um segundo! 🤌',
      'Consultando meus circuitos gastronômicos... 👨‍🍳',
      'Já busco! _ps: na minha lista de desejos tá sentir cheiro de comida_ 😄',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  if (acao === 'assistente' && isTreinamento) {
    const msgs = [
      'Consultando meu lado atlético virtual... 💪',
      'Já busco! _ps: eu nunca canso, mas você vai_ 😅',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  if (acao === 'assistente') {
    const msgs = [
      'Boa pergunta! Um segundo... 🧠',
      'Deixa eu pensar nisso... ⚡',
      'Consultando meus arquivos mentais... 📚',
      'Processando... _(não, de verdade, isso leva um segundo)_ 🤖',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  if (acao === 'pesquisa') {
    const msgs = [
      'Já vou perguntar pro Google pra você... 🔍',
      'Pesquisando nos confins da internet... 🌐',
      'Ligando pro meu parente robótico... 🤖',
      'Um segundo, vou vasculhar a web! 🔎',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  if (acao === 'busca_local') {
    const msgs = [
      'Analisando a sua vizinhança... 📍',
      'Consultando o mapa! 🗺️',
      'Verificando o que tem por aí... 📡',
      'Deixa eu dar uma olhada pra você! 🗺️',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  return 'Um segundo... ⏳';
}

async function handleMessage(usuarioId, texto, enviarAck) {
  const msg = texto.trim();
  const lower = msg.toLowerCase();

  // Verificar se está no fluxo de onboarding (novo usuário)
  const estadoOnboarding = await getOnboardingState(usuarioId);
  if (estadoOnboarding === 'aguardando_nome') {
    return await handleOnboardingNome(usuarioId, msg);
  }
  if (estadoOnboarding === 'aguardando_inicio') {
    return await handleOnboardingInicio(usuarioId, msg);
  }

  // Verificar se está no fluxo Finanças em Dia — posição #2 para bloquear todos os outros estados
  const pontoZero = await obterPontoZero(usuarioId);
  if (pontoZero) {
    return await handlePontoZero(usuarioId, msg, pontoZero);
  }

  // Verificar se está no fluxo de cadastro do painel web
  const cadastroPainel = obterCadastroPainel(usuarioId);
  if (cadastroPainel) {
    const resposta = await handleCadastroPainel(usuarioId, msg, cadastroPainel);
    if (resposta !== null) return resposta;
  }

  // Verificar se há confirmação de lembrete financeiro pendente
  const confLembrete = obterConfirmacaoLembrete(usuarioId);
  if (confLembrete) {
    const resposta = await handleConfirmacaoLembrete(usuarioId, lower, confLembrete);
    if (resposta !== null) return resposta;
    // resposta null = não confirmou, seguir fluxo normal
  } else {
    // Sem estado em memória (bot reiniciou ou estado foi limpo) — tentar confirmação via DB
    const resposta = await tentarConfirmacaoPorDB(usuarioId, lower);
    if (resposta !== null) return resposta;
  }

  // Verificar se há transação com dados incompletos
  const txPendente = obterTransacaoPendente(usuarioId);
  if (txPendente) {
    return await handleTransacaoPendenteResposta(usuarioId, msg, txPendente);
  }

  // Verificar se há assessor de compra aguardando valor
  const assessorPendente = obterAssessorCompra(usuarioId);
  if (assessorPendente) {
    return await handleAssessorCompraContinuacao(usuarioId, msg, assessorPendente);
  }

  // Verificar se há confirmação pendente de imagem
  const confirmacao = obterConfirmacao(usuarioId);
  if (confirmacao) {
    return await handleConfirmacaoImagem(usuarioId, lower, confirmacao);
  }

  // Verificar se há seleção pendente para remover contato compartilhado
  const remocaoContato = obterRemocaoContatoPendente(usuarioId);
  if (remocaoContato) {
    return await handleEscolhaRemocaoContato(usuarioId, msg, remocaoContato);
  }

  // Verificar se tem lembrete aguardando horário
  const lembretePend = obterLembretePendente(usuarioId);
  if (lembretePend) {
    return await handleLembreteHorario(usuarioId, msg, lembretePend);
  }

  // Verificar se está no fluxo Análise Financeira
  const analise = obterAnaliseFinanceira(usuarioId);
  if (analise) {
    return await handleAnaliseFinanceiraMsg(usuarioId, msg, analise);
  }

  // Comando: análise financeira (texto direto)
  if (lower === 'análise financeira' || lower === 'analise financeira' || lower === '50 30 20' || lower === '503020') {
    return await iniciarAnaliseFinanceira(usuarioId);
  }

  // Comando: finanças em dia (texto direto)
  if (lower === 'finanças em dia' || lower === 'financas em dia') {
    return await iniciarPontoZero(usuarioId);
  }

  // Comando: painel web
  if (lower === 'meu painel' || lower === 'painel' || lower === 'dashboard') {
    return await handleMeuPainel(usuarioId);
  }

  // Comando: redefinir senha do painel
  if (lower === 'redefinir senha do painel' || lower === 'redefinir senha painel' || lower === 'trocar senha do painel') {
    return await handleRedefinirSenhaPainel(usuarioId);
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

  // Comando: adicionar contato (conta em conjunto)
  if (
    lower === 'adicionar contato' || lower === 'vincular contato' || lower === 'compartilhar com' ||
    lower.startsWith('adicionar contato ') || lower.startsWith('vincular contato ') || lower.startsWith('compartilhar com ')
  ) {
    return await handleAdicionarContato(usuarioId, msg);
  }

  // Comando: listar contatos vinculados
  if (lower === 'contatos' || lower === 'meus contatos' || lower === 'contatos vinculados') {
    return await handleListarContatos(usuarioId);
  }

  // Comando: remover contato compartilhado
  if (
    lower === 'remover contato' || lower === 'excluir contato' ||
    lower.startsWith('remover contato ') || lower.startsWith('excluir contato ')
  ) {
    return await handleIniciarRemocaoContato(usuarioId, msg);
  }

  // Comando: despesa / receita (direto) — só roteia se 2ª palavra for um valor numérico.
  // Se não for número (ex: "receita de bolinho de arroz"), cai na IA para interpretar corretamente.
  if (lower.startsWith('despesa ') || lower.startsWith('receita ')) {
    const segundaPalavra = msg.trim().split(/\s+/)[1] || '';
    if (parseValor(segundaPalavra) !== null) {
      return await handleTransacao(usuarioId, msg);
    }
  }

  // Comando: resumo
  if (lower.startsWith('resumo')) {
    return await handleResumo(usuarioId, msg);
  }

  // Comando: meu plano / assinatura
  if (lower === 'meu plano' || lower === 'minha assinatura' || lower === 'plano' || lower === 'assinatura' || lower === 'meu plano cronos') {
    return await pagamento.consultarPlano(usuarioId);
  }

  // Comando: escolher plano mensal ou anual
  if (lower === 'mensal' || lower === 'plano mensal' || lower === 'assinar mensal') {
    return await pagamento.gerarLinkPlano(usuarioId, 'mensal');
  }
  if (lower === 'anual' || lower === 'plano anual' || lower === 'assinar anual') {
    return await pagamento.gerarLinkPlano(usuarioId, 'anual');
  }

  // Comando admin: ativar <numero> — ativa assinatura manualmente
  if (lower.startsWith('ativar ')) {
    const admins = (process.env.ADMIN_WHATSAPP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (admins.includes(usuarioId)) {
      const numeroRaw = texto.trim().slice(7).trim();
      const numero = numeroRaw.replace(/\D/g, '');
      if (numero.length >= 10) {
        const digits = numero.startsWith('55') ? numero : `55${numero}`;
        const alvoId = `${digits}@c.us`;
        const pagoAteStr = await pagamento.ativarManualmente(alvoId);
        return `✅ Assinatura ativada para *${alvoId}* até *${pagoAteStr.split('-').reverse().join('/')}*`;
      }
      return `❌ Número inválido. Use: _ativar 5511999999999_`;
    }
  }

  // Comando: cupom <CODIGO> — aplica cupom de desconto ou dias grátis
  if (lower.startsWith('cupom ')) {
    const codigo = texto.trim().slice(6).trim();
    if (!codigo) return `❌ Informe o código do cupom.\n_Ex: cupom CRONOS30_`;
    const resultado = await pagamento.aplicarCupom(usuarioId, codigo);
    if (!resultado.ok) return `❌ ${resultado.erro}`;
    if (resultado.tipo === 'dias_gratis') {
      const dataFormatada = resultado.pagoAte.split('-').reverse().join('/');
      return `🎉 *Cupom aplicado com sucesso!*\n\n✅ Seu acesso foi estendido por *${resultado.dias} dia(s)*.\n📅 Assinatura válida até: *${dataFormatada}*`;
    }
    if (resultado.tipo === 'desconto_percent') {
      return `🎉 *Cupom de ${resultado.desconto}% de desconto aplicado!*\n\nUse este link para assinar com desconto:\n👉 ${resultado.link}`;
    }
    return `✅ Cupom aplicado com sucesso!`;
  }

  // Comando: caixinhas / investimentos
  if (lower === 'caixinhas' || lower === 'investimentos' || lower === 'minhas caixinhas' || lower === 'meus investimentos') {
    return await handleListarCaixinhas(usuarioId);
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
  return await handleMensagemIA(usuarioId, msg, enviarAck);
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

  const norm = normalizarTextoBusca(lower);
  const hoje = new Date();
  let mes, ano;

  // "mês que vem" / "próximo mês" / "proximo mes"
  if (norm.includes('mes que vem') || norm.includes('proximo mes')) {
    const proximo = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
    mes = proximo.getMonth() + 1;
    ano = proximo.getFullYear();
  } else {
    // Nome de mês por extenso ("março", "abril", etc.)
    const MESES_NOME_R = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
    const nomeMesEncontrado = Object.keys(MESES_NOME_R).find(n => norm.includes(n));
    if (nomeMesEncontrado) {
      mes = MESES_NOME_R[nomeMesEncontrado];
      // Ano explícito no texto (ex: "2027") ou inferir
      const anoMatch = norm.match(/\b(20\d{2})\b/);
      if (anoMatch) {
        ano = parseInt(anoMatch[1]);
      } else {
        // Se o mês já passou este ano, assume próximo ano
        ano = mes < (hoje.getMonth() + 1) ? hoje.getFullYear() + 1 : hoje.getFullYear();
      }
    } else {
      // Fallback: formato numérico "resumo 3" ou "resumo 3/2026"
      const partes = lower.split(/\s+/);
      if (partes[1]) {
        const subPartes = partes[1].split('/');
        const mesNum = parseInt(subPartes[0]);
        if (!isNaN(mesNum)) {
          mes = mesNum;
          if (subPartes[1]) ano = parseInt(subPartes[1]);
        }
      }
    }
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

  const periodo = extrairPeriodoLista(lower);
  let transacoes;

  if (periodo) {
    transacoes = await db.consultarTransacoes(usuarioId, {
      tipo,
      dataInicio: periodo.dataInicio,
      dataFim: periodo.dataFim,
      limite: 50,
    });

    if (transacoes.length === 0) {
      const alvo = tipo ? ` de ${tipo}s` : '';
      return `📋 Nenhum lançamento${alvo} encontrado para ${periodo.rotulo}.`;
    }
  } else {
    transacoes = await db.listarTransacoes(usuarioId, tipo, 10);
  }

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

async function handleAdicionarContato(usuarioId, msg) {
  const numero = msg
    .replace(/^adicionar contato\s*/i, '')
    .replace(/^vincular contato\s*/i, '')
    .replace(/^compartilhar com\s*/i, '')
    .trim();

  const resultado = await vincularContatoPorNumero(usuarioId, numero);
  return {
    texto: resultado.texto,
    notificarContatos: resultado.vinculoCriado && resultado.contatoId
      ? [{ contatoId: resultado.contatoId }]
      : [],
  };
}

async function handleContatoCompartilhado(usuarioId, vcardsRaw) {
  const vcards = Array.isArray(vcardsRaw) ? vcardsRaw : [vcardsRaw];
  const numeros = new Set();

  for (const v of vcards) {
    for (const n of extrairNumerosDeVCard(v)) {
      numeros.add(n);
    }
  }

  if (numeros.size === 0) {
    return {
      texto: '❌ Não consegui extrair o número deste contato.\n\nTente enviar novamente ou use: *adicionar contato 5511999998888*',
      notificarContatos: [],
    };
  }

  const resultados = [];
  for (const numero of numeros) {
    const resposta = await vincularContatoPorNumero(usuarioId, numero);
    resultados.push(resposta);
  }

  if (resultados.length === 1) {
    return {
      texto: resultados[0].texto,
      notificarContatos: resultados[0].vinculoCriado && resultados[0].contatoId
        ? [{ contatoId: resultados[0].contatoId }]
        : [],
    };
  }

  const textos = resultados.map(r => `• ${r.texto}`).join('\n\n');
  const notificarContatos = resultados
    .filter(r => r.vinculoCriado && r.contatoId)
    .map(r => ({ contatoId: r.contatoId }));

  return {
    texto: `✅ Contatos processados:\n\n${textos}`,
    notificarContatos,
  };
}

async function handleListarContatos(usuarioId) {
  const contatos = await db.listarContatosCompartilhados(usuarioId);

  if (!contatos || contatos.length === 0) {
    return '👥 Você ainda não tem contatos vinculados.\n\nUse: *adicionar contato 5511999998888*';
  }

  let msg = '👥 *Contatos vinculados à sua conta:*\n\n';
  for (const contato of contatos) {
    msg += `• ${formatarContatoExibicao(contato)}\n`;
  }
  return msg;
}

async function handleIniciarRemocaoContato(usuarioId, msg) {
  const vinculo = await db.obterVinculoSecundario(usuarioId);
  if (vinculo && vinculo.usuario_principal_id !== usuarioId) {
    return '❌ Apenas o usuário master pode remover contatos compartilhados.';
  }

  const contatos = await db.listarContatosCompartilhados(usuarioId);
  if (!contatos || contatos.length === 0) {
    return '👥 Você não tem contatos compartilhados para remover.';
  }

  const matchIndice = msg.trim().match(/\b(\d{1,2})$/);
  if (matchIndice) {
    const indice = parseInt(matchIndice[1], 10);
    if (!indice || indice < 1 || indice > contatos.length) {
      return `❌ Escolha inválida. Digite um número de 1 a ${contatos.length}.`;
    }

    const contatoEscolhido = contatos[indice - 1];
    const removido = await db.removerContatoCompartilhado(usuarioId, contatoEscolhido);
    if (!removido) {
      return '❌ Não consegui remover esse contato agora. Tente novamente.';
    }
    return `✅ Contato *${formatarContatoExibicao(contatoEscolhido)}* removido dos compartilhados.`;
  }

  salvarRemocaoContatoPendente(usuarioId, { contatos });

  let texto = '👥 *Contatos compartilhados:*\n\n';
  contatos.forEach((contato, i) => {
    texto += `${i + 1}. ${formatarContatoExibicao(contato)}\n`;
  });

  texto += '\nDigite o número do contato que você quer remover.\n_Ex: 1_\n\n_Para cancelar: digite "cancelar"_';
  return texto;
}

async function handleEscolhaRemocaoContato(usuarioId, msg, estado) {
  const lower = msg.toLowerCase().trim();

  if (lower === 'cancelar' || lower === 'sair' || lower === 'parar') {
    limparRemocaoContatoPendente(usuarioId);
    return '✅ Remoção de contato cancelada.';
  }

  const indice = parseInt(lower, 10);
  if (!indice || isNaN(indice)) {
    return `Digite apenas o número do contato que deseja remover (1 a ${estado.contatos.length}).\n_Para cancelar: "cancelar"_`;
  }

  if (indice < 1 || indice > estado.contatos.length) {
    return `❌ Número inválido. Escolha entre 1 e ${estado.contatos.length}.`;
  }

  const contatoEscolhido = estado.contatos[indice - 1];
  const removido = await db.removerContatoCompartilhado(usuarioId, contatoEscolhido);
  if (!removido) {
    limparRemocaoContatoPendente(usuarioId);
    return '❌ Não consegui remover esse contato agora. Tente novamente com *remover contato*.';
  }

  limparRemocaoContatoPendente(usuarioId);
  return `✅ Contato *${formatarContatoExibicao(contatoEscolhido)}* removido dos compartilhados.`;
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
    const budgetCat = await resolverBudgetCategoria(categoria);
    if (budgetCat) {
      // subcats: categorias hardcoded do bucket + a própria categoria (cobre categorias novas)
      const subcats = [...(MAPA_BUDGET[budgetCat] || []), categoria].filter((v, i, a) => a.indexOf(v) === i);
      const limiteInfo = await db.verificarLimite(usuarioId, budgetCat, subcats);
      if (limiteInfo) msg += formatarBlocoLimite(limiteInfo, categoria, budgetCat);
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

async function processarResultadoIA(usuarioId, resultado, fallbackMsg, textoOriginal, enviarAck) {
  const lower = (textoOriginal || '').toLowerCase();
  if (!resultado) {
    if (fallbackMsg) return fallbackMsg;
    const usuario = await db.buscarUsuario(usuarioId);
    return foraDoEscopoMsg(usuario?.nome || null);
  }

  // Finanças em Dia - organizar finanças
  if (resultado.acao === 'financas_em_dia') {
    return await iniciarPontoZero(usuarioId);
  }

  // Cadastro livre - preferência por ir registrando aos poucos
  if (resultado.acao === 'cadastro_livre') {
    return `Ótimo! É bem simples. 😊\n\nÉ só me contar o que você gastou ou recebeu, assim:\n\n_"gastei 50 de gasolina"_\n_"paguei 150 de conta de luz"_\n_"recebi 2000 de salário"_\n_"comprei R$ 80 no mercado"_\n\nPode mandar por texto, áudio ou foto de nota/boleto — eu registro e organizo tudo pra você!`;
  }

  // Análise financeira 50/30/20
  if (resultado.acao === 'analise_financeira') {
    return await iniciarAnaliseFinanceira(usuarioId);
  }

  // Assessor de compra / viabilidade de compra
  if (resultado.acao === 'assessor_compra') {
    return await handleAssessorCompra(usuarioId, resultado);
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
    // Detectar dia da semana no texto original e sobrescrever data da IA (que erra o cálculo)
    const diaDetectado = extrairDiaSemanaDoTexto(lower);
    if (diaDetectado) {
      console.log(`[LEMBRETE] dia da semana detectado no texto: "${diaDetectado}" (sobrescrevendo IA: "${resultado.data}")`);
      resultado.data = diaDetectado;
    }
    return await handleLembrete(usuarioId, resultado);
  }

  // Lembrete recorrente
  if (resultado.acao === 'lembrete_recorrente') {
    return await handleLembreteRecorrente(usuarioId, resultado);
  }

  // Despesa ou receita recorrente (entra no fluxo financeiro)
  if (resultado.acao === 'transacao_recorrente') {
    return await handleTransacaoRecorrente(usuarioId, resultado);
  }

  // Listar lembretes (únicos + recorrentes)
  if (resultado.acao === 'listar_lembretes') {
    return await handleListarTodosLembretes(usuarioId);
  }

  // Listar apenas recorrentes
  if (resultado.acao === 'listar_recorrentes') {
    return await handleListarRecorrentes(usuarioId);
  }

  // Consultar plano / assinatura
  if (resultado.acao === 'meu_plano') {
    return await pagamento.consultarPlano(usuarioId);
  }

  // Listar caixinhas de investimento
  if (resultado.acao === 'caixinhas') {
    return await handleListarCaixinhas(usuarioId);
  }

  // Depósito em caixinha existente
  if (resultado.acao === 'deposito_caixinha') {
    return await handleDepositoCaixinha(usuarioId, resultado);
  }

  // Cadastro standalone de cartão de crédito
  if (resultado.acao === 'novo_cartao') {
    return await iniciarCadastroCartaoStandalone(usuarioId);
  }

  // Cadastro standalone de caixinha/investimento
  if (resultado.acao === 'nova_caixinha') {
    return await iniciarCadastroCaixinhaStandalone(usuarioId);
  }

  // Agenda - visão geral do dia/semana/mês
  if (resultado.acao === 'agenda') {
    // Detectar dia da semana no texto e sobrescrever periodo da IA
    const diaDetectadoAg = extrairDiaSemanaDoTexto(lower);
    if (diaDetectadoAg) {
      resultado.periodo = diaDetectadoAg;
    }
    return await handleAgenda(usuarioId, resultado.periodo || 'hoje');
  }

  // Consulta - buscar no banco e formatar resultado
  if (resultado.acao === 'consulta') {
    return await handleConsulta(usuarioId, resultado, textoOriginal);
  }

  // Conversa casual - resposta humana e natural
  if (resultado.acao === 'conversa') {
    return resultado.resposta;
  }

  // Assistente do dia a dia - respostas rápidas e práticas
  if (resultado.acao === 'assistente') {
    const pergunta = resultado.pergunta || textoOriginal;
    if (enviarAck) await enviarAck(gerarMensagemAck('assistente', textoOriginal)).catch(() => {});
    const resposta = await responderAssistente(pergunta);
    return resposta || '❌ Não consegui processar sua pergunta. Tente de novo!';
  }

  // Pesquisa na internet
  if (resultado.acao === 'pesquisa') {
    const temLocalizacaoRecente = !!obterLocalizacao(usuarioId);
    const deveForcarBuscaLocal = textoIndicaBuscaLocal(textoOriginal)
      || (temLocalizacaoRecente && textoCurtoPodeSerBuscaLocal(textoOriginal));

    if (deveForcarBuscaLocal) {
      const resultadoLocal = montarResultadoBuscaLocal(resultado, textoOriginal);
      console.log(`[BUSCA LOCAL] Forcando busca_local (acao original: pesquisa) query="${resultadoLocal.query}"`);
      if (enviarAck) await enviarAck(gerarMensagemAck('busca_local', textoOriginal)).catch(() => {});
      return await handleBuscaLocal(usuarioId, resultadoLocal);
    }

    if (enviarAck) await enviarAck(gerarMensagemAck('pesquisa', textoOriginal)).catch(() => {});
    return await handlePesquisa(resultado);
  }

  // Busca local (por localização)
  if (resultado.acao === 'busca_local') {
    if (enviarAck) await enviarAck(gerarMensagemAck('busca_local', textoOriginal)).catch(() => {});
    return await handleBuscaLocal(usuarioId, montarResultadoBuscaLocal(resultado, textoOriginal));
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
      // Chamar handleResumo com a mensagem original para capturar mês/período
      return await handleResumo(usuarioId, textoOriginal || 'resumo');
    }
    if (resultado.dica === 'lista') {
      const transacoes = await db.listarTransacoes(usuarioId, null, 10);
      return fmt.formatarListaTransacoes(transacoes);
    }
    return `Parece que você quer usar um comando. Tente digitar: *${resultado.dica || 'ajuda'}*`;
  }

  // Transação via IA
  if (resultado.acao === 'transacao') {
    // Detectar dia da semana no texto e sobrescrever data da IA
    const diaDetectadoTx = extrairDiaSemanaDoTexto(lower);
    if (diaDetectadoTx) {
      resultado.data = diaDetectadoTx;
    }
    const { tipo, descricao, categoria, status } = resultado;
    const valor = resultado.valor && resultado.valor > 0 ? resultado.valor : null;
    const statusFinal = status === 'pendente' ? 'pendente' : 'pago';

    // Resolver data
    let dataFinal = resolverData(resultado.data);
    if (!dataFinal && resultado.data && resultado.data.includes('/')) {
      dataFinal = parseData(resultado.data);
    }

    // Se a descrição não foi identificada, pedir mais info
    if (!tipo || !descricao) {
      return `Não consegui extrair todas as informações. Tente ser mais específico.\n\nExemplo: _"gastei 50 reais no almoço"_ ou _"pagar aluguel sexta 1500"_`;
    }

    // Se falta valor ou data (em pendente), iniciar fluxo de perguntas
    const faltaValor = !valor;
    const faltaData = statusFinal === 'pendente' && !dataFinal;

    if (faltaValor || faltaData) {
      const pendente = {
        tipo,
        valor: valor || null,
        descricao,
        categoria: categoria || 'Outros',
        data: dataFinal || null,
        status: statusFinal,
      };

      const proximo = perguntarProximoCampo(pendente);
      if (proximo) {
        salvarTransacaoPendente(usuarioId, pendente);
        let intro = `Anotei! *${descricao}*`;
        if (valor) intro += ` no valor de *${fmt.formatarMoeda(valor)}*`;
        if (dataFinal) intro += ` para *${fmt.formatarData(dataFinal)}*`;
        return `${intro} 👍\n\n${proximo.msg}`;
      }
    }

    // Verificar se a compra foi feita em um cartão de crédito cadastrado
    let cartaoId = null;
    if (resultado.cartao_nome && tipo === 'despesa') {
      const cartoes = await db.buscarCartoesPorNome(usuarioId, resultado.cartao_nome);
      if (cartoes.length >= 1) cartaoId = cartoes[0].id;
    }

    return await salvarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal, cartaoId);
  }

  if (resultado.acao === 'uso_cartao') {
    return await handleUsoCartao(usuarioId, resultado.cartao_nome || null);
  }

  return foraDoEscopoMsg();
}

async function salvarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal, cartaoId = null) {
  const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal, cartaoId);
  const dataExibir = dataFinal ? fmt.formatarData(dataFinal) : 'Hoje';

  let emoji, label;
  if (cartaoId) {
    emoji = '💳';
    label = 'Compra no cartão registrada';
  } else if (statusFinal === 'pendente') {
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

  if (cartaoId) {
    // Mostrar uso atualizado do cartão
    try {
      const cartoes = await db.listarCartoes(usuarioId);
      const cartao = cartoes.find(c => c.id === cartaoId);
      if (cartao) {
        const { total } = await db.calcularUsoCartao(cartaoId, cartao.dia_fechamento);
        const disponivel = cartao.limite_total ? cartao.limite_total - total : null;
        msg += `\n\n💳 *${cartao.nome}*: ${fmt.formatarMoeda(total)} usado no ciclo`;
        if (disponivel !== null) msg += ` | *${fmt.formatarMoeda(disponivel)} disponível*`;
      }
    } catch { /* silencia erro secundário */ }
  } else if (statusFinal === 'pendente') {
    const quando = tipo === 'receita' ? 'receber' : 'pagar';
    msg += `\n\n_Vou te lembrar quando chegar o dia de ${quando}! 📅_`;
  }

  // Verificar limite de gastos (apenas para despesas diretas — sem cartão)
  if (tipo === 'despesa' && categoria && !cartaoId) {
    const budgetCat = await resolverBudgetCategoria(categoria);
    if (budgetCat) {
      const subcats = [...(MAPA_BUDGET[budgetCat] || []), categoria].filter((v, i, a) => a.indexOf(v) === i);
      const limiteInfo = await db.verificarLimite(usuarioId, budgetCat, subcats);
      if (limiteInfo) msg += formatarBlocoLimite(limiteInfo, categoria, budgetCat);
    }
  }

  return msg;
}

// Extrai valor de um texto (ex: "150", "R$ 1.200,50", "mil reais", "50 reais")
function extrairValorDoTexto(texto) {
  const t = texto.replace(/\s+/g, ' ').trim();

  // R$ 1.200,50 ou 1200,50 ou 1200.50
  const matchMoeda = t.match(/R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (matchMoeda) {
    return parseFloat(matchMoeda[1].replace(/\./g, '').replace(',', '.'));
  }

  // Número com vírgula como decimal (50,90)
  const matchVirgula = t.match(/(\d+),(\d{1,2})/);
  if (matchVirgula) {
    return parseFloat(`${matchVirgula[1]}.${matchVirgula[2]}`);
  }

  // Notação k/K — 30k = 30.000, 1,5k = 1.500
  const matchK = t.match(/(\d+(?:[.,]\d+)?)\s*[kK]\b/);
  if (matchK) {
    return Math.round(parseFloat(matchK[1].replace(',', '.')) * 1000 * 100) / 100;
  }

  // Notação "X mil" — 30 mil, 5 mil, 1,5 mil
  const matchMil = t.match(/(\d+(?:[.,]\d+)?)\s*mil\b/i);
  if (matchMil) {
    return Math.round(parseFloat(matchMil[1].replace(',', '.')) * 1000 * 100) / 100;
  }

  // Notação "X milhão/milhões" — 1 milhão, 2,5 milhões
  const matchMilhao = t.match(/(\d+(?:[.,]\d+)?)\s*milh[ãa]o[e]?[s]?/i);
  if (matchMilhao) {
    return Math.round(parseFloat(matchMilhao[1].replace(',', '.')) * 1000000 * 100) / 100;
  }

  // Número simples (150, 1200)
  const matchNum = t.match(/(\d+(?:\.\d+)?)/);
  if (matchNum) {
    return parseFloat(matchNum[1]);
  }

  return null;
}

// Wrapper robusto: tenta regex primeiro, usa IA como fallback para texto livre
async function extrairValorRobusto(texto) {
  const valor = extrairValorDoTexto(texto);
  if (valor !== null) return valor;
  return await extrairValorMonetario(texto);
}

// Extrai data de um texto usando todas as estratégias
function extrairDataDoTexto(texto) {
  const lower = texto.toLowerCase().trim();

  // 1. Dia da semana
  const dia = extrairDiaSemanaDoTexto(lower);
  if (dia) return resolverData(dia);

  // 2. resolverData direto (hoje, amanhã, ontem, YYYY-MM-DD, DD/MM/YYYY)
  const resolvido = resolverData(lower);
  if (resolvido) return resolvido;

  // 3. "dia X"
  const matchDia = lower.match(/dia\s+(\d{1,2})/);
  if (matchDia) {
    const d = parseInt(matchDia[1]);
    if (d >= 1 && d <= 31) {
      const hojeISO = dateParaISO(new Date());
      const [anoH, mesH, diaH] = hojeISO.split('-').map(Number);
      let mes = mesH;
      let ano = anoH;
      if (d < diaH) {
        mes += 1;
        if (mes > 12) { mes = 1; ano += 1; }
      }
      return `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  return null;
}

async function handleTransacaoPendenteResposta(usuarioId, texto, pendente) {
  const lower = texto.toLowerCase().trim();

  // Cancelar
  if (lower === 'cancelar' || lower === 'deixa' || lower === 'esquece' || lower === '0') {
    limparTransacaoPendente(usuarioId);
    return '❌ Cancelado! Não salvei nada.';
  }

  // Preencher campo que está faltando
  if (!pendente.valor) {
    // Aguardando valor
    const valor = await extrairValorRobusto(texto);
    if (!valor || valor <= 0) {
      return '❌ Não entendi o valor. Me diz só o número:\n\n_Ex: "150", "R$ 1.200,50", "50 reais"_\n\n_Ou manda "cancelar" pra desistir._';
    }
    pendente.valor = valor;

    // Verificar se a data também veio junto na mesma resposta
    const dataJunto = extrairDataDoTexto(texto);
    if (dataJunto && !pendente.data) {
      pendente.data = dataJunto;
    }
  } else if (!pendente.data) {
    // Aguardando data - também tentar extrair valor caso user mande tudo junto
    const dataExtraida = extrairDataDoTexto(texto);
    if (!dataExtraida) {
      return 'Não consegui entender a data 😅\n\nMe diz de um jeito mais direto:\n_Ex: "sexta-feira", "dia 20", "amanhã", "hoje"_\n\n_Ou manda "cancelar" pra desistir._';
    }
    pendente.data = dataExtraida;
  }

  // Verificar se ainda falta algo
  const proximo = perguntarProximoCampo(pendente);
  if (proximo) {
    salvarTransacaoPendente(usuarioId, pendente);
    return proximo.msg;
  }

  // Tudo completo! Salvar
  limparTransacaoPendente(usuarioId);
  return await salvarTransacao(usuarioId, pendente.tipo, pendente.valor, pendente.descricao, pendente.categoria, pendente.data, pendente.status || 'pendente');
}

async function handleMensagemIA(usuarioId, texto, enviarAck) {
  // Detectar reset ANTES da IA interpretar (para funcionar em áudio também)
  const lower = texto.toLowerCase().trim().replace(/[.,!?]+$/g, '');
  if (lower === 'resetar' || lower.includes('começar do zero') || lower.includes('comecar do zero') || lower === 'limpar tudo' || lower === 'zerar dados') {
    await db.limparDadosUsuario(usuarioId);
    limparPontoZero(usuarioId);
    setOnboardingState(usuarioId, 'aguardando_nome');
    if (enviarAck) await enviarAck(mensagemApresentacao()).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
    return mensagemPerguntaNome();
  }

  const resultado = await interpretarMensagem(texto);

  if (!resultado) {
    const saudacoes = ['oi', 'olá', 'ola', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'e aí', 'eai'];
    if (saudacoes.some(s => texto.toLowerCase().includes(s))) {
      return ajudaMsg();
    }
  }

  return await processarResultadoIA(usuarioId, resultado, null, texto, enviarAck);
}

async function handleImageMessage(usuarioId, base64Data, mimetype) {
  const resultado = await analisarImagem(base64Data, mimetype);

  if (!resultado) {
    return '❌ Não consegui analisar a imagem. Envie uma foto clara de um boleto, nota fiscal ou cupom.';
  }

  // Se não for transação (imagem não financeira), retorna resposta criativa do AI
  if (resultado.acao !== 'transacao') {
    return resultado.resposta || '😄 Não encontrei nenhum documento financeiro aí... Manda um boleto, nota fiscal, cupom ou recibo que eu registro na hora! 🧾';
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
  console.log(`[LEMBRETE] resultado da IA:`, JSON.stringify(resultado));
  const { minutos, horario, mensagem } = resultado;
  // Resolver data: converte nomes de dia da semana, referências relativas, etc. em YYYY-MM-DD
  const dataResolvida = resolverData(resultado.data);
  console.log(`[LEMBRETE] data da IA: "${resultado.data}" → resolvida: "${dataResolvida}"`);

  if (!mensagem) {
    return '❌ Não entendi o que devo lembrar. Tente algo como:\n\n_"me lembre daqui 10 minutos de pegar o Noah"_\n_"lembra às 15:00 da reunião"_';
  }

  let disparaEm;
  const agora = new Date();

  if (horario) {
    // Horário fixo (ex: "às 15:00")
    const [h, m] = horario.split(':').map(Number);

    if (dataResolvida) {
      // Data específica com horário (ex: "sexta-feira às 15:00")
      const [ano, mes, dia] = dataResolvida.split('-').map(Number);
      disparaEm = new Date(ano, mes - 1, dia, h, m, 0, 0);
    } else {
      disparaEm = new Date(agora);
      disparaEm.setHours(h, m, 0, 0);
      // Se o horário já passou hoje, agenda pra amanhã
      if (disparaEm <= agora) {
        disparaEm.setDate(disparaEm.getDate() + 1);
      }
    }
  } else if (minutos && minutos > 0) {
    // Daqui X minutos
    disparaEm = new Date(agora.getTime() + minutos * 60 * 1000);
  } else if (dataResolvida) {
    // Tem data mas SEM horário → perguntar que horas
    const [ano, mes, dia] = dataResolvida.split('-').map(Number);
    const dataObj = new Date(ano, mes - 1, dia);
    const dataFormatada = dataObj.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' });

    salvarLembretePendente(usuarioId, { mensagem, data: dataResolvida });
    return `🕐 *Que horas devo te lembrar disso?*\n\n📝 ${mensagem}\n📅 ${dataFormatada}\n\n_Me diz o horário (ex: "às 14 horas", "8 da manhã"...)_`;
  } else {
    return '❌ Não entendi quando devo te lembrar. Tente algo como:\n\n_"me lembre daqui 30 minutos"_\n_"me avisa às 14:00"_\n_"me lembra sexta-feira às 10h"_';
  }

  return await criarEConfirmarLembrete(usuarioId, mensagem, disparaEm, minutos, horario);
}

async function handleLembreteHorario(usuarioId, msg, pendente) {
  const texto = msg.trim().toLowerCase();

  // Cancelar
  if (texto === 'cancelar' || texto === '0') {
    lembretesPendentes.delete(usuarioId);
    return '❌ Lembrete cancelado.';
  }

  // Usar IA para extrair o horário do texto natural
  const horario = await extrairHorario(msg.trim());

  if (!horario) {
    return '❌ Não entendi o horário. Tente algo como:\n\n_"às 14 horas"_, _"8 da manhã"_, _"meio dia"_, _"15:30"_...\n\n_Digite *cancelar* para desistir._';
  }

  const [h, m] = horario.split(':').map(Number);
  const [ano, mes, dia] = pendente.data.split('-').map(Number);
  const disparaEm = new Date(ano, mes - 1, dia, h, m, 0, 0);

  lembretesPendentes.delete(usuarioId);
  return await criarEConfirmarLembrete(usuarioId, pendente.mensagem, disparaEm, 0, horario);
}

async function criarEConfirmarLembrete(usuarioId, mensagem, disparaEm, minutos, horario) {
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
    quando = `${disparaEm.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })} às ${horaStr}`;
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
      else if (l.frequencia === 'semanal') freq = `${NOMES_DIAS_SEMANA[l.dia_semana]}`;
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

const NOMES_DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

async function handleTransacaoRecorrente(usuarioId, resultado) {
  const { tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana } = resultado;

  if (!valor || valor <= 0) {
    return `❌ Preciso do valor para cadastrar a recorrência. Quanto é por ${frequencia === 'semanal' ? 'semana' : 'mês'}?`;
  }
  if (!descricao) {
    return '❌ Preciso saber o nome dessa despesa/receita recorrente.';
  }

  try {
    // 1. Criar regra de recorrência
    const diaM = frequencia === 'semanal' ? null : (dia_mes ?? null);
    const diaS = frequencia === 'semanal' ? (dia_semana ?? null) : null;
    const recorrenciaId = await db.criarRecorrencia(
      usuarioId, tipo || 'despesa', valor, descricao,
      categoria || 'Outros', frequencia || 'mensal',
      diaM, diaS, null, null
    );

    // 2. Criar transação pendente para a próxima ocorrência (para o sistema de lembretes)
    const dataStr = calcularDataPendente(dia_mes || null);
    await db.adicionarTransacaoComRecorrencia(
      usuarioId, tipo || 'despesa', valor, descricao,
      categoria || 'Outros', dataStr, 'pendente', recorrenciaId
    );

    const emoji = (tipo === 'despesa') ? '📉' : '📈';
    const tipoLabel = (tipo === 'despesa') ? 'Despesa' : 'Receita';
    let quando;
    if (frequencia === 'semanal') {
      if (dia_semana != null) {
        const nomesDias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
        quando = `toda ${nomesDias[dia_semana]}`;
      } else {
        quando = 'toda semana';
      }
    } else {
      quando = dia_mes ? `todo mês no dia *${dia_mes}*` : 'todo mês';
    }

    let msg = `${emoji} *${tipoLabel} recorrente cadastrada!*\n\n`;
    msg += `📋 *${descricao}* — ${fmt.formatarMoeda(valor)}\n`;
    msg += `📅 Recorrência: ${quando}\n`;
    if (categoria) msg += `🏷️ Categoria: ${categoria}\n`;
    msg += `\n✅ Já está na sua *agenda financeira* como pendente.\n`;
    msg += `_Te aviso todo mês para confirmar o pagamento!_`;

    return msg;
  } catch (err) {
    console.error('[TRANSACAO_RECORRENTE] Erro:', err.message);
    return '❌ Erro ao cadastrar a recorrência. Tente novamente!';
  }
}

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
    dataFim = dateParaISO(fim);
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
    freqTexto = `Toda ${NOMES_DIAS_SEMANA[dia]}`;
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

async function handleListarCaixinhas(usuarioId) {
  const caixinhas = await db.listarCaixinhas(usuarioId);
  if (caixinhas.length === 0) {
    return `🏦 Você ainda não tem caixinhas cadastradas.\n\n_Para criar, use "Finanças em Dia" ou diga "quero organizar minhas finanças"._`;
  }
  const total = caixinhas.reduce((s, c) => s + c.saldo, 0);
  let msg = `🏦 *Suas Caixinhas de Investimento:*\n\n`;
  for (const c of caixinhas) {
    msg += `💰 *${c.nome}*\n   Saldo: ${fmt.formatarMoeda(c.saldo)}`;
    if (c.meta) msg += ` | Meta: ${fmt.formatarMoeda(c.meta)}`;
    if (c.tipo) msg += `\n   Tipo: ${c.tipo}`;
    if (c.rendimento_mensal) msg += ` | Rendimento: ${c.rendimento_mensal}%/mês`;
    msg += '\n\n';
  }
  msg += `━━━━━━━━━━━━━━━\n💼 *Total investido: ${fmt.formatarMoeda(total)}*`;
  return msg;
}

async function handleUsoCartao(usuarioId, nomeCartao) {
  const cartoes = nomeCartao
    ? await db.buscarCartoesPorNome(usuarioId, nomeCartao)
    : await db.listarCartoes(usuarioId);

  if (cartoes.length === 0) {
    return `Não encontrei nenhum cartão cadastrado.\n_Cadastre com "novo cartão" ou pelo fluxo Finanças em Dia._`;
  }

  let msg = `💳 *Cartões de crédito:*\n\n`;
  for (const c of cartoes) {
    const { total, qtd, inicioStr } = await db.calcularUsoCartao(c.id, c.dia_fechamento);
    const limite = c.limite_total;
    const disponivel = limite ? limite - total : null;
    const pct = limite ? Math.round((total / limite) * 100) : null;
    const cor = pct !== null ? (pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢') : '🔵';

    msg += `*${c.nome}*`;
    if (c.dia_vencimento) msg += ` — vence dia ${c.dia_vencimento}`;
    msg += `\n`;
    msg += `  💸 Gasto no ciclo: *${fmt.formatarMoeda(total)}* (${qtd} compras)\n`;
    if (limite) msg += `  💳 Limite: ${fmt.formatarMoeda(limite)} ${cor} ${pct}% usado\n`;
    if (disponivel !== null) msg += `  ✅ Disponível: *${fmt.formatarMoeda(disponivel)}*\n`;
    msg += `  📅 Ciclo desde: ${inicioStr}\n\n`;
  }
  return msg.trim();
}

async function handleDepositoCaixinha(usuarioId, resultado) {
  const nome = resultado.nome || null;
  const valor = resultado.valor && resultado.valor > 0 ? resultado.valor : null;

  if (!valor) {
    return `Me diz o valor que quer adicionar e em qual caixinha 💰\n_Ex: "adicionar 500 na reserva de emergência"_`;
  }

  if (!nome) {
    const caixinhas = await db.listarCaixinhas(usuarioId);
    if (caixinhas.length === 0) {
      return `Você ainda não tem caixinhas cadastradas.\n_Diz "criar caixinha" pra começar!_`;
    }
    const lista = caixinhas.map(c => `  💰 *${c.nome}* — ${fmt.formatarMoeda(c.saldo)}`).join('\n');
    return `Em qual caixinha você quer depositar *${fmt.formatarMoeda(valor)}*?\n\n${lista}\n\n_Me diz o nome da caixinha._`;
  }

  const matches = await db.buscarCaixinhasPorNome(usuarioId, nome);

  if (matches.length === 0) {
    const caixinhas = await db.listarCaixinhas(usuarioId);
    const lista = caixinhas.length > 0
      ? caixinhas.map(c => `  💰 *${c.nome}*`).join('\n')
      : '  _Nenhuma caixinha cadastrada_';
    return `Não encontrei caixinha com o nome *"${nome}"* 😅\n\nSuas caixinhas:\n${lista}\n\n_Tenta de novo com o nome correto._`;
  }

  if (matches.length > 1) {
    const lista = matches.map(c => `  💰 *${c.nome}* — ${fmt.formatarMoeda(c.saldo)}`).join('\n');
    return `Encontrei ${matches.length} caixinhas com esse nome. Qual você quer abastecer?\n\n${lista}\n\n_Me diz o nome completo._`;
  }

  const caixinha = matches[0];
  const saldoAnterior = caixinha.saldo;
  const atualizada = await db.adicionarSaldoCaixinha(caixinha.id, valor);
  const novoSaldo = atualizada.saldo;

  // Registrar o aporte como despesa na conta corrente (dinheiro saiu da conta para o investimento)
  const hojeISO = dateParaISO(new Date());
  await db.adicionarTransacao(usuarioId, 'despesa', valor, `Aporte - ${atualizada.nome}`, 'Investimentos', hojeISO, 'pago');

  let msg = `✅ *${fmt.formatarMoeda(valor)}* adicionado à *${atualizada.nome}*! 💰\n\n`;
  msg += `  Saldo anterior: ${fmt.formatarMoeda(saldoAnterior)}\n`;
  msg += `  Novo saldo: *${fmt.formatarMoeda(novoSaldo)}*`;
  if (atualizada.meta && atualizada.meta > 0) {
    const pct = Math.min(100, Math.round((novoSaldo / atualizada.meta) * 100));
    msg += `\n  Meta: ${fmt.formatarMoeda(atualizada.meta)} — *${pct}% atingido* ${pct >= 100 ? '🎉' : pct >= 75 ? '🔥' : '📈'}`;
  }
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
    else if (l.frequencia === 'semanal') freq = `${NOMES_DIAS_SEMANA[l.dia_semana]}`;
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

async function handleConsulta(usuarioId, consulta, textoOriginal = '') {
  let dataInicioNormalizada = normalizarDataConsulta(consulta.dataInicio, 'dataInicio', consulta.pergunta);
  let dataFimNormalizada = normalizarDataConsulta(consulta.dataFim, 'dataFim', consulta.pergunta);

  const periodoNoTexto = extrairPeriodoNaturalNoTexto(textoOriginal);
  if (periodoNoTexto) {
    if (!dataInicioNormalizada) dataInicioNormalizada = periodoNoTexto.dataInicio;
    if (!dataFimNormalizada) dataFimNormalizada = periodoNoTexto.dataFim;
  }

  const dataNoTexto = extrairDataEspecificaNoTexto(textoOriginal);
  if (dataNoTexto) {
    if (!dataInicioNormalizada) dataInicioNormalizada = dataNoTexto;
    if (!dataFimNormalizada) dataFimNormalizada = dataNoTexto;
  }

  if (textoIndicaDataUnica(textoOriginal)) {
    if (dataInicioNormalizada && !dataFimNormalizada) dataFimNormalizada = dataInicioNormalizada;
    if (!dataInicioNormalizada && dataFimNormalizada) dataInicioNormalizada = dataFimNormalizada;
  }

  if (consulta.dataInicio && !dataInicioNormalizada) {
    return 'Nao consegui entender a data inicial da consulta. Tente novamente com um periodo mais claro, como "hoje", "amanha" ou "10/03/2026".';
  }

  if (consulta.dataFim && !dataFimNormalizada) {
    return 'Nao consegui entender a data final da consulta. Tente novamente com um periodo mais claro, como "hoje", "amanha" ou "10/03/2026".';
  }

  let dataInicioFinal = dataInicioNormalizada;
  let dataFimFinal = dataFimNormalizada;
  if (dataInicioFinal && dataFimFinal && dataInicioFinal > dataFimFinal) {
    const tmp = dataInicioFinal;
    dataInicioFinal = dataFimFinal;
    dataFimFinal = tmp;
  }

  const filtros = {
    tipo: consulta.tipo || null,
    categoria: consulta.categoria || null,
    dataInicio: dataInicioFinal || null,
    dataFim: dataFimFinal || null,
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

async function handleLocationMessage(usuarioId, location) {
  const { latitude, longitude } = location;
  salvarLocalizacao(usuarioId, latitude, longitude);
  return `📍 *Localização recebida!*\n\nAgora me diz o que tu quer encontrar por perto.\n\n_Ex: "restaurantes", "farmácias", "postos de gasolina", "mercados"..._`;
}

async function handleBuscaLocal(usuarioId, resultado) {
  const { query, pergunta } = resultado;

  if (!query) {
    return 'Não entendi o que tu quer buscar por perto. Tenta reformular? 🤔';
  }

  if (!process.env.SERPER_API_KEY) {
    return '🔍 A busca local está desabilitada no momento.\n\n_O administrador precisa configurar a SERPER_API_KEY._';
  }

  const loc = obterLocalizacao(usuarioId);

  if (!loc) {
    return `📍 Para encontrar *${pergunta || query}* pertinho de você, preciso da sua localização!\n\nClica no 📎 (clipe) → *Localização* → *Enviar localização atual*\n\n_Depois é só me pedir de novo!_`;
  }

  console.log(`[BUSCA LOCAL] "${query}" em lat=${loc.lat}, lng=${loc.lng}`);
  const resultados = await pesquisarLocal(query, loc.lat, loc.lng, 15);

  if (!resultados || resultados.length === 0) {
    return `Não encontrei resultados pra "${pergunta || query}" perto de você 😕\n\nTenta ser mais específico ou buscar outra coisa.`;
  }

  console.log(`[BUSCA LOCAL] ${resultados.length} resultados encontrados, formatando...`);

  let msg = `📍 *${pergunta || query}* perto de você:\n\n`;

  for (let i = 0; i < resultados.length; i++) {
    const r = resultados[i];
    msg += `*${i + 1}. ${r.titulo}*\n`;
    if (r.avaliacao) msg += `⭐ ${r.avaliacao}  `;
    if (r.endereco) msg += `📍 ${r.endereco}`;
    if (r.avaliacao || r.endereco) msg += '\n';
    if (r.telefone) msg += `📞 ${r.telefone}\n`;
    if (r.site) msg += `🌐 ${r.site}\n`;
    if (r.distancia) msg += `📏 ${r.distancia}\n`;
    if (r.descricao) {
      const desc = r.descricao.length > 120 ? r.descricao.substring(0, 120) + '...' : r.descricao;
      msg += `${desc}\n`;
    }
    msg += `🗺️ Abrir no Maps: ${r.mapsLink}\n\n`;
  }

  msg += '_📍 Sua localização fica salva por 30 min. Pode pedir mais buscas!_';
  return msg;
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
    case 'proxima_semana': {
      // Segunda a domingo da semana seguinte
      const diffSegProx = dow === 0 ? 1 : 8 - dow;
      dataInicio = new Date(ano, mes, dia + diffSegProx);
      dataFim = new Date(dataInicio);
      dataFim.setDate(dataFim.getDate() + 6);
      titulo = `semana que vem (${dataInicio.toLocaleDateString('pt-BR')} a ${dataFim.toLocaleDateString('pt-BR')})`;
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
    case 'proximo_mes': {
      dataInicio = new Date(ano, mes + 1, 1);
      dataFim = new Date(ano, mes + 2, 0);
      const nomesMesProx = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
      titulo = `${nomesMesProx[dataInicio.getMonth()]} de ${dataInicio.getFullYear()}`;
      break;
    }
    default: {
      // Verificar se é nome de mês (janeiro, fevereiro, marco, abril...)
      const MESES_NOME = { janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };
      const periodoNorm = normalizarTextoBusca(periodo);
      if (MESES_NOME[periodoNorm] !== undefined) {
        const mesAlvo = MESES_NOME[periodoNorm];
        const anoAlvo = mesAlvo < mes ? ano + 1 : ano; // se já passou, vai pro próximo ano
        dataInicio = new Date(anoAlvo, mesAlvo, 1);
        dataFim = new Date(anoAlvo, mesAlvo + 1, 0);
        const nomesMesNorm = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
        titulo = `${nomesMesNorm[mesAlvo]} de ${anoAlvo}`;
        break;
      }
      // Tentar resolver como dia da semana ou data específica
      const dataResolvida = resolverData(periodo);
      if (dataResolvida) {
        const [a, m, d] = dataResolvida.split('-').map(Number);
        dataInicio = new Date(a, m - 1, d);
        dataFim = new Date(a, m - 1, d);
        titulo = `${dataInicio.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' })}`;
      } else {
        dataInicio = new Date(ano, mes, dia);
        dataFim = new Date(ano, mes, dia);
        titulo = `hoje (${dataInicio.toLocaleDateString('pt-BR')})`;
      }
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

// Parseia mensagem de lembrete oculto (sistema) para extrair tipo/descricao/valor
function parsearLembreteOculto(mensagem) {
  const pagMatch = mensagem.match(/💸 Pagar: (.+?) - R\$ ([\d.,]+)/);
  if (pagMatch) {
    const valor = parseFloat(pagMatch[2].replace(/\./g, '').replace(',', '.'));
    return { tipo: 'despesa', descricao: pagMatch[1], valor };
  }
  const recMatch = mensagem.match(/💰 Receber: (.+?) - R\$ ([\d.,]+)/);
  if (recMatch) {
    const valor = parseFloat(recMatch[2].replace(/\./g, '').replace(',', '.'));
    return { tipo: 'receita', descricao: recMatch[1], valor };
  }
  const fatMatch = mensagem.match(/💳 Vencimento fatura (.+?) - R\$ ([\d.,]+)/);
  if (fatMatch) {
    const valor = parseFloat(fatMatch[2].replace(/\./g, '').replace(',', '.'));
    return { tipo: 'despesa', descricao: `Fatura ${fatMatch[1]}`, valor };
  }
  return null;
}

async function handleAgenda(usuarioId, periodo) {
  const { dataInicio, dataFim, titulo, dataInicioObj, dataFimObj } = calcularPeriodo(periodo);

  // Buscar tudo em paralelo
  const [transacoes, lembretes, recorrentes, regras] = await Promise.all([
    db.consultarTransacoes(usuarioId, { dataInicio, dataFim, limite: 50 }),
    db.buscarLembretesGeraisPorPeriodo(usuarioId, dataInicio, dataFim),
    db.listarLembretesRecorrentes(usuarioId),
    db.listarRecorrencias(usuarioId),
  ]);

  // Lembretes recorrentes do usuário que disparam no período
  const recorrentesDoPeriodo = recorrentes.filter(r => recorrenteDisparaNoPerodo(r, dataInicioObj, dataFimObj));

  // Calcular projeções de recorrências para o período
  const ocorrencias = db.calcularOcorrenciasNoPerodo(regras, dataInicioObj, dataFimObj);

  // Overlay: remover ocorrências que já têm transação real (pelo recorrencia_id)
  const idsComTransacao = new Set(transacoes.filter(t => t.recorrencia_id != null).map(t => t.recorrencia_id));
  const ocorrenciasSemCobertura = ocorrencias.filter(o => !idsComTransacao.has(o.recorrencia_id));

  // Montar listas finais: transações reais + projeções sem cobertura
  const receitasReais   = transacoes.filter(t => t.tipo === 'receita');
  const despesasReais   = transacoes.filter(t => t.tipo === 'despesa');
  const receitasProjetadas = ocorrenciasSemCobertura.filter(o => o.tipo === 'receita');
  const despesasProjetadas = ocorrenciasSemCobertura.filter(o => o.tipo === 'despesa');

  const receitas = [...receitasReais, ...receitasProjetadas];
  const despesas = [...despesasReais, ...despesasProjetadas];
  const temProjecao = receitasProjetadas.length > 0 || despesasProjetadas.length > 0;

  const temAlgo = receitas.length > 0 || despesas.length > 0 || lembretes.length > 0 || recorrentesDoPeriodo.length > 0;

  if (!temAlgo) {
    return `📅 *Sua agenda para ${titulo}*\n\nVocê não tem nada agendado para esse período! 😎\n\n_Dica: registre despesas, receitas ou crie lembretes para organizar seu dia._`;
  }

  const notaProjecao = temProjecao ? `\n_🔄 = previsto com base nas suas contas fixas_\n` : '';
  let msg = `📅 *Sua agenda para ${titulo}*${notaProjecao}\n\n`;

  // Receitas do período
  if (receitas.length > 0) {
    const totalReceitas = receitas.reduce((acc, t) => acc + t.valor, 0);
    const labelR = receitasReais.length === 0 && receitasProjetadas.length > 0
      ? `Receitas previstas (${fmt.formatarMoeda(totalReceitas)})`
      : `Receitas (${fmt.formatarMoeda(totalReceitas)})`;
    msg += `💰 *${labelR}:*\n`;
    for (const t of receitas) {
      const statusIcon = t.status === 'projetado' ? ' 🔄' : t.status === 'pendente' ? ' ⏳' : ' ✅';
      const cat = t.categoria ? ` (${t.categoria})` : '';
      msg += `  🟢 ${fmt.formatarMoeda(t.valor)} - _${t.descricao}_${cat}${statusIcon}\n`;
    }
    msg += '\n';
  }

  // Despesas do período
  if (despesas.length > 0) {
    const totalDespesas = despesas.reduce((acc, t) => acc + t.valor, 0);
    const labelD = despesasReais.length === 0 && despesasProjetadas.length > 0
      ? `Despesas previstas (${fmt.formatarMoeda(totalDespesas)})`
      : `Despesas (${fmt.formatarMoeda(totalDespesas)})`;
    msg += `💸 *${labelD}:*\n`;
    for (const t of despesas) {
      const statusIcon = t.status === 'projetado' ? ' 🔄' : t.status === 'pendente' ? ' ⏳' : ' ✅';
      const cat = t.categoria ? ` (${t.categoria})` : '';
      msg += `  🔴 ${fmt.formatarMoeda(t.valor)} - _${t.descricao}_${cat}${statusIcon}\n`;
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

  // Lembretes recorrentes do usuário (não financeiros)
  if (recorrentesDoPeriodo.length > 0) {
    msg += `🔄 *Lembretes recorrentes:*\n`;
    for (const r of recorrentesDoPeriodo) {
      let freq;
      if (r.frequencia === 'diario') freq = 'todo dia';
      else if (r.frequencia === 'semanal') freq = `${NOMES_DIAS_SEMANA[r.dia_semana]}`;
      else freq = `dia ${r.dia_mes}/mês`;
      msg += `  🔔 ${r.horario} - ${r.mensagem} _(${freq})_\n`;
    }
    msg += '\n';
  }

  // Saldo do período
  if (receitas.length > 0 || despesas.length > 0) {
    const totalReceitas = receitas.reduce((acc, t) => acc + t.valor, 0);
    const totalDespesas = despesas.reduce((acc, t) => acc + t.valor, 0);
    const saldo = totalReceitas - totalDespesas;
    const emojiSaldo = saldo >= 0 ? '✅' : '🚨';
    msg += `━━━━━━━━━━━━━━━\n`;
    msg += `${emojiSaldo} *Saldo do período: ${fmt.formatarMoeda(saldo)}*`;
    if (saldo < 0) msg += ` _(despesas superam receitas)_`;
  }

  return msg;
}

// ==================== FINANÇAS EM DIA ====================

function gerarOrcamentoProporcional(estado) {
  const totalReceitas = [
    ...(estado.receitasFixas || []),
    ...(estado.receitasVariaveis || []),
  ].reduce((s, r) => s + r.valor, 0);
  const totalFixas = (estado.despesasFixas || []).reduce((s, d) => s + d.valor, 0);
  const limiteFixas = totalReceitas * 0.50;
  const alertaFixas = totalFixas > limiteFixas;
  const orcamentos = [
    { descricao: 'Variáveis',     valor: Math.round(totalReceitas * 0.20), categoria: 'Variáveis' },
    { descricao: 'Lazer',         valor: Math.round(totalReceitas * 0.10), categoria: 'Lazer' },
    { descricao: 'Investimentos', valor: Math.round(totalReceitas * 0.15), categoria: 'Investimentos' },
    { descricao: 'Objetivos',     valor: Math.round(totalReceitas * 0.05), categoria: 'Objetivos' },
  ];
  return { totalReceitas, totalFixas, limiteFixas, alertaFixas, orcamentos };
}

async function iniciarPontoZero(usuarioId) {
  salvarPontoZero(usuarioId, {
    etapa: 'saldo',
    saldoInicial: 0,
    receitasFixas: [],
    receitasVariaveis: [],
    despesasFixas: [],
    investimentos: [],
    cartoes: [],
    orcamentos: [],
  });

  return `E aí! 😄 Bora deixar tudo em dia?\n\nEm poucos minutos organizo teu financeiro completo.\n\nPrimeiro: *quanto tu tem disponível hoje em conta corrente, carteira e pix?*\n\n⚠️ _Não inclua investimentos (poupança, CDB, etc.) — eles serão registrados em seguida como caixinhas._\n\n_Ex: "R$ 1.850" ou "tenho uns 2 mil"_\n\n_A qualquer momento digite *cancelar* para sair._`;
}

function coletarItens(item, lista, etapa) {
  if (item.tipo === 'itens' && item.itens && item.itens.length > 0) {
    let msg = '';
    const incompletos = [];
    for (const it of item.itens) {
      const campo = proximoCampoFaltante(it, etapa);
      if (campo) {
        incompletos.push({
          descricao: it.descricao,
          valor: it.valor || null,
          dia: it.dia || null,
          categoria: it.categoria || null,
          esperandoCampo: campo,
        });
      } else {
        lista.push({ valor: it.valor, descricao: it.descricao, dia: it.dia, categoria: it.categoria });
        msg += `✅ *${it.descricao}* - ${fmt.formatarMoeda(it.valor)}${it.dia ? ` (dia ${it.dia})` : ''}\n`;
      }
    }
    return { ok: true, msg, quantidade: item.itens.length - incompletos.length, incompletos };
  }
  if (item.tipo === 'item' && item.valor) {
    lista.push({ valor: item.valor, descricao: item.descricao, dia: item.dia, categoria: item.categoria });
    const msg = `✅ *${item.descricao}* - ${fmt.formatarMoeda(item.valor)}${item.dia ? ` (dia ${item.dia})` : ''}`;
    return { ok: true, msg, quantidade: 1, incompletos: [] };
  }
  return { ok: false };
}

// Mapeia a descrição do orçamento para uma categoria do sistema
function mapearCategoriaOrcamento(descricao) {
  const d = (descricao || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/mercado|supermercado|feira|aliment|comida|refeicao|padaria/.test(d)) return 'Alimentacao';
  if (/gasolina|combustivel|uber|99|taxi|onibus|metro|transporte|pedagio/.test(d)) return 'Transporte';
  if (/farmacia|medico|saude|remedio|plano|consulta|academia/.test(d)) return 'Saude';
  if (/lazer|cinema|restaurante|bar|diversao|entretenimento|viagem|passeio/.test(d)) return 'Lazer';
  if (/escola|faculdade|curso|educacao|livro/.test(d)) return 'Educacao';
  if (/roupa|vestuario|shopping|calcado/.test(d)) return 'Outros';
  if (/pet|animal|veterinario/.test(d)) return 'Outros';
  return 'Outros';
}

// Extrai número de dia (1-31) de um texto como "dia 10", "10", "dia cinco"
function extrairDiaDoTexto(texto) {
  const t = texto.toLowerCase().replace(/\s+/g, ' ').trim();
  // "dia 10" ou "dia cinco"
  const matchDia = t.match(/\bdia\s+(\d{1,2})\b/);
  if (matchDia) {
    const d = parseInt(matchDia[1]);
    if (d >= 1 && d <= 31) return d;
  }
  // Número isolado (ex: resposta "5" ou "10")
  const matchNum = t.match(/^(\d{1,2})$/);
  if (matchNum) {
    const d = parseInt(matchNum[1]);
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

// Retorna o próximo campo obrigatório faltante para o item parcial
function proximoCampoFaltante(itemParcial, etapa) {
  if (!itemParcial.descricao) return 'descricao';
  if (!itemParcial.valor) return 'valor';
  // Dia é obrigatório apenas para fixas (receitas e despesas); variáveis não exigem dia
  const diaObrigatorio = etapa === 'receitas_fixas' || etapa === 'despesas_fixas';
  if (diaObrigatorio && !itemParcial.dia) return 'dia';
  return null;
}

// Gera a pergunta para o campo faltante
function perguntarCampoFaltante(campo, descricao) {
  const nome = descricao ? `*${descricao}*` : 'esse item';
  switch (campo) {
    case 'descricao': return `Qual o nome desse item? Me diz como quer chamar.\n_Ex: "Aluguel", "Salário", "Internet"_`;
    case 'valor':     return `Qual o valor de ${nome}? 💰\n_Ex: "R$ 1.500" ou só "1500"_`;
    case 'dia':       return `Em que dia do mês ${nome} vence (ou entra)? 📅\n_Ex: "dia 5" ou só "5"_`;
    default:          return null;
  }
}

// Coleta o campo faltante de um item parcial salvo no estado
async function handleItemParcialPontoZero(usuarioId, texto, estado) {
  const ip = estado.itemParcial;
  const campo = ip.esperandoCampo;

  if (campo === 'valor') {
    const valor = await extrairValorRobusto(texto);
    if (!valor || valor <= 0) {
      return `Não entendi o valor 😅 Me diz quanto é ${ip.descricao ? `o *${ip.descricao}*` : 'esse item'}.\n_Ex: "R$ 500" ou "500"_`;
    }
    ip.valor = valor;
  } else if (campo === 'dia') {
    const dia = extrairDiaDoTexto(texto);
    if (!dia) {
      return `Não entendi o dia 😅 Me diz em que dia do mês (número de 1 a 31).\n_Ex: "dia 5" ou só "5"_`;
    }
    ip.dia = dia;
  } else if (campo === 'descricao') {
    const desc = texto.trim();
    if (!desc || desc.length < 2) {
      return `Não entendi 😅 Me diz o nome desse item.\n_Ex: "Aluguel", "Salário", "Internet"_`;
    }
    ip.descricao = desc;
  }

  // Verifica se ainda falta algum campo
  const proximo = proximoCampoFaltante(ip, estado.etapa);
  if (proximo) {
    ip.esperandoCampo = proximo;
    salvarPontoZero(usuarioId, estado);
    return perguntarCampoFaltante(proximo, ip.descricao);
  }

  // Item completo — adiciona à lista correta
  delete estado.itemParcial;
  const lista =
    estado.etapa === 'receitas_fixas'     ? estado.receitasFixas    :
    estado.etapa === 'receitas_variaveis' ? estado.receitasVariaveis :
                                           estado.despesasFixas;
  lista.push({ valor: ip.valor, descricao: ip.descricao, dia: ip.dia, categoria: ip.categoria });
  const confirmacao = `✅ *${ip.descricao}* — ${fmt.formatarMoeda(ip.valor)}${ip.dia ? ` (dia ${ip.dia})` : ''}`;

  // Se há mais itens incompletos na fila, perguntar o próximo
  if (estado.itensPendentes && estado.itensPendentes.length > 0) {
    const [proximo, ...resto] = estado.itensPendentes;
    estado.itemParcial = { ...proximo };
    if (resto.length > 0) estado.itensPendentes = resto;
    else delete estado.itensPendentes;
    salvarPontoZero(usuarioId, estado);
    return `${confirmacao}\n\nAinda faltou uma info em *${proximo.descricao}* 👇\n\n${perguntarCampoFaltante(proximo.esperandoCampo, proximo.descricao)}`;
  }

  delete estado.itensPendentes;
  salvarPontoZero(usuarioId, estado);

  const nomeEtapa =
    estado.etapa === 'receitas_fixas'     ? 'receita fixa'     :
    estado.etapa === 'receitas_variaveis' ? 'receita variável' :
                                           'despesa';
  return `${confirmacao}\n\nTem mais alguma ${nomeEtapa} ou pode passar pra frente?`;
}

async function handleCartaoCadastro(usuarioId, texto, estado) {
  const cc = estado.cartaoEmCadastro;
  const lower = texto.toLowerCase().trim();

  // Cancelar o cartão em andamento sem cancelar o fluxo inteiro
  if (lower === 'pular' || lower === 'nao' || lower === 'não' || lower === 'n') {
    delete estado.cartaoEmCadastro;
    salvarPontoZero(usuarioId, estado);
    return `Ok, pulei esse cartão.\n\nTem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
  }

  switch (cc.campo) {

    case 'limiteTotal': {
      const valor = await extrairValorRobusto(texto);
      if (!valor || valor <= 0) {
        return `Não entendi o valor 😅 Qual o limite total do *${cc.nome}*?\n_Ex: "R$ 5.000" ou "5000"_`;
      }
      cc.limiteTotal = valor;
      cc.campo = 'diaFechamento';
      salvarPontoZero(usuarioId, estado);
      return `Qual o *dia de fechamento* da fatura do *${cc.nome}*? 📅\n_Ex: "dia 15" ou só "15"_`;
    }

    case 'diaFechamento': {
      const dia = extrairDiaDoTexto(texto);
      if (!dia) {
        return `Não entendi 😅 Em que dia fecha a fatura do *${cc.nome}*? (número de 1 a 31)\n_Ex: "dia 15" ou só "15"_`;
      }
      cc.diaFechamento = dia;
      cc.campo = 'diaVencimento';
      salvarPontoZero(usuarioId, estado);
      return `E o *dia de vencimento* (pagamento) da fatura? 📅\n_Ex: "dia 22" ou só "22"_`;
    }

    case 'diaVencimento': {
      const dia = extrairDiaDoTexto(texto);
      if (!dia) {
        return `Não entendi 😅 Em que dia vence a fatura do *${cc.nome}*? (número de 1 a 31)\n_Ex: "dia 22" ou só "22"_`;
      }
      cc.diaVencimento = dia;
      cc.campo = 'valorFatura';
      salvarPontoZero(usuarioId, estado);
      return `Qual o *valor médio da fatura* do *${cc.nome}*? 💰\n(Ou o valor atual se souber — manda "0" se não sabe)\n_Ex: "R$ 1.200" ou "1200"_`;
    }

    case 'valorFatura': {
      let valorFatura = 0;
      if (lower !== '0' && lower !== 'zero' && lower !== 'nao sei' && lower !== 'não sei') {
        const valor = await extrairValorRobusto(texto);
        if (valor === null) {
          return `Não entendi o valor 😅 Qual o valor médio da fatura do *${cc.nome}*?\n_Ex: "R$ 1.200" — ou manda "0" se não sabe._`;
        }
        valorFatura = valor;
      }
      cc.valorFatura = valorFatura;
      estado.cartoes.push({ nome: cc.nome, limiteTotal: cc.limiteTotal, diaFechamento: cc.diaFechamento, diaVencimento: cc.diaVencimento, valorFatura });
      delete estado.cartaoEmCadastro;
      salvarPontoZero(usuarioId, estado);

      const faturaStr = valorFatura > 0 ? fmt.formatarMoeda(valorFatura) : 'valor não informado';
      return `✅ *${cc.nome}* cadastrado!\n` +
        `  Limite: ${fmt.formatarMoeda(cc.limiteTotal)}\n` +
        `  Fecha dia ${cc.diaFechamento} · Vence dia ${cc.diaVencimento}\n` +
        `  Fatura: ~${faturaStr}/mês\n\n` +
        `Tem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
    }

    default:
      delete estado.cartaoEmCadastro;
      salvarPontoZero(usuarioId, estado);
      return `Algo deu errado no cadastro do cartão 😅 Tente novamente.`;
  }
}

async function handleInvestimentoCadastro(usuarioId, texto, estado) {
  const inv = estado.investimentoEmCadastro;
  const lower = texto.toLowerCase().trim();
  const isPular = lower === 'pular' || lower === 'nao' || lower === 'não' || lower === 'n' || lower === '-';

  switch (inv.campo) {

    case 'saldo': {
      const valor = await extrairValorRobusto(texto);
      if (!valor || valor <= 0) {
        return `Não entendi o valor 😅 Quanto você tem guardado na *${inv.nome}*?\n_Ex: "R$ 5.000" ou "5000"_`;
      }
      inv.saldo = valor;
      inv.campo = 'meta';
      salvarPontoZero(usuarioId, estado);
      return `Qual a *meta* para essa caixinha? 🎯\n_Ex: "R$ 20.000" — ou manda "pular" se não tem meta definida._`;
    }

    case 'meta': {
      inv.meta = isPular ? null : ((await extrairValorRobusto(texto)) || null);
      inv.campo = 'tipo';
      salvarPontoZero(usuarioId, estado);
      return `Que *tipo* de investimento é essa caixinha?\n_Ex: "Renda fixa", "Ações", "Emergência", "Viagem"... ou "pular"._`;
    }

    case 'tipo': {
      inv.tipo = isPular ? null : texto.trim();
      inv.campo = 'rendimento';
      salvarPontoZero(usuarioId, estado);
      return `Qual o *rendimento mensal estimado* (% ao mês)? 📈\n_Ex: "1%" ou "0.8" — ou "pular" se não sabe._`;
    }

    case 'rendimento': {
      let rendimento = null;
      if (!isPular) {
        const val = await extrairValorRobusto(texto);
        if (val !== null) rendimento = val;
      }
      estado.investimentos.push({
        nome: inv.nome,
        saldo: inv.saldo,
        meta: inv.meta,
        tipo: inv.tipo,
        rendimento,
      });
      delete estado.investimentoEmCadastro;
      salvarPontoZero(usuarioId, estado);

      let detalhes = `  Saldo: ${fmt.formatarMoeda(inv.saldo)}`;
      if (inv.meta) detalhes += ` | Meta: ${fmt.formatarMoeda(inv.meta)}`;
      if (inv.tipo) detalhes += `\n  Tipo: ${inv.tipo}`;
      if (rendimento !== null) detalhes += ` | Rendimento: ${rendimento}%/mês`;

      return `✅ *${inv.nome}* cadastrada!\n${detalhes}\n\nTem mais alguma reserva ou investimento?\n_Manda o nome ou "não" pra avançar._`;
    }

    default:
      delete estado.investimentoEmCadastro;
      salvarPontoZero(usuarioId, estado);
      return `Algo deu errado no cadastro da caixinha 😅 Tente novamente.`;
  }
}

function perguntaAtualEtapa(etapa) {
  const perguntas = {
    saldo: 'Me diz o valor aproximado que tu tem disponível hoje.\n_Ex: "R$ 1.850" ou "uns 2 mil"_',
    receitas_fixas: 'Me diz suas receitas fixas (salário, benefício...).\n_Ex: "Salário dia 5 R$ 3.000"_\n_Ou manda "não" se não tem._',
    receitas_variaveis: 'Tem receitas variáveis? (freelas, bicos, comissões)\n_Ex: "Freela R$ 500 dia 20"_\n_Ou manda "não"._',
    despesas_fixas: 'Me diz suas despesas fixas (aluguel, internet, luz...).\n_Ex: "Aluguel dia 5 R$ 1.500"_\n_Ou manda "não"._',
    investimentos: 'Me diz o nome da sua primeira caixinha de investimento.\n_Ex: "Poupança", "CDB Nubank"_\n_Ou manda "não"._',
    cartoes: 'Tem cartão de crédito? Me diz o nome.\n_Ex: "Nubank", "Inter"_\n_Ou manda "não"._',
    despesas_dia_a_dia: 'Me diz os gastos do mês atual.\n_Ex: "mercado R$ 350, uber R$ 80"_\n_Ou manda "não"._',
  };
  return perguntas[etapa] || 'Me manda a informação que estou esperando 😊';
}

async function redireccionarPontoZero(usuarioId, texto, etapa) {
  const etapaLabel = {
    saldo: 'saldo atual', receitas_fixas: 'receitas fixas', receitas_variaveis: 'receitas variáveis',
    despesas_fixas: 'despesas fixas', investimentos: 'investimentos/caixinhas',
    cartoes: 'cartões de crédito', despesas_dia_a_dia: 'gastos do mês',
  };
  const prompt = (
    `O usuário está no assistente financeiro Cronos, na etapa de cadastro de "${etapaLabel[etapa] || etapa}". ` +
    `Em vez de responder o que foi pedido, ele mandou: "${texto}". ` +
    `Faça uma piada curtíssima (1 frase) com toque financeiro se der. ` +
    `Responda em português brasileiro, sem exagerar nos emojis.`
  );
  const piada = await responderAssistente(prompt).catch(() => null);
  const pergunta = perguntaAtualEtapa(etapa);
  return piada
    ? `${piada}\n\nMas voltando ao que importa 😄\n\n${pergunta}`
    : `Não entendi 😅\n\n${pergunta}`;
}

async function handlePontoZero(usuarioId, texto, estado) {
  const lower = texto.toLowerCase().trim();

  if (lower === 'cancelar' || lower === 'sair' || lower === 'parar') {
    limparPontoZero(usuarioId);
    return '❌ Cancelado. Sem problemas! Quando quiser recomeçar é só me falar *"finanças em dia"*.';
  }

  // Se há um item parcial aguardando campos faltantes, continua a coleta
  if (estado.itemParcial) {
    return await handleItemParcialPontoZero(usuarioId, texto, estado);
  }

  // Se está no meio do cadastro de uma caixinha, continua a coleta (sem chamar IA)
  if (estado.investimentoEmCadastro) {
    return await handleInvestimentoCadastro(usuarioId, texto, estado);
  }

  // Se está no meio do cadastro de um cartão, continua a coleta (sem chamar IA)
  if (estado.cartaoEmCadastro) {
    return await handleCartaoCadastro(usuarioId, texto, estado);
  }

  const item = await interpretarItemFinanceiro(texto);

  // Detecta qualquer variante de "quero avançar para o próximo passo"
  const querAvancar = /\b(n[aã]o( tem| tenho)?|nenhum[a]?|pra frente|pode passar|pode avan[çc]ar|pode pular|pode ir|pode continuar|pr[oó]xim[oa]|avan[çc]a(r)?|avan[çc]ar pra|pronto( isso)?|feito|mais nada|nada mais|s[oó] isso|s[oó] essa|pul[ao](r)?|skip|suficiente|chega( por)? (aí|ai))\b/.test(lower);

  switch (estado.etapa) {

    case 'saldo': {
      if (item.tipo !== 'item' || !item.valor) {
        return await redireccionarPontoZero(usuarioId, texto, 'saldo');
      }
      estado.saldoInicial = item.valor;
      estado.etapa = 'receitas_fixas';
      salvarPontoZero(usuarioId, estado);
      return `Perfeito ✅ Saldo atual: *${fmt.formatarMoeda(item.valor)}*\n\n📈 Agora me diz suas *receitas fixas* do mês — aquilo que entra todo mês no mesmo dia (salário, benefício, aluguel recebido...).\n\nPode mandar tudo de uma vez!\n_Ex: "Salário dia 5 R$ 3.000 e aluguel dia 10 R$ 800"_\n\n_Se não tem, manda "não"._`;
    }

    case 'receitas_fixas': {
      if (item.tipo === 'nao' || (querAvancar && estado.receitasFixas.length > 0)) {
        estado.etapa = 'receitas_variaveis';
        salvarPontoZero(usuarioId, estado);
        return `Beleza! E *receitas variáveis*? (freelas, bicos, vendas, comissões — o que entra mas não é todo mês igual)\n\n_Ex: "Freela dia 20 R$ 500 e venda R$ 200"_\n_Se não tem, manda "não"._`;
      }
      const res = coletarItens(item, estado.receitasFixas, estado.etapa);
      if (res.ok) {
        if (res.incompletos && res.incompletos.length > 0) {
          const [primeiro, ...restante] = res.incompletos;
          estado.itemParcial = { ...primeiro };
          if (restante.length > 0) estado.itensPendentes = restante;
          else delete estado.itensPendentes;
          salvarPontoZero(usuarioId, estado);
          const confirmacaoValidos = res.msg ? `Anotei:\n\n${res.msg}\n` : '';
          return `${confirmacaoValidos}Mas precisei da sua ajuda 👇\n\n${perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao)}`;
        }
        salvarPontoZero(usuarioId, estado);
        const mais = res.quantidade > 1 ? `${res.quantidade} receitas fixas anotadas` : `Anotado`;
        return `${mais}:\n\n${res.msg}\nTem mais alguma receita fixa ou pode passar pra frente?`;
      }
      if (item.tipo === 'item' && item.descricao) {
        const campoPendente = proximoCampoFaltante({ descricao: item.descricao, valor: item.valor, dia: item.dia }, estado.etapa);
        if (campoPendente) {
          estado.itemParcial = { descricao: item.descricao, valor: item.valor, dia: item.dia, categoria: item.categoria, esperandoCampo: campoPendente };
          salvarPontoZero(usuarioId, estado);
          return perguntarCampoFaltante(campoPendente, item.descricao);
        }
      }
      return await redireccionarPontoZero(usuarioId, texto, 'receitas_fixas');
    }

    case 'receitas_variaveis': {
      if (item.tipo === 'nao' || querAvancar) {
        estado.etapa = 'despesas_fixas';
        salvarPontoZero(usuarioId, estado);
        return `Ótimo! Agora as *despesas* — tudo que sai todo mês: aluguel, internet, luz, água, escola, streaming...\n\nPode mandar várias de uma vez! Use o valor médio quando o valor varia — você poderá ajustar quando a conta chegar.\n_Ex: "Aluguel dia 5 R$ 1.500, luz dia 10 R$ 150, internet dia 15 R$ 120"_\n\n_Se não tem, manda "não"._`;
      }
      const res = coletarItens(item, estado.receitasVariaveis, estado.etapa);
      if (res.ok) {
        if (res.incompletos && res.incompletos.length > 0) {
          const [primeiro, ...restante] = res.incompletos;
          estado.itemParcial = { ...primeiro };
          if (restante.length > 0) estado.itensPendentes = restante;
          else delete estado.itensPendentes;
          salvarPontoZero(usuarioId, estado);
          const confirmacaoValidos = res.msg ? `Anotei:\n\n${res.msg}\n` : '';
          return `${confirmacaoValidos}Mas precisei da sua ajuda 👇\n\n${perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao)}`;
        }
        salvarPontoZero(usuarioId, estado);
        const mais = res.quantidade > 1 ? `${res.quantidade} receitas variáveis anotadas` : `Anotado`;
        return `${mais}:\n\n${res.msg}\nTem mais alguma receita variável ou pode passar pra frente?`;
      }
      if (item.tipo === 'item' && item.descricao) {
        const campoPendente = proximoCampoFaltante({ descricao: item.descricao, valor: item.valor, dia: item.dia }, estado.etapa);
        if (campoPendente) {
          estado.itemParcial = { descricao: item.descricao, valor: item.valor, dia: item.dia, categoria: item.categoria, esperandoCampo: campoPendente };
          salvarPontoZero(usuarioId, estado);
          return perguntarCampoFaltante(campoPendente, item.descricao);
        }
      }
      return await redireccionarPontoZero(usuarioId, texto, 'receitas_variaveis');
    }

    case 'despesas_fixas': {
      if (item.tipo === 'nao' || (querAvancar && estado.despesasFixas.length > 0)) {
        estado.etapa = 'investimentos';
        salvarPontoZero(usuarioId, estado);
        return `Ótimo! Agora me conta sobre suas *reservas e investimentos* 🏦\n\nPoupança, CDB, Tesouro Direto, ações, fundos... cada um vira uma *caixinha* separada e entra no seu patrimônio total.\n\nMe diz o nome da primeira caixinha.\n_Ex: "Poupança", "CDB Nubank", "Reserva emergência"_\n\n_Se não tem nada guardado, manda "não"._`;
      }
      const res = coletarItens(item, estado.despesasFixas, estado.etapa);
      if (res.ok) {
        if (res.incompletos && res.incompletos.length > 0) {
          const [primeiro, ...restante] = res.incompletos;
          estado.itemParcial = { ...primeiro };
          if (restante.length > 0) estado.itensPendentes = restante;
          else delete estado.itensPendentes;
          salvarPontoZero(usuarioId, estado);
          const confirmacaoValidos = res.msg ? `Anotei:\n\n${res.msg}\n` : '';
          return `${confirmacaoValidos}Mas precisei da sua ajuda 👇\n\n${perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao)}`;
        }
        salvarPontoZero(usuarioId, estado);
        const mais = res.quantidade > 1 ? `${res.quantidade} despesas anotadas` : `Anotado`;
        return `${mais}:\n\n${res.msg}\nTem mais alguma despesa ou pode passar pra frente?`;
      }
      if (item.tipo === 'item' && item.descricao) {
        const campoPendente = proximoCampoFaltante({ descricao: item.descricao, valor: item.valor, dia: item.dia }, estado.etapa);
        if (campoPendente) {
          estado.itemParcial = { descricao: item.descricao, valor: item.valor, dia: item.dia, categoria: item.categoria, esperandoCampo: campoPendente };
          salvarPontoZero(usuarioId, estado);
          return perguntarCampoFaltante(campoPendente, item.descricao);
        }
      }
      return await redireccionarPontoZero(usuarioId, texto, 'despesas_fixas');
    }

    case 'investimentos': {
      if (item.tipo === 'nao' || querAvancar) {
        if (estado.standalone === 'caixinha') {
          // Modo standalone: salvar caixinhas diretamente e encerrar
          for (const inv of estado.investimentos || []) {
            await db.criarCaixinha(usuarioId, inv.nome, inv.saldo, inv.meta, inv.tipo, inv.rendimento);
          }
          limparPontoZero(usuarioId);
          const qtd = (estado.investimentos || []).length;
          if (qtd === 0) return `Tudo bem! Nenhuma caixinha cadastrada.`;
          const total = (estado.investimentos || []).reduce((s, i) => s + (i.saldo || 0), 0);
          const lista = (estado.investimentos || []).map(i => `  💰 *${i.nome}* — ${fmt.formatarMoeda(i.saldo)}`).join('\n');
          return `✅ ${qtd === 1 ? 'Caixinha cadastrada' : `${qtd} caixinhas cadastradas`} com sucesso!\n\n${lista}\n\n💼 *Total investido: ${fmt.formatarMoeda(total)}*`;
        }
        estado.etapa = 'cartoes';
        salvarPontoZero(usuarioId, estado);
        return `Ótimo! Agora vamos registrar seus *cartões de crédito* — assim as faturas entram na sua projeção e te lembro dos vencimentos.\n\nMe diz o nome do primeiro cartão.\n_Ex: "Nubank", "Inter", "Bradesco Visa"_\n\n_Se não tem cartão, manda "não"._`;
      }
      const nomeCaixinha = texto.trim();
      if (!nomeCaixinha || nomeCaixinha.length < 2) {
        return `Me diz o nome da caixinha 😅\n_Ex: "Poupança", "CDB Nubank", "Reserva emergência"_\n_Ou manda "não" para pular._`;
      }
      estado.investimentoEmCadastro = { nome: nomeCaixinha, campo: 'saldo' };
      salvarPontoZero(usuarioId, estado);
      return `*${nomeCaixinha}* — quanto você tem guardado nessa caixinha hoje? 💰\n_Ex: "R$ 5.000" ou "5000"_`;
    }

    case 'cartoes': {
      if (item.tipo === 'nao' || querAvancar) {
        if (estado.standalone === 'cartao') {
          // Modo standalone: salvar cartões diretamente e encerrar
          for (const c of estado.cartoes || []) {
            // Persistir o cartão para vínculo de compras futuras
            await db.criarCartao(usuarioId, c.nome, c.limiteTotal, c.diaFechamento, c.diaVencimento);

            const recorrenciaId = await db.criarRecorrencia(
              usuarioId, 'despesa', c.valorFatura || 0, `Fatura ${c.nome}`, 'Cartão',
              'mensal', c.diaVencimento || 1, null, null, null
            );
            if (c.valorFatura && c.valorFatura > 0) {
              const dataStr = calcularDataPendente(c.diaVencimento);
              await db.adicionarTransacaoComRecorrencia(usuarioId, 'despesa', c.valorFatura, `Fatura ${c.nome}`, 'Cartão', dataStr, 'pendente', recorrenciaId);
            }
          }
          limparPontoZero(usuarioId);
          const qtd = (estado.cartoes || []).length;
          if (qtd === 0) return `Tudo bem! Nenhum cartão cadastrado.`;
          const lista = (estado.cartoes || []).map(c => `  💳 *${c.nome}* — vence dia ${c.diaVencimento}${c.valorFatura > 0 ? ` | fatura ${fmt.formatarMoeda(c.valorFatura)}` : ''}`).join('\n');
          return `✅ ${qtd === 1 ? 'Cartão cadastrado' : `${qtd} cartões cadastrados`} com sucesso!\n\n${lista}`;
        }
        const budget = gerarOrcamentoProporcional(estado);
        estado.orcamentos = budget.orcamentos;
        return await finalizarPontoZero(usuarioId, estado);
      }
      // Qualquer texto que não seja "não" → nome do cartão
      const nomeCartao = texto.trim();
      if (!nomeCartao || nomeCartao.length < 2) {
        return `Me diz o nome ou banco do cartão 😅\n_Ex: "Nubank", "Inter", "Bradesco Visa"_\n_Ou manda "não" se não tem cartão._`;
      }
      estado.cartaoEmCadastro = { nome: nomeCartao, campo: 'limiteTotal' };
      salvarPontoZero(usuarioId, estado);
      return `*${nomeCartao}* — qual o *limite total* desse cartão? 💳\n_Ex: "R$ 5.000" ou "5000"_`;
    }

    case 'despesas_dia_a_dia': {
      // Fallback para estados salvos — gera orçamento proporcional e finaliza
      if (estado.orcamentos.length === 0) {
        const budget = gerarOrcamentoProporcional(estado);
        estado.orcamentos = budget.orcamentos;
      }
      return await finalizarPontoZero(usuarioId, estado);
    }

    default:
      limparPontoZero(usuarioId);
      return 'Algo deu errado no fluxo 😅 Me manda *"finanças em dia"* pra começar de novo.';
  }
}

// Inicia cadastro de cartão fora do fluxo "Finanças em Dia"
async function iniciarCadastroCartaoStandalone(usuarioId) {
  salvarPontoZero(usuarioId, {
    etapa: 'cartoes',
    cartoes: [],
    investimentos: [],
    standalone: 'cartao',
  });
  return `Vamos cadastrar seu cartão de crédito! 💳\n\nMe diz o *nome ou banco* do cartão.\n_Ex: "Nubank", "Inter", "Bradesco Visa"_\n\n_Quando terminar, manda "não" pra encerrar._`;
}

// Inicia cadastro de caixinha/investimento fora do fluxo "Finanças em Dia"
async function iniciarCadastroCaixinhaStandalone(usuarioId) {
  salvarPontoZero(usuarioId, {
    etapa: 'investimentos',
    cartoes: [],
    investimentos: [],
    standalone: 'caixinha',
  });
  return `Vamos cadastrar sua caixinha de investimento! 🏦\n\nMe diz o *nome* da caixinha.\n_Ex: "Poupança", "CDB Nubank", "Reserva emergência"_\n\n_Quando terminar, manda "não" pra encerrar._`;
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

// Versão para setup inicial: sempre registra no mês corrente mesmo que o dia já tenha passado
function calcularDataPendenteMesAtual(dia) {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  const diaFinal = dia && dia > 0 ? Math.min(dia, ultimoDia) : ultimoDia;
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(diaFinal).padStart(2, '0')}`;
}

async function salvarDadosPontoZero(usuarioId, estado) {
  // Saldo inicial → receita já paga hoje (entra no saldoAtual imediatamente)
  if (estado.saldoInicial > 0) {
    const hojeISO = dateParaISO(new Date());
    await db.adicionarTransacao(usuarioId, 'receita', estado.saldoInicial, 'Saldo inicial', 'Outros', hojeISO, 'pago');
  }

  // Receitas fixas → regra de recorrência + transação pendente no mês atual (sempre neste mês no setup inicial)
  for (const r of estado.receitasFixas || []) {
    const recorrenciaId = await db.criarRecorrencia(
      usuarioId, 'receita', r.valor, r.descricao, r.categoria || 'Outros',
      'mensal', r.dia || 1, null, null, null
    );
    const dataStr = calcularDataPendenteMesAtual(r.dia);
    await db.adicionarTransacaoComRecorrencia(usuarioId, 'receita', r.valor, r.descricao, r.categoria || 'Outros', dataStr, 'pendente', recorrenciaId);
  }

  // Receitas variáveis → transação pendente no mês atual
  for (const r of estado.receitasVariaveis || []) {
    const dataStr = calcularDataPendenteMesAtual(r.dia);
    await db.adicionarTransacao(usuarioId, 'receita', r.valor, r.descricao, r.categoria || 'Outros', dataStr, 'pendente');
  }

  // Despesas fixas → regra de recorrência + transação pendente no mês atual (sempre neste mês no setup inicial)
  for (const d of estado.despesasFixas || []) {
    const recorrenciaId = await db.criarRecorrencia(
      usuarioId, 'despesa', d.valor, d.descricao, d.categoria || 'Outros',
      'mensal', d.dia || 1, null, null, null
    );
    const dataStr = calcularDataPendenteMesAtual(d.dia);
    await db.adicionarTransacaoComRecorrencia(usuarioId, 'despesa', d.valor, d.descricao, d.categoria || 'Outros', dataStr, 'pendente', recorrenciaId);
  }

  // Cartões → regra de recorrência + transação pendente no mês atual (sempre neste mês no setup inicial)
  for (const c of estado.cartoes || []) {
    // Persistir o cartão para vínculo de compras futuras
    await db.criarCartao(usuarioId, c.nome, c.limiteTotal, c.diaFechamento, c.diaVencimento);

    const recorrenciaId = await db.criarRecorrencia(
      usuarioId, 'despesa', c.valorFatura || 0, `Fatura ${c.nome}`, 'Cartão',
      'mensal', c.diaVencimento || 1, null, null, null
    );
    if (c.valorFatura && c.valorFatura > 0) {
      // No setup inicial sempre registra no mês corrente (mesmo que o dia já tenha passado)
      const dataStr = calcularDataPendenteMesAtual(c.diaVencimento);
      await db.adicionarTransacaoComRecorrencia(usuarioId, 'despesa', c.valorFatura, `Fatura ${c.nome}`, 'Cartão', dataStr, 'pendente', recorrenciaId);
    }
  }

  // Investimentos → criar caixinhas no banco
  for (const inv of estado.investimentos || []) {
    await db.criarCaixinha(usuarioId, inv.nome, inv.saldo, inv.meta, inv.tipo, inv.rendimento);
  }

  // Orçamentos → criar limitadores de categoria
  for (const o of estado.orcamentos || []) {
    await db.definirLimite(usuarioId, o.categoria, o.valor);
  }
}

async function finalizarPontoZero(usuarioId, estado) {
  await salvarDadosPontoZero(usuarioId, estado);
  limparPontoZero(usuarioId);

  const hoje = new Date();
  const diaHoje = hoje.getDate();
  const nomesMes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const mesAtual = nomesMes[hoje.getMonth()];
  const ultimoDia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const mmAtual = String(hoje.getMonth() + 1).padStart(2, '0');

  const ehFuturo = (item) => !item.dia || item.dia >= diaHoje;

  // Separar futuros (entram na projeção) dos passados (já no saldo)
  const rfFixasFut  = (estado.receitasFixas    || []).filter(ehFuturo);
  const rfVarFut    = (estado.receitasVariaveis || []).filter(ehFuturo);
  const dfFixasFut  = (estado.despesasFixas     || []).filter(ehFuturo);

  const rfFixasPass = (estado.receitasFixas    || []).filter(r => !ehFuturo(r));
  const rfVarPass   = (estado.receitasVariaveis || []).filter(r => !ehFuturo(r));
  const dfFixasPass = (estado.despesasFixas     || []).filter(d => !ehFuturo(d));

  // Cartões: fatura futura = diaVencimento ainda não passou; passada = já passou
  const cartoesFut  = (estado.cartoes || []).filter(c => c.valorFatura > 0 && (!c.diaVencimento || c.diaVencimento >= diaHoje));
  const cartoesPass = (estado.cartoes || []).filter(c => c.valorFatura > 0 && c.diaVencimento && c.diaVencimento < diaHoje);

  const soma = arr => arr.reduce((s, x) => s + x.valor, 0);
  const somaCartoes = arr => arr.reduce((s, c) => s + c.valorFatura, 0);

  const totalRecFixasFut   = soma(rfFixasFut);
  const totalRecVarFut     = soma(rfVarFut);
  const totalDespFixasFut  = soma(dfFixasFut);
  const totalCartoesFut    = somaCartoes(cartoesFut);
  const totalRecFut  = totalRecFixasFut + totalRecVarFut;
  const totalDespFut = totalDespFixasFut + totalCartoesFut;
  const previsao = estado.saldoInicial + totalRecFut - totalDespFut;

  const investimentos = estado.investimentos || [];
  const totalInvestido = investimentos.reduce((s, i) => s + i.saldo, 0);

  let msg = `📊 *FINANÇAS EM DIA — ${mesAtual.toUpperCase()}*\n\n`;
  msg += `💰 *Saldo atual:* ${fmt.formatarMoeda(estado.saldoInicial)}\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Caixinhas (sem repetir no cabeçalho — detalhes aqui já são suficientes)
  if (investimentos.length > 0) {
    msg += `🏦 *Caixinhas e Investimentos:*\n`;
    for (const inv of investimentos) {
      let linha = `  💰 ${inv.nome} — ${fmt.formatarMoeda(inv.saldo)}`;
      if (inv.meta) linha += ` | meta: ${fmt.formatarMoeda(inv.meta)}`;
      if (inv.tipo) linha += ` | ${inv.tipo}`;
      if (inv.rendimento) linha += ` | ${inv.rendimento}%/mês`;
      msg += linha + '\n';
    }
    msg += `  _Total investido: ${fmt.formatarMoeda(totalInvestido)}_\n\n`;
  }

  // Receitas fixas
  if (rfFixasFut.length > 0) {
    msg += `📈 *Receitas Fixas a receber (+${fmt.formatarMoeda(totalRecFixasFut)}):*\n`;
    for (const r of rfFixasFut) {
      msg += `  🟢 ${r.descricao} — ${fmt.formatarMoeda(r.valor)}${r.dia ? ` (dia ${r.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Receitas variáveis
  if (rfVarFut.length > 0) {
    msg += `📈 *Receitas Variáveis a receber (+${fmt.formatarMoeda(totalRecVarFut)}):*\n`;
    for (const r of rfVarFut) {
      msg += `  🟢 ${r.descricao} — ${fmt.formatarMoeda(r.valor)}${r.dia ? ` (dia ${r.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Despesas fixas
  if (dfFixasFut.length > 0) {
    msg += `📉 *Despesas a pagar (-${fmt.formatarMoeda(totalDespFixasFut)}):*\n`;
    for (const d of dfFixasFut) {
      msg += `  🔴 ${d.descricao} — ${fmt.formatarMoeda(d.valor)}${d.dia ? ` (dia ${d.dia})` : ''}\n`;
    }
    msg += '\n';
  }

  // Cartões — faturas futuras
  if (cartoesFut.length > 0) {
    msg += `💳 *Faturas de Cartão (-${fmt.formatarMoeda(totalCartoesFut)}):*\n`;
    for (const c of cartoesFut) {
      msg += `  🔴 ${c.nome} — ${fmt.formatarMoeda(c.valorFatura)} (venc. dia ${c.diaVencimento})\n`;
    }
    msg += '\n';
  }

  // Itens já contabilizados no saldo (dia já passou)
  const passados = [...rfFixasPass, ...rfVarPass, ...dfFixasPass, ...cartoesPass];
  if (passados.length > 0) {
    msg += `✅ *Já contabilizado no saldo (dias anteriores):*\n`;
    for (const r of [...rfFixasPass, ...rfVarPass]) {
      msg += `  🟢 ${r.descricao} — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia}) ✔️\n`;
    }
    for (const d of dfFixasPass) {
      msg += `  🔴 ${d.descricao} — ${fmt.formatarMoeda(d.valor)} (dia ${d.dia}) ✔️\n`;
    }
    for (const c of cartoesPass) {
      msg += `  🔴 ${c.nome} — ${fmt.formatarMoeda(c.valorFatura)} (venc. dia ${c.diaVencimento}) ✔️\n`;
    }
    msg += '\n';
  }

  // Orçamento proporcional (regra 50/20/10/15/5)
  const totalReceitas = [...(estado.receitasFixas || []), ...(estado.receitasVariaveis || [])].reduce((s, r) => s + r.valor, 0);
  const totalFixasReal = (estado.despesasFixas || []).reduce((s, d) => s + d.valor, 0);
  const limiteFixas = Math.round(totalReceitas * 0.50);
  const alertaFixas = totalFixasReal > limiteFixas;

  const linhasOrcamento = [
    { label: 'Fixas',         pct: 50, valor: limiteFixas,                      real: totalFixasReal, check: true },
    { label: 'Variáveis',     pct: 20, valor: Math.round(totalReceitas * 0.20), real: null,           check: false },
    { label: 'Lazer',         pct: 10, valor: Math.round(totalReceitas * 0.10), real: null,           check: false },
    { label: 'Investimentos', pct: 15, valor: Math.round(totalReceitas * 0.15), real: null,           check: false },
    { label: 'Objetivos',     pct:  5, valor: Math.round(totalReceitas * 0.05), real: null,           check: false },
  ];

  msg += `📊 *Orçamento mensal sugerido* _(baseado na sua renda de ${fmt.formatarMoeda(totalReceitas)})_\n\n`;
  for (const l of linhasOrcamento) {
    const emojiLinha = l.check && alertaFixas ? '⚠️' : '🟡';
    msg += `${emojiLinha} *${l.label}* (${l.pct}%) — ${fmt.formatarMoeda(l.valor)}`;
    if (l.check && alertaFixas) {
      msg += `\n   _⚠️ Suas fixas atuais (${fmt.formatarMoeda(l.real)}) já ultrapassam esse limite!_`;
    }
    msg += '\n';
  }
  msg += '\n';

  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  const emojiPrev = previsao >= 0 ? '✅' : '🚨';
  msg += `${emojiPrev} *Previsão até ${ultimoDia}/${mmAtual}:* ${fmt.formatarMoeda(previsao)}\n`;
  if (totalInvestido > 0) {
    msg += `💼 *Patrimônio total:* ${fmt.formatarMoeda(estado.saldoInicial + totalInvestido)} _(saldo + investimentos)_\n`;
  }
  msg += '\n';
  if (previsao >= 0) {
    msg += `Sobram *${fmt.formatarMoeda(previsao)}* até o fim do mês! 💪\n`;
  } else {
    msg += `⚠️ Atenção! Faltam *${fmt.formatarMoeda(Math.abs(previsao))}* pra fechar o mês no azul.\n`;
  }

  msg += `\n_Tudo registrado! Agora é só ir usando o Cronos no dia a dia._ 🚀\n`;
  msg += `_Dica: peça *"resumo"* ou *"agenda"* quando quiser acompanhar._`;

  return msg;
}

// ==================== IMPORTAR EXTRATO CSV ====================

// ========== ANÁLISE FINANCEIRA 50/30/20 ==========

// Mapeamento de palavras-chave para reclassificação de recorrentes
const PALAVRAS_CATEGORIA = {
  'aluguel': 'Moradia', 'condominio': 'Moradia', 'condomínio': 'Moradia', 'iptu': 'Moradia',
  'luz': 'Moradia', 'energia': 'Moradia', 'agua': 'Moradia', 'água': 'Moradia', 'gas': 'Moradia', 'gás': 'Moradia',
  'internet': 'Moradia', 'telefone': 'Moradia', 'celular': 'Moradia',
  'mercado': 'Alimentacao', 'supermercado': 'Alimentacao', 'feira': 'Alimentacao',
  'gasolina': 'Transporte', 'combustivel': 'Transporte', 'estacionamento': 'Transporte', 'uber': 'Transporte',
  'academia': 'Saude', 'plano de saude': 'Saude', 'plano de saúde': 'Saude', 'farmacia': 'Saude', 'farmácia': 'Saude',
  'escola': 'Educacao', 'faculdade': 'Educacao', 'curso': 'Educacao', 'mensalidade': 'Educacao',
  'netflix': 'Lazer', 'spotify': 'Lazer', 'streaming': 'Lazer', 'assinatura': 'Lazer',
  'investimento': 'Investimentos', 'poupanca': 'Investimentos', 'poupança': 'Investimentos',
  'salario': 'Salario', 'salário': 'Salario',
};

function detectarRecorrentes(transacoes) {
  const grupos = {};
  for (const t of transacoes) {
    const chave = `${t.descricao}|${t.tipo}`;
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(t);
  }

  const totalMeses = new Set(transacoes.map(t => t.data.substring(0, 7))).size;
  const recorrentes = [];

  for (const [chave, items] of Object.entries(grupos)) {
    const meses = new Set(items.map(t => t.data.substring(0, 7)));
    if (meses.size < 2) continue;

    const valorMedio = items.reduce((s, t) => s + t.valor, 0) / items.length;
    const diaMedio = Math.round(items.reduce((s, t) => s + parseInt(t.data.split('-')[2]), 0) / items.length);

    // Valores similares (variação < 20%)
    const valoresProximos = items.every(t => Math.abs(t.valor - valorMedio) / valorMedio < 0.20);
    if (!valoresProximos) continue;

    recorrentes.push({
      descricao: items[0].descricao,
      tipo: items[0].tipo,
      categoria: items[0].categoria,
      valorMedio: Math.round(valorMedio * 100) / 100,
      diaMedio,
      mesesEncontrados: meses.size,
      totalMeses,
    });
  }

  // Despesas primeiro, depois por valor decrescente
  return recorrentes.sort((a, b) => {
    if (a.tipo !== b.tipo) return a.tipo === 'despesa' ? -1 : 1;
    return b.valorMedio - a.valorMedio;
  });
}

function interpretarRespostaRecorrente(texto) {
  const lower = texto.toLowerCase().trim();

  // Negação
  if (['não', 'nao', 'n', 'nope', 'pular', 'skip'].includes(lower)) {
    return { acao: 'pular' };
  }

  // Pular todos
  if (['pronto', 'pular todos', 'chega', 'pular tudo', 'seguir'].includes(lower)) {
    return { acao: 'pular_todos' };
  }

  // Confirmação simples
  if (['sim', 's', 'pode', 'ok', 'é', 'eh', 'isso'].includes(lower)) {
    return { acao: 'confirmar' };
  }

  // Texto com "sim" + nome: "sim, é o aluguel" ou "sim é meu salário"
  const matchSimNome = lower.match(/^(?:sim|s|é|eh),?\s*(?:é|eh|e)?\s*(?:o|a|meu|minha)?\s*(.+)$/);
  if (matchSimNome) {
    const nome = matchSimNome[1].trim();
    return extrairNomeECategoria(nome);
  }

  // Texto livre = nome personalizado
  return extrairNomeECategoria(lower);
}

function extrairNomeECategoria(texto) {
  // Capitalizar primeira letra
  const nome = texto.charAt(0).toUpperCase() + texto.slice(1);

  // Tentar detectar categoria pelo nome
  for (const [palavra, cat] of Object.entries(PALAVRAS_CATEGORIA)) {
    if (texto.includes(palavra)) {
      return { acao: 'renomear', nome, categoria: cat };
    }
  }

  return { acao: 'renomear', nome, categoria: null };
}

function montarPerguntaRecorrente(item, indice, total) {
  const emoji = item.tipo === 'despesa' ? '🔴' : '🟢';
  const tipoLabel = item.tipo === 'despesa' ? 'gasto' : 'receita';

  let msg = `${emoji} *${indice + 1}/${total}* — *${item.descricao}* (${item.categoria})\n`;
  msg += `💰 ${fmt.formatarMoeda(item.valorMedio)}/mês | 📅 dia ~${item.diaMedio}\n`;
  msg += `_Aparece em ${item.mesesEncontrados} de ${item.totalMeses} meses_\n\n`;
  msg += `Esse ${tipoLabel} é fixo? *(sim/não)*\n`;
  msg += `_Ou escreva o nome correto (ex: "é o aluguel")_`;

  return msg;
}

async function confirmarRecorrente(usuarioId, item) {
  const dataStr = calcularDataPendente(item.diaMedio);
  await db.adicionarTransacao(usuarioId, item.tipo, item.valorMedio, item.descricao, item.categoria, dataStr, 'pendente');

  const labelPagar = item.tipo === 'despesa' ? '💸 Pagar' : '💰 Receber';
  await db.criarLembreteRecorrente(
    usuarioId,
    `${labelPagar}: ${item.descricao} - ${fmt.formatarMoeda(item.valorMedio)}`,
    '09:00',
    'mensal',
    null,
    item.diaMedio || 1,
    null
  );
}

async function finalizarRecorrentes(usuarioId, estado) {
  const confirmados = estado.recorrentesConfirmados || [];
  const despFixas = confirmados.filter(r => r.tipo === 'despesa');
  const recFixas = confirmados.filter(r => r.tipo === 'receita');

  let msg = '';
  if (confirmados.length > 0) {
    msg = `✅ *${confirmados.length} ${confirmados.length === 1 ? 'item fixo cadastrado' : 'itens fixos cadastrados'}!*\n`;
    if (despFixas.length > 0) msg += `🔴 ${despFixas.length} despesa${despFixas.length > 1 ? 's' : ''} fixa${despFixas.length > 1 ? 's' : ''}\n`;
    if (recFixas.length > 0) msg += `🟢 ${recFixas.length} receita${recFixas.length > 1 ? 's' : ''} fixa${recFixas.length > 1 ? 's' : ''}\n`;
    msg += '\n';
  }

  msg += '⏳ Agora vou fazer a análise 50/30/20...\n\n';

  // Executar a análise com as transações salvas no estado
  const analise = await gerarRelatorio503020(usuarioId, estado);

  if (typeof analise === 'object' && analise.texto) {
    return { texto: msg + analise.texto, grafico: analise.grafico };
  }
  return msg + analise;
}

async function iniciarAnaliseFinanceira(usuarioId) {
  salvarAnaliseFinanceira(usuarioId, {
    etapa: 'aguardando_csv',
    transacoes: [],
    csvsRecebidos: 0,
  });

  return `📊 *Análise Financeira - Regra 50/30/20*\n\nVou analisar seus gastos e te mostrar como estão distribuídos entre:\n\n🏠 *Necessidades* (meta: 50%) - moradia, contas, comida, transporte\n🎯 *Desejos* (meta: 30%) - lazer, compras, comer fora\n💰 *Poupança* (meta: 20%) - investimentos, objetivos, dívidas\n\n📄 Me manda o primeiro extrato bancário em *CSV*.\n_(Você pode enviar até 3 extratos de bancos diferentes)_`;
}

async function handleAnaliseFinanceiraCSV(usuarioId, csvContent) {
  const estado = obterAnaliseFinanceira(usuarioId);

  if (!estado || estado.etapa !== 'aguardando_csv') {
    // Não está no fluxo de análise - retorna null para seguir fluxo normal
    return null;
  }

  const novasTransacoes = parseCSV(csvContent);

  if (novasTransacoes.length === 0) {
    return '❌ Não encontrei transações nesse CSV. Verifica se está no formato: Data,Valor,Identificador,Descrição\n\n_Tenta mandar outro arquivo ou digite *cancelar* pra sair._';
  }

  estado.transacoes = estado.transacoes.concat(novasTransacoes);
  estado.csvsRecebidos++;

  salvarAnaliseFinanceira(usuarioId, estado);

  const totalTx = estado.transacoes.length;
  const restantes = 3 - estado.csvsRecebidos;

  if (restantes === 0) {
    // Já recebeu 3 CSVs - inicia análise automaticamente
    return await executarAnalise503020(usuarioId, estado);
  }

  return `✅ *Extrato ${estado.csvsRecebidos} recebido!* ${novasTransacoes.length} transações identificadas.\n📋 Total acumulado: ${totalTx} transações\n\nQuer enviar mais um extrato? _(${restantes === 1 ? 'Falta 1' : `Faltam ${restantes}`})_\nOu digite *analisar* para eu começar a análise.`;
}

async function handleAnaliseFinanceiraMsg(usuarioId, texto, estado) {
  const lower = texto.toLowerCase().trim();

  if (lower === 'cancelar' || lower === 'sair') {
    limparAnaliseFinanceira(usuarioId);
    return '❌ Análise financeira cancelada.';
  }

  if (estado.etapa === 'aguardando_csv') {
    if (lower === 'analisar' || lower === 'analisa' || lower === 'pode analisar') {
      if (estado.transacoes.length === 0) {
        return '📄 Ainda não recebi nenhum extrato! Me manda um CSV primeiro.\n\n_Ou digite *cancelar* pra sair._';
      }
      return await executarAnalise503020(usuarioId, estado);
    }
    return '📄 Estou esperando um extrato em CSV.\n\nEnvia o arquivo ou digite *analisar* pra começar com o que já temos.\n_Digite *cancelar* pra sair._';
  }

  if (estado.etapa === 'confirmando_recorrentes') {
    const resposta = interpretarRespostaRecorrente(texto);
    const recorrentes = estado.recorrentesDetectados;
    const idx = estado.recorrenteAtual;
    const itemAtual = recorrentes[idx];

    if (resposta.acao === 'pular_todos') {
      // Salvar os já confirmados e ir pra análise
      for (const item of estado.recorrentesConfirmados || []) {
        await confirmarRecorrente(usuarioId, item);
      }
      return await finalizarRecorrentes(usuarioId, estado);
    }

    if (resposta.acao === 'pular') {
      // Próximo item
    } else if (resposta.acao === 'confirmar') {
      if (!estado.recorrentesConfirmados) estado.recorrentesConfirmados = [];
      estado.recorrentesConfirmados.push(itemAtual);
    } else if (resposta.acao === 'renomear') {
      const itemRenomeado = {
        ...itemAtual,
        descricao: resposta.nome,
        categoria: resposta.categoria || itemAtual.categoria,
      };
      if (!estado.recorrentesConfirmados) estado.recorrentesConfirmados = [];
      estado.recorrentesConfirmados.push(itemRenomeado);
    }

    // Feedback da ação
    let feedback = '';
    if (resposta.acao === 'pular') {
      feedback = '⏭️ Pulei.\n\n';
    } else {
      const nomeUsado = resposta.acao === 'renomear' ? resposta.nome : itemAtual.descricao;
      const catUsada = resposta.acao === 'renomear' && resposta.categoria ? resposta.categoria : itemAtual.categoria;
      feedback = `✅ *${nomeUsado}* registrado como ${itemAtual.tipo === 'despesa' ? 'despesa' : 'receita'} fixa! (${catUsada}, dia ${itemAtual.diaMedio})\n\n`;
    }

    // Avançar para próximo
    estado.recorrenteAtual = idx + 1;

    if (estado.recorrenteAtual >= recorrentes.length) {
      // Acabaram os recorrentes - salvar confirmados e fazer análise
      for (const item of estado.recorrentesConfirmados || []) {
        await confirmarRecorrente(usuarioId, item);
      }
      const resultado = await finalizarRecorrentes(usuarioId, estado);
      if (typeof resultado === 'object' && resultado.texto) {
        return { texto: feedback + resultado.texto, grafico: resultado.grafico };
      }
      return feedback + resultado;
    }

    // Mostrar próximo
    salvarAnaliseFinanceira(usuarioId, estado);
    const proxima = montarPerguntaRecorrente(recorrentes[estado.recorrenteAtual], estado.recorrenteAtual, recorrentes.length);
    return feedback + proxima;
  }

  if (estado.etapa === 'confirmando_limites') {
    if (['sim', 's', 'pode', 'bora', 'quero', 'ok', 'pode ser'].includes(lower)) {
      return await criarLimitesAnalise(usuarioId, estado.limitesSugeridos);
    }
    if (['não', 'nao', 'n', 'não quero', 'nao quero'].includes(lower)) {
      limparAnaliseFinanceira(usuarioId);
      return '👍 Sem problemas! Os limites não foram criados.\n\n_Você pode criar limites manualmente a qualquer momento: "limitar gastos com Alimentação em 1000 reais"_';
    }
    return 'Quer que eu crie os limites? Responde *sim* ou *não*.';
  }

  return '🤔 Algo deu errado com a análise. Digite *análise financeira* pra começar de novo.';
}

async function executarAnalise503020(usuarioId, estado) {
  const transacoes = estado.transacoes;

  // Categorizar todas as transações via IA
  const descUnicas = [...new Set(transacoes.map(t => t.descricaoOriginal))];
  console.log(`[ANÁLISE 50/30/20] ${transacoes.length} transações, ${descUnicas.length} descrições únicas. Categorizando...`);

  const categoriaMap = await categorizarExtrato(descUnicas);

  for (const t of transacoes) {
    const info = categoriaMap[t.descricaoOriginal];
    if (info) {
      t.categoria = info.categoria || 'Outros';
      t.descricao = info.descricao || t.descricaoOriginal;
    }
  }

  // Salvar todas as transações no banco de dados (como a importação normal)
  let salvos = 0;
  for (const t of transacoes) {
    try {
      await db.adicionarTransacao(usuarioId, t.tipo, t.valor, t.descricao, t.categoria, t.data, 'pago');
      salvos++;
    } catch (err) {
      console.error(`[ANÁLISE 50/30/20] Erro ao salvar transação: ${err.message}`);
    }
  }
  console.log(`[ANÁLISE 50/30/20] ${salvos}/${transacoes.length} transações salvas no banco.`);

  // Detectar recorrentes antes de mostrar a análise
  const recorrentes = detectarRecorrentes(transacoes);

  if (recorrentes.length > 0) {
    console.log(`[ANÁLISE 50/30/20] ${recorrentes.length} transações recorrentes detectadas.`);

    // Salvar estado com recorrentes e transacoes categorizadas
    salvarAnaliseFinanceira(usuarioId, {
      etapa: 'confirmando_recorrentes',
      transacoes,
      recorrentesDetectados: recorrentes,
      recorrenteAtual: 0,
      recorrentesConfirmados: [],
    });

    let msg = `🔄 *Identifiquei ${recorrentes.length} ${recorrentes.length === 1 ? 'gasto que parece' : 'gastos que parecem'} ser FIXO${recorrentes.length > 1 ? 'S' : ''}!*\n\n`;
    msg += `Vou te mostrar um a um pra você confirmar.\n_Digite *pronto* a qualquer momento pra pular os restantes._\n\n`;
    msg += montarPerguntaRecorrente(recorrentes[0], 0, recorrentes.length);

    return msg;
  }

  // Sem recorrentes, ir direto pra análise
  return await gerarRelatorio503020(usuarioId, estado);
}

async function gerarRelatorio503020(usuarioId, estado) {
  const transacoes = estado.transacoes;

  // Determinar quantos meses distintos existem nos extratos
  const mesesDistintos = new Set(transacoes.map(t => t.data.substring(0, 7))); // YYYY-MM
  const qtdMeses = Math.max(mesesDistintos.size, 1);
  console.log(`[ANÁLISE 50/30/20] ${qtdMeses} mês(es) distinto(s) nos extratos: ${[...mesesDistintos].join(', ')}`);

  // Separar receitas e despesas
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const despesas = transacoes.filter(t => t.tipo === 'despesa');

  // Calcular médias mensais (dividir pelo número de meses)
  const receitaTotal = receitas.reduce((acc, t) => acc + t.valor, 0) / qtdMeses;
  const despesaTotal = despesas.reduce((acc, t) => acc + t.valor, 0) / qtdMeses;

  if (receitaTotal === 0) {
    limparAnaliseFinanceira(usuarioId);
    return '❌ Não identifiquei receitas nos extratos. A regra 50/30/20 precisa da renda pra calcular as metas.\n\n_Certifica que o extrato contém entradas positivas (salário, transferências recebidas, etc.)_';
  }

  // Calcular gastos por categoria (média mensal)
  const gastosPorCategoria = {};
  for (const t of despesas) {
    gastosPorCategoria[t.categoria] = (gastosPorCategoria[t.categoria] || 0) + t.valor;
  }
  // Dividir cada categoria pelo número de meses
  for (const cat of Object.keys(gastosPorCategoria)) {
    gastosPorCategoria[cat] = gastosPorCategoria[cat] / qtdMeses;
  }

  // Classificar categorias nos buckets 50/30/20
  const buckets = {};
  const categoriasDetalhe = {};

  for (const [bucket, config] of Object.entries(REGRA_503020)) {
    let total = 0;
    const detalhes = [];
    for (const cat of config.categorias) {
      if (gastosPorCategoria[cat]) {
        total += gastosPorCategoria[cat];
        detalhes.push(`${cat}: ${fmt.formatarMoeda(gastosPorCategoria[cat])}`);
      }
    }
    const meta = receitaTotal * config.meta;
    const percentual = receitaTotal > 0 ? (total / receitaTotal) * 100 : 0;
    buckets[bucket] = { real: total, meta, percentual };
    categoriasDetalhe[bucket] = detalhes.length > 0 ? detalhes.join(', ') : 'Nenhum gasto';
  }

  // Categorias não classificadas (não mapeadas em nenhum bucket)
  const categsMapeadas = Object.values(REGRA_503020).flatMap(b => b.categorias);
  for (const [cat, valor] of Object.entries(gastosPorCategoria)) {
    if (!categsMapeadas.includes(cat)) {
      buckets.desejos.real += valor;
      buckets.desejos.percentual = receitaTotal > 0 ? (buckets.desejos.real / receitaTotal) * 100 : 0;
      categoriasDetalhe.desejos += `, ${cat}: ${fmt.formatarMoeda(valor)}`;
    }
  }

  // Montar mensagem
  let msg = `📊 *ANÁLISE FINANCEIRA - REGRA 50/30/20*\n`;
  if (qtdMeses > 1) {
    msg += `📅 _Média mensal baseada em ${qtdMeses} meses de extratos_\n`;
  }
  msg += `\n`;
  msg += `💵 Renda${qtdMeses > 1 ? ' mensal' : ''}: *${fmt.formatarMoeda(receitaTotal)}*\n`;
  msg += `💸 Gastos${qtdMeses > 1 ? ' mensais' : ''}: *${fmt.formatarMoeda(despesaTotal)}*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  for (const [bucket, config] of Object.entries(REGRA_503020)) {
    const dados = buckets[bucket];
    const metaPct = config.meta * 100;
    const desvio = dados.percentual - metaPct;

    let statusIcon;
    if (bucket === 'poupanca') {
      statusIcon = dados.real >= dados.meta ? '✅' : '❌';
    } else {
      if (Math.abs(desvio) <= 3) statusIcon = '✅';
      else statusIcon = dados.real > dados.meta ? '⚠️' : '✅';
    }

    msg += `${config.emoji} *${config.label.toUpperCase()} (meta: ${metaPct}% = ${fmt.formatarMoeda(dados.meta)})*\n`;
    msg += `Você gastou: ${fmt.formatarMoeda(dados.real)} (${dados.percentual.toFixed(1)}%) ${statusIcon}`;

    if (Math.abs(desvio) > 1) {
      if (bucket === 'poupanca') {
        msg += desvio < 0 ? ` ${Math.abs(desvio).toFixed(0)}% abaixo` : ` +${desvio.toFixed(0)}% acima`;
      } else {
        msg += desvio > 0 ? ` +${desvio.toFixed(0)}% acima` : ` ${Math.abs(desvio).toFixed(0)}% abaixo`;
      }
    }
    msg += '\n';

    // Detalhes por categoria
    for (const cat of config.categorias) {
      if (gastosPorCategoria[cat]) {
        msg += `  📂 ${cat}: ${fmt.formatarMoeda(gastosPorCategoria[cat])}\n`;
      }
    }
    msg += '\n';
  }

  msg += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Diagnóstico da IA
  const diagnostico = await gerarDiagnosticoFinanceiro({
    receitaTotal,
    despesaTotal,
    buckets,
    categoriaDetalhe: categoriasDetalhe,
  });

  if (diagnostico) {
    msg += `💡 *DIAGNÓSTICO:*\n${diagnostico}\n\n`;
  }

  // Calcular limites sugeridos
  const limitesSugeridos = {};
  for (const [bucket, config] of Object.entries(REGRA_503020)) {
    const orcamentoBucket = receitaTotal * config.meta;
    const categsComGasto = config.categorias.filter(c => gastosPorCategoria[c]);

    if (categsComGasto.length > 0) {
      const totalBucket = categsComGasto.reduce((acc, c) => acc + gastosPorCategoria[c], 0);
      for (const cat of categsComGasto) {
        const proporcao = gastosPorCategoria[cat] / totalBucket;
        limitesSugeridos[cat] = Math.round(orcamentoBucket * proporcao);
      }
    }
  }

  msg += `Quer que eu crie *limites de gastos* por categoria baseados na regra 50/30/20? *(sim/não)*`;

  // Gerar gráfico
  const grafico = await charts.gerarGrafico503020({
    necessidades: { real: buckets.necessidades.real, meta: buckets.necessidades.meta },
    desejos: { real: buckets.desejos.real, meta: buckets.desejos.meta },
    poupanca: { real: buckets.poupanca.real, meta: buckets.poupanca.meta },
  });

  // Salvar estado para confirmação de limites
  salvarAnaliseFinanceira(usuarioId, {
    etapa: 'confirmando_limites',
    limitesSugeridos,
  });

  if (grafico) {
    return { texto: msg, grafico };
  }
  return msg;
}

async function criarLimitesAnalise(usuarioId, limitesSugeridos) {
  let msg = '✅ *Limites criados com sucesso!*\n\n';

  for (const [categoria, valor] of Object.entries(limitesSugeridos)) {
    await db.definirLimite(usuarioId, categoria, valor);
    msg += `📂 ${categoria}: ${fmt.formatarMoeda(valor)}/mês\n`;
  }

  msg += '\n_Vou te avisar sempre que uma despesa ultrapassar o limite!_';

  limparAnaliseFinanceira(usuarioId);
  return msg;
}

function parseCSV(csvContent) {
  // Remove BOM e normaliza line endings
  const content = csvContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = content.split('\n').filter(l => l.trim());

  if (lines.length < 2) return [];

  const transacoes = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Formato Nubank: Data,Valor,Identificador,Descrição
    // Descrição pode conter vírgulas, então split nos primeiros 3 separadores
    const p1 = line.indexOf(',');
    const p2 = line.indexOf(',', p1 + 1);
    const p3 = line.indexOf(',', p2 + 1);

    if (p1 === -1 || p2 === -1 || p3 === -1) continue;

    const data = line.substring(0, p1).trim();
    const valorStr = line.substring(p1 + 1, p2).trim();
    const descricao = line.substring(p3 + 1).trim();

    const valor = parseFloat(valorStr);
    if (isNaN(valor) || valor === 0) continue;

    // Converter DD/MM/YYYY para YYYY-MM-DD
    const partes = data.split('/');
    if (partes.length < 3) continue;
    const [dia, mes, ano] = partes;
    const dataFormatada = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;

    transacoes.push({
      data: dataFormatada,
      valor: Math.abs(valor),
      tipo: valor > 0 ? 'receita' : 'despesa',
      descricaoOriginal: descricao,
      descricao: descricao, // será substituída pela AI
      categoria: 'Outros',  // será substituída pela AI
    });
  }

  return transacoes;
}

async function handleCSVImport(usuarioId, csvContent) {
  const transacoes = parseCSV(csvContent);

  if (transacoes.length === 0) {
    return '❌ Não encontrei transações no arquivo CSV.\n\nCertifica que é um extrato no formato: Data,Valor,Identificador,Descrição';
  }

  // Pegar descrições únicas para categorizar em batch
  const descUnicas = [...new Set(transacoes.map(t => t.descricaoOriginal))];

  console.log(`[CSV] ${transacoes.length} transações encontradas, ${descUnicas.length} descrições únicas. Categorizando...`);

  // Categorizar via AI
  const categoriaMap = await categorizarExtrato(descUnicas);

  // Aplicar categorias e descrições limpas
  for (const t of transacoes) {
    const info = categoriaMap[t.descricaoOriginal];
    if (info) {
      t.categoria = info.categoria || 'Outros';
      t.descricao = info.descricao || t.descricaoOriginal;
    }
  }

  // Salvar todas as transações no banco
  let salvos = 0;
  for (const t of transacoes) {
    try {
      await db.adicionarTransacao(usuarioId, t.tipo, t.valor, t.descricao, t.categoria, t.data, 'pago');
      salvos++;
    } catch (err) {
      console.error(`[CSV] Erro ao salvar transação: ${err.message}`);
    }
  }

  // Calcular resumo
  const receitas = transacoes.filter(t => t.tipo === 'receita');
  const despesas = transacoes.filter(t => t.tipo === 'despesa');
  const totalReceitas = receitas.reduce((acc, t) => acc + t.valor, 0);
  const totalDespesas = despesas.reduce((acc, t) => acc + t.valor, 0);

  // Período
  const datas = transacoes.map(t => t.data).sort();
  const dataInicio = datas[0];
  const dataFim = datas[datas.length - 1];

  let msg = `✅ *Extrato importado com sucesso!*\n\n`;
  msg += `📅 Período: ${fmt.formatarData(dataInicio)} a ${fmt.formatarData(dataFim)}\n`;
  msg += `📋 ${salvos} transações registradas\n\n`;
  msg += `🟢 ${receitas.length} receitas: +${fmt.formatarMoeda(totalReceitas)}\n`;
  msg += `🔴 ${despesas.length} despesas: -${fmt.formatarMoeda(totalDespesas)}\n`;
  msg += `💰 Saldo do período: ${fmt.formatarMoeda(totalReceitas - totalDespesas)}\n\n`;

  // Breakdown por categoria (despesas)
  const catTotals = {};
  for (const t of despesas) {
    catTotals[t.categoria] = (catTotals[t.categoria] || 0) + t.valor;
  }

  if (Object.keys(catTotals).length > 0) {
    msg += `📊 *Despesas por categoria:*\n`;
    const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
    for (const [cat, total] of sorted) {
      msg += `  📂 ${cat}: ${fmt.formatarMoeda(total)}\n`;
    }
  }

  msg += `\n_Dica: peça *"resumo"* pra ver o panorama completo!_`;

  return msg;
}

// ── Assessor de Compra ────────────────────────────────────────────────────────
async function handleAssessorCompraContinuacao(usuarioId, texto, estado) {
  const lower = texto.toLowerCase().trim();

  if (lower === 'cancelar' || lower === 'deixa' || lower === 'esquece') {
    limparAssessorCompra(usuarioId);
    return '❌ Tudo bem, cancelado!';
  }

  const valor = extrairValorDoTexto(texto);
  if (!valor || valor <= 0) {
    return `❌ Não entendi o valor. Me diz quanto custa o *${estado.descricao}*:\n\n_Ex: "150", "R$ 1.200", "50 reais"_\n\n_Ou manda "cancelar" pra desistir._`;
  }

  limparAssessorCompra(usuarioId);
  return await handleAssessorCompra(usuarioId, {
    descricao: estado.descricao,
    valor,
    parcelasSolicitadas: estado.parcelasSolicitadas,
  });
}

async function handleAssessorCompra(usuarioId, resultado) {
  const { descricao, valor: valorCompra, parcelasSolicitadas } = resultado;

  if (!valorCompra || valorCompra <= 0) {
    salvarAssessorCompra(usuarioId, { descricao: descricao || 'item', parcelasSolicitadas: parcelasSolicitadas || null });
    return `💭 Pra te ajudar a avaliar, me diz o valor! Quanto custa o *${descricao || 'item'}*?`;
  }

  try {
    const agora = new Date();
    const mesAtual = agora.getMonth() + 1;
    const anoAtual = agora.getFullYear();

    // Últimos 3 meses para cálculo do superávit médio
    const resumoPromises = [];
    for (let i = 1; i <= 3; i++) {
      let m = mesAtual - i;
      let a = anoAtual;
      if (m <= 0) { m += 12; a -= 1; }
      resumoPromises.push(db.resumoMensal(usuarioId, m, a));
    }

    const [saldos, pendentes, limites, ...resumosMensais] = await Promise.all([
      db.calcularSaldos(usuarioId),
      db.listarPendentes(usuarioId, null),
      db.listarLimites(usuarioId),
      ...resumoPromises,
    ]);

    // Filtra pendentes nos próximos 30 dias
    const hoje = new Date();
    const limite30d = new Date(hoje);
    limite30d.setDate(limite30d.getDate() + 30);

    const pendentes30d = pendentes.filter(p => {
      if (!p.data) return false;
      const d = new Date(p.data + 'T12:00:00');
      return d >= hoje && d <= limite30d;
    });

    const despesasPendentes30d = pendentes30d
      .filter(p => p.tipo === 'despesa')
      .reduce((acc, p) => acc + p.valor, 0);

    const receitasPendentes30d = pendentes30d
      .filter(p => p.tipo === 'receita')
      .reduce((acc, p) => acc + p.valor, 0);

    // Conservador: só o que está no banco agora, menos as contas a pagar
    const disponivelConservador = saldos.saldoAtual - despesasPendentes30d;
    // Previsto: inclui receitas que entram nos próximos 30 dias
    const disponivelPrevisto = saldos.saldoAtual + receitasPendentes30d - despesasPendentes30d;

    // Superávit médio real dos últimos 3 meses (receitas pagas - despesas pagas)
    const surplusPorMes = resumosMensais
      .map(resumo => {
        let rec = 0, desp = 0;
        for (const t of resumo.totais) {
          if (t.tipo === 'receita' && t.status === 'pago') rec = t.total;
          if (t.tipo === 'despesa' && t.status === 'pago') desp = t.total;
        }
        return rec - desp;
      })
      .filter(s => s !== 0);

    const surplusMedio = surplusPorMes.length > 0
      ? surplusPorMes.reduce((a, b) => a + b, 0) / surplusPorMes.length
      : null;

    // Próxima receita esperada (mais cedo)
    const receitasOrdenadas = pendentes
      .filter(p => p.tipo === 'receita' && p.data)
      .sort((a, b) => new Date(a.data) - new Date(b.data));
    const proximaReceita = receitasOrdenadas.length > 0
      ? { descricao: receitasOrdenadas[0].descricao, valor: receitasOrdenadas[0].valor, data: fmt.formatarData(receitasOrdenadas[0].data) }
      : null;

    // Limites ativos nas categorias relevantes para compras
    const categoriasCompra = ['Compras', 'Lazer', 'Outros'];
    const limitesRelevantes = [];
    for (const lim of limites) {
      if (categoriasCompra.includes(lim.categoria)) {
        const info = await db.verificarLimite(usuarioId, lim.categoria);
        if (info) limitesRelevantes.push(info);
      }
    }

    const dadosFinanceiros = {
      saldoAtual: saldos.saldoAtual,
      despesasPendentes30d,
      receitasPendentes30d,
      proximaReceita,
      surplusMedio,
      disponivelConservador,
      disponivelPrevisto,
      limites: limitesRelevantes,
    };

    const analise = await analisarViabilidadeCompra(
      dadosFinanceiros, valorCompra, descricao || 'item', parcelasSolicitadas || null
    );

    return analise || '❌ Não consegui analisar agora. Tente novamente em instantes!';
  } catch (err) {
    console.error('[ASSESSOR_COMPRA] Erro:', err.message);
    return '❌ Ocorreu um erro ao analisar sua compra. Tente novamente!';
  }
}

module.exports = { handleMessage, handleImageMessage, handleCSVImport, handleLocationMessage, handleContatoCompartilhado, handleAnaliseFinanceiraCSV, obterAnaliseFinanceira, mensagemBoasVindas, mensagemConviteCompartilhado, registrarLembreteAtivo, setOnboardingState, mensagemApresentacao, mensagemPerguntaNome };
