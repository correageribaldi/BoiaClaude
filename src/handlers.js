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
      if (diaAlvo <= diaH) {
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

  // "semana que vem" / "proxima semana" → próxima segunda-feira
  if (v === 'semana que vem' || v === 'proxima semana') {
    const diaAtual = hoje.getDay(); // 0=dom, 1=seg
    let diff = 1 - diaAtual; // dias até segunda
    if (diff <= 0) diff += 7;
    const d = new Date(hoje);
    d.setDate(d.getDate() + diff);
    return dateParaISO(d);
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

// Estado temporário para confirmações pendentes (expira em 15 min)
const confirmacoesPendentes = new Map();

// Estado para transações com dados incompletos (expira em 15 min)
const transacaoPendente = new Map();

// Estado para excluir por nome aguardando seleção (expira em 15 min)
const excluirPendentes = new Map();
function salvarExcluirPendente(usuarioId, dados) {
  excluirPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterExcluirPendente(usuarioId) {
  const dados = excluirPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { excluirPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparExcluirPendente(usuarioId) { excluirPendentes.delete(usuarioId); }

// Estado para remover cartão aguardando seleção (expira em 15 min)
const removerCartaoPendentes = new Map();
function salvarRemoverCartaoPendente(usuarioId, dados) {
  removerCartaoPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterRemoverCartaoPendente(usuarioId) {
  const dados = removerCartaoPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { removerCartaoPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparRemoverCartaoPendente(usuarioId) { removerCartaoPendentes.delete(usuarioId); }

// Estado para editar transação (fluxo multi-turn, expira em 15 min)
const editarTxPendentes = new Map();
function salvarEditarTxPendente(usuarioId, dados) {
  editarTxPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarTxPendente(usuarioId) {
  const dados = editarTxPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarTxPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarTxPendente(usuarioId) { editarTxPendentes.delete(usuarioId); }

// Estado para confirmar edição de recorrência (após editar transação vinculada)
const editarRecPendentes = new Map();
function salvarEditarRecPendente(usuarioId, dados) {
  editarRecPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 5 * 60 * 1000 });
}
function obterEditarRecPendente(usuarioId) {
  const dados = editarRecPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarRecPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarRecPendente(usuarioId) { editarRecPendentes.delete(usuarioId); }

// Estado para editar recorrência diretamente (fluxo multi-turn)
const editarRecDiretoPendentes = new Map();
function salvarEditarRecDiretoPendente(usuarioId, dados) {
  editarRecDiretoPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarRecDiretoPendente(usuarioId) {
  const dados = editarRecDiretoPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarRecDiretoPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarRecDiretoPendente(usuarioId) { editarRecDiretoPendentes.delete(usuarioId); }

// Estado para editar cartão (fluxo multi-turn)
const editarCartaoPendentes = new Map();
function salvarEditarCartaoPendente(usuarioId, dados) {
  editarCartaoPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarCartaoPendente(usuarioId) {
  const dados = editarCartaoPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarCartaoPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarCartaoPendente(usuarioId) { editarCartaoPendentes.delete(usuarioId); }

// Estado para editar/excluir caixinha (fluxo multi-turn)
const editarCaixinhaPendentes = new Map();
function salvarEditarCaixinhaPendente(usuarioId, dados) {
  editarCaixinhaPendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarCaixinhaPendente(usuarioId) {
  const dados = editarCaixinhaPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarCaixinhaPendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarCaixinhaPendente(usuarioId) { editarCaixinhaPendentes.delete(usuarioId); }

// Estado para editar limite (fluxo multi-turn)
const editarLimitePendentes = new Map();
function salvarEditarLimitePendente(usuarioId, dados) {
  editarLimitePendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarLimitePendente(usuarioId) {
  const dados = editarLimitePendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarLimitePendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarLimitePendente(usuarioId) { editarLimitePendentes.delete(usuarioId); }

// Estado para editar lembrete (fluxo multi-turn)
const editarLembretePendentes = new Map();
function salvarEditarLembretePendente(usuarioId, dados) {
  editarLembretePendentes.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}
function obterEditarLembretePendente(usuarioId) {
  const dados = editarLembretePendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { editarLembretePendentes.delete(usuarioId); return null; }
  return dados;
}
function limparEditarLembretePendente(usuarioId) { editarLembretePendentes.delete(usuarioId); }

function salvarTransacaoPendente(usuarioId, dados) {
  transacaoPendente.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 15 * 60 * 1000,
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

// Estado para múltiplas transações com campos incompletos (expira em 15 min)
const transacoesMultiplasPendentes = new Map();

function salvarTransacoesMultiplasPendentes(usuarioId, dados) {
  transacoesMultiplasPendentes.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 15 * 60 * 1000,
  });
}

function obterTransacoesMultiplasPendentes(usuarioId) {
  const dados = transacoesMultiplasPendentes.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) {
    transacoesMultiplasPendentes.delete(usuarioId);
    return null;
  }
  return dados;
}

function limparTransacoesMultiplasPendentes(usuarioId) {
  transacoesMultiplasPendentes.delete(usuarioId);
}

// Estado do assessor de compra aguardando valor (expira em 15 min)
const assessorCompraPendenteMap = new Map();

function salvarAssessorCompra(usuarioId, dados) {
  assessorCompraPendenteMap.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
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

// Estado para recorrência aguardando dia do mês (expira em 15 min)
const recorrenciaDiaPendente = new Map();

function salvarRecorrenciaDiaPendente(usuarioId, dados) {
  recorrenciaDiaPendente.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}

function obterRecorrenciaDiaPendente(usuarioId) {
  const dados = recorrenciaDiaPendente.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { recorrenciaDiaPendente.delete(usuarioId); return null; }
  return dados;
}

function limparRecorrenciaDiaPendente(usuarioId) { recorrenciaDiaPendente.delete(usuarioId); }

// Estado para recorrência aguardando valor (expira em 15 min)
const recorrenciaValorPendente = new Map();

function salvarRecorrenciaValorPendente(usuarioId, dados) {
  recorrenciaValorPendente.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
}

function obterRecorrenciaValorPendente(usuarioId) {
  const dados = recorrenciaValorPendente.get(usuarioId);
  if (!dados) return null;
  if (Date.now() > dados.expiraEm) { recorrenciaValorPendente.delete(usuarioId); return null; }
  return dados;
}

function limparRecorrenciaValorPendente(usuarioId) { recorrenciaValorPendente.delete(usuarioId); }

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

// Lembretes aguardando horário (expira em 15 min)
const lembretesPendentes = new Map();

function salvarLembretePendente(usuarioId, dados) {
  lembretesPendentes.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 15 * 60 * 1000,
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
  'Despesas Fixas': [],
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

// Auto-criar subcategoria vinculada se a IA usou uma categoria nova
async function garantirSubcategoriaVinculada(usuarioId, categoria) {
  if (!categoria) return;
  const budgetCat = await resolverBudgetCategoria(categoria);
  if (budgetCat && budgetCat !== categoria) {
    await db.garantirSubcategoria(usuarioId, categoria, budgetCat);
  }
}

// Verificar limites e retornar bloco de texto (subcategoria + principal)
async function verificarLimitesTransacao(usuarioId, categoria) {
  if (!categoria) return '';
  let msg = '';

  // 1. Limite da subcategoria individual
  const limiteSubInfo = await db.verificarLimiteSub(usuarioId, categoria);
  if (limiteSubInfo) msg += formatarBlocoLimite(limiteSubInfo, categoria, categoria);

  // 2. Limite da categoria principal (bucket)
  const budgetCat = await resolverBudgetCategoria(categoria);
  if (budgetCat) {
    // Buscar todas as subcategorias da principal
    const limites = await db.listarLimites(usuarioId);
    const subcats = limites
      .filter(l => l.parent === budgetCat)
      .map(l => l.categoria);
    if (!subcats.includes(categoria)) subcats.push(categoria);
    const limiteInfo = await db.verificarLimite(usuarioId, budgetCat, subcats);
    if (limiteInfo) msg += formatarBlocoLimite(limiteInfo, categoria, budgetCat);
  }

  return msg;
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
    expiraEm: Date.now() + 15 * 60 * 1000,
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

// Estado para remoção de contato compartilhado por seleção (expira em 15 min)
const removerContatoPendente = new Map();

function salvarRemocaoContatoPendente(usuarioId, dados) {
  removerContatoPendente.set(usuarioId, {
    ...dados,
    expiraEm: Date.now() + 15 * 60 * 1000,
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
    `Olá, que bom que você está aqui! 👋\n\n` +
    `> Eu sou o *Cronos!*\n\n` +
    `A partir de agora eu vou te ajudar a ter o *controle de verdade* das suas finanças e muito mais!\n\n` +
    `Agora me diz uma coisa…\n\n` +
    `_Como você prefere que eu te chame?_`
  );
}

function mensagemPerguntaNome() {
  return mensagemApresentacao();
}

async function handleOnboardingNome(usuarioId, texto) {
  if (!texto.trim() || texto.trim().length < 1) {
    return `Me diz como quer ser chamado(a)! Pode ser seu nome, apelido… até _"Imperador do Cosmos"_ eu aceito 👑`;
  }

  const nome = await extrairNomeOnboarding(texto.trim());
  if (!nome || nome.length < 1 || nome.length > 50) {
    return `Hmm, isso não parece um nome 😅\n\nComo você quer ser chamado(a)? Pode ser seu nome, apelido ou até _"Imperador do Cosmos"_ 👑\n\n_Ex: "João", "Ana", "meu rei", "chefe"_`;
  }

  await db.atualizarNomeUsuario(usuarioId, nome);
  setOnboardingState(usuarioId, 'confirmando_nome');

  return { msg: `Perfeito, a partir de agora eu vou te chamar de *${nome}*, tudo bem?🙏🏼\n\n> _Se quiser alterar ou corrijir, é só mandar o novo nome ou manda um ok que a gente continua!_`, semCitacao: true };
}

async function handleConfirmacaoNome(usuarioId, texto) {
  const lower = texto.trim().toLowerCase();
  const normalizado = normalizarTexto(lower);

  // Confirmação: ok, sim, tudo bem, ta certo, isso, beleza, etc.
  const CONFIRMA = ['ok', 'okay', 'sim', 'tudo bem', 'ta certo', 'ta bom', 'certo', 'isso', 'beleza', 'blz', 'pode ser', 'perfeito', 'bora', 'vamos', 'continua', 'seguir', 'confirmo', 'confirmado', 'show', 'top', 'massa', 'dale', 'feito'];
  if (CONFIRMA.includes(normalizado)) {
    const usuario = await db.buscarUsuario(usuarioId);
    const nome = usuario?.nome || 'amigo(a)';
    setOnboardingState(usuarioId, 'aguardando_inicio');
    return mensagensEscolhaInicio(nome);
  }

  // Caso contrário, é um novo nome — atualizar
  return await handleOnboardingNome(usuarioId, texto);
}

function mensagensEscolhaInicio(nome) {
  return [
    { msg: `Certo, *${nome}!* 😊\n\n` +
      `Agora me diz...\n` +
      `Como você prefere começar?\n\n` +
      `🎯 *Organizar agora!*\n\n` +
      `Eu faço algumas perguntas rápidas e você ja consegue ter uma visão clara das suas finanças\n\n` +
      `> 🧮 Depois te entrego um panorama geral deste mês e você pode ir registrando tudo no dia a dia\n` +
      `*Recomendo esta opção* \n\n` +
      `Ou...`, semCitacao: true },
    { msg: `📝 *Dia a dia*\n\n` +
      `Você vai me dizendo o que recebeu e gastou durante o dia e no decorrer do mês registramos suas receitas e despesas fixas pra ter uma visão das suas finanças\n\n` +
      `> 👉 Recomendo organizar tudo agora pra você já ter uma visão clara ainda esse mês. 💪`, semCitacao: true }
  ];
}

async function handleTrocaNome(usuarioId, texto, retornarA = null) {
  const nome = await extrairNomeOnboarding(texto.trim());
  if (!nome || nome.length < 1 || nome.length > 50) {
    return `Hmm, isso não parece um nome 😅\n\nComo quer ser chamado(a)? Pode ser seu nome, apelido ou até _"Chefe Supremo"_ 👑\n\n_Ex: "João", "Ana", "meu rei"_`;
  }
  await db.atualizarNomeUsuario(usuarioId, nome);

  if (retornarA === 'aguardando_inicio') {
    setOnboardingState(usuarioId, 'aguardando_inicio');
    return mensagensEscolhaInicio(nome);
  }

  setOnboardingState(usuarioId, null);
  return `Feito! A partir de agora te chamo de *${nome}* 😊`;
}

async function handleOnboardingInicio(usuarioId, texto) {
  const lower = texto.toLowerCase().trim();

  const querOrganizar = /organizar|agora|tudo|^1$|🎯/.test(lower);
  const querPoucos   = /dia a dia|dia dia|dia|poucos|gradual|^2$|📝|cadastrando/.test(lower);

  if (querOrganizar && !querPoucos) {
    setOnboardingState(usuarioId, null);
    return await iniciarPontoZero(usuarioId);
  }

  if (querPoucos && !querOrganizar) {
    setOnboardingState(usuarioId, null);
    return { msg: (
      `Ótimo! É bem simples. 😊\n\n` +
      `É só me contar o que você gastou ou recebeu, assim:\n\n` +
      `_"gastei 50 de gasolina"_\n` +
      `_"paguei 150 de conta de luz"_\n` +
      `_"recebi 2000 de salário"_\n` +
      `_"comprei R$ 80 no mercado"_\n\n` +
      `Pode mandar por texto, áudio ou foto de nota/boleto — eu registro e organizo tudo pra você!`
    ), semCitacao: true };
  }

  // Não entendeu — perguntar de forma reduzida
  const usuario = await db.buscarUsuario(usuarioId);
  const nome = usuario?.nome || 'amigo(a)';
  setOnboardingState(usuarioId, 'aguardando_inicio');
  return { msg: (
    `*${nome}* escolha uma dessas opções!\n\n` +
    `Diga:\n` +
    `1. *Organizar agora*\n` +
    `2. *Dia a dia*\n\n` +
    `> Você pode me mandar por áudio, se quiser, também! 🎤`
  ), semCitacao: true };
}

// Estado de cadastro do painel web (aguardando usuário/senha) — expira em 15 min
const cadastroPainelEstados = new Map();

function salvarCadastroPainel(usuarioId, dados) {
  cadastroPainelEstados.set(usuarioId, { ...dados, expiraEm: Date.now() + 15 * 60 * 1000 });
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

  // "últimos X dias" / "ultimos X dias"
  const mUltimosDias = t.match(/ultimos?\s+(\d+)\s+dias?/);
  if (mUltimosDias) {
    const n = parseInt(mUltimosDias[1], 10);
    if (n > 0 && n <= 365) {
      const hojeISO = dateParaISO(new Date());
      const [ano, mes, dia] = hojeISO.split('-').map(Number);
      const hoje = new Date(ano, mes - 1, dia, 12, 0, 0);
      const inicio = new Date(hoje);
      inicio.setDate(inicio.getDate() - n);
      return { dataInicio: dateParaISO(inicio), dataFim: hojeISO, rotulo: `ultimos ${n} dias`, dataUnica: false };
    }
  }

  // Nome de mês por extenso ("março", "abril 2026", etc.)
  const MESES_NOME = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
  const nomeMes = Object.keys(MESES_NOME).find(n => t.includes(n));
  if (nomeMes) {
    const mesNum = MESES_NOME[nomeMes];
    const anoMatch = t.match(/\b(20\d{2})\b/);
    const hoje = new Date();
    let anoNum;
    if (anoMatch) {
      anoNum = parseInt(anoMatch[1]);
    } else {
      anoNum = mesNum < (hoje.getMonth() + 1) ? hoje.getFullYear() + 1 : hoje.getFullYear();
    }
    const mesStr = String(mesNum).padStart(2, '0');
    const ultimoDia = new Date(anoNum, mesNum, 0).getDate();
    return { dataInicio: `${anoNum}-${mesStr}-01`, dataFim: `${anoNum}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`, rotulo: `${nomeMes} ${anoNum}`, dataUnica: false, mes: mesNum, ano: anoNum };
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
  const nomeExibir = nome || 'amigo(a)';
  return `${nomeExibir}, todo mundo erra, e dessa vez fui eu 😅
Não consegui entender o que você me pediu. Tenta assim:

💸 *Cadastrar despesa:* _"gastei 50 no mercado"_
💰 *Cadastrar receita:* _"recebi 3000 de salário"_
📊 *Consultar:* _"quanto gastei esse mês?"_
⏰ *Lembrete:* _"me lembre de pagar o boleto amanhã"_
🔍 *Pesquisar:* _"restaurantes em Porto Alegre"_
🧠 *Calcular:* _"quanto é 1500 + 800?"_

Pode mandar por texto, áudio ou foto! 📸`;
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

// tentarConfirmacaoPorDB REMOVIDO — confirmação de pagamento agora é feita
// exclusivamente via fluxo fechado com estado (handleConfirmacaoLembrete)

// Extrai números de respostas como "paguei 1, 4 e 6" ou "1 e 3" ou "a 2"
function extrairNumerosResposta(texto) {
  const nums = texto.match(/\d+/g);
  if (!nums) return [];
  return nums.map(n => parseInt(n, 10)).filter(n => n > 0);
}

// Busca transações por descrição na lista de pendentes
function buscarPorDescricao(texto, transacoesInfo) {
  const lower = texto.toLowerCase();
  return transacoesInfo.filter(t => {
    const desc = t.descricao.toLowerCase();
    return lower.includes(desc) || desc.split(/\s+/).some(p => p.length > 3 && lower.includes(p));
  });
}

// Marca transações como pagas e retorna resultado com info de caixinhas
async function liquidarTransacoes(usuarioId, ids) {
  const pagas = [];
  const caixinhasAtualizadas = [];
  for (const id of ids) {
    try {
      const result = await db.liquidarTransacaoPorId(id);
      if (result) {
        pagas.push(result);
        const matchAporte = result.descricao?.match(/^Aporte\s*-\s*(.+)$/i);
        if (matchAporte && result.categoria === 'Investimentos') {
          const nomeCaixinha = matchAporte[1].trim();
          const caixinhas = await db.buscarCaixinhasPorNome(usuarioId, nomeCaixinha);
          if (caixinhas.length > 0) {
            const atualizada = await db.adicionarSaldoCaixinha(caixinhas[0].id, result.valor);
            caixinhasAtualizadas.push({ nome: nomeCaixinha, novoSaldo: atualizada.saldo, valor: result.valor });
          }
        }
      }
    } catch (err) {
      console.error(`[CONFIRMACAO_LEMBRETE] Erro ao liquidar transacao ${id}:`, err.message);
    }
  }
  return { pagas, caixinhasAtualizadas };
}

// Formata mensagem de confirmação de pagamento
function formatarRespostaLiquidacao(pagas, pendentes, caixinhasAtualizadas) {
  let resposta;
  if (pagas.length === 1) {
    const t = pagas[0];
    const acao = t.tipo === 'despesa' ? 'paga' : 'recebida';
    resposta = `✅ *${t.descricao}* marcada como ${acao}! 🎉`;
  } else {
    const lista = pagas.map(t => `  • *${t.descricao}* (${fmt.formatarMoeda(t.valor)})`).join('\n');
    resposta = `✅ *${pagas.length} contas* marcadas como pagas:\n${lista}`;
  }

  if (caixinhasAtualizadas.length > 0) {
    resposta += '\n\n' + caixinhasAtualizadas
      .map(c => `💰 *${c.nome}*: +${fmt.formatarMoeda(c.valor)} → *${fmt.formatarMoeda(c.novoSaldo)}*`)
      .join('\n');
  }

  if (pendentes.length > 0) {
    const listaPend = pendentes.map(t => `  • *${t.descricao}* (${fmt.formatarMoeda(t.valor)})`).join('\n');
    resposta += `\n\n⏳ Ficaram pendentes:\n${listaPend}\n\n_Te lembro de novo mais tarde!_`;
  }

  return resposta;
}

// Gera mensagem de ajuda do fluxo de confirmação
function gerarAjudaConfirmacao(transacoesInfo) {
  const lista = transacoesInfo.map((t, i) =>
    `  ${i + 1}. ${t.tipo === 'despesa' ? '🔴' : '🟢'} *${t.descricao}* (${fmt.formatarMoeda(t.valor)})`
  ).join('\n');
  return `Não entendi 🤔 Preciso saber sobre suas contas pendentes:\n\n${lista}\n\n` +
    `Responda:\n` +
    `• *"sim"* ou *"paguei tudo"* — se pagou todas\n` +
    `• *"não"* ou *"ainda não"* — se não pagou nenhuma\n` +
    `• *"paguei 1 e 3"* — para especificar quais pagou`;
}

async function handleConfirmacaoLembrete(usuarioId, lower, estado) {
  const normalizado = normalizarTexto(lower);
  const { transacaoIds, transacoesInfo } = estado;

  // 1. Confirmar TUDO
  const CONFIRMA_TUDO = ['sim', 'paguei', 'paguei tudo', 'ja paguei', 'ja paguei', 'pago', 'ja pago', 'ja pago', 'tudo pago', 'tudo certo', 'confirmado', 'recebi tudo', 'ja recebi', 'ja recebi', 'recebido', 'foi', 'pronto', 'feito', 'ok', 'okay', 'realizado', 'efetuado'];
  if (CONFIRMA_TUDO.includes(normalizado)) {
    limparConfirmacaoLembrete(usuarioId);
    const { pagas, caixinhasAtualizadas } = await liquidarTransacoes(usuarioId, transacaoIds);
    if (pagas.length === 0) return `✅ Essas transações já estão marcadas como pagas. Tudo certo!`;
    return formatarRespostaLiquidacao(pagas, [], caixinhasAtualizadas);
  }

  // 2. Negar TUDO
  const NEGA_TUDO = ['nao', 'ainda nao', 'nenhuma', 'nao paguei', 'nao recebi'];
  if (NEGA_TUDO.includes(normalizado)) {
    limparConfirmacaoLembrete(usuarioId);
    return '👍 Beleza, vou te lembrar de novo mais tarde!';
  }

  // 3. Especificar por NÚMERO: "paguei 1, 4 e 6", "1 e 3", "a 2"
  const numeros = extrairNumerosResposta(lower);
  if (numeros.length > 0) {
    const idsParaLiquidar = [];
    const infoPagas = [];
    const infoPendentes = [];
    for (let i = 0; i < transacoesInfo.length; i++) {
      if (numeros.includes(i + 1)) {
        idsParaLiquidar.push(transacaoIds[i]);
        infoPagas.push(transacoesInfo[i]);
      } else {
        infoPendentes.push(transacoesInfo[i]);
      }
    }
    if (idsParaLiquidar.length === 0) return gerarAjudaConfirmacao(transacoesInfo);
    limparConfirmacaoLembrete(usuarioId);
    const { pagas, caixinhasAtualizadas } = await liquidarTransacoes(usuarioId, idsParaLiquidar);
    if (pagas.length === 0) return `✅ Essas transações já estão marcadas como pagas. Tudo certo!`;
    return formatarRespostaLiquidacao(pagas, infoPendentes, caixinhasAtualizadas);
  }

  // 4. Especificar por NOME: "paguei aluguel e gás"
  const encontradas = buscarPorDescricao(lower, transacoesInfo);
  if (encontradas.length > 0) {
    const idsEncontrados = new Set(encontradas.map(t => t.id));
    const idsParaLiquidar = [];
    const infoPendentes = [];
    for (let i = 0; i < transacoesInfo.length; i++) {
      if (idsEncontrados.has(transacoesInfo[i].id)) {
        idsParaLiquidar.push(transacaoIds[i]);
      } else {
        infoPendentes.push(transacoesInfo[i]);
      }
    }
    limparConfirmacaoLembrete(usuarioId);
    const { pagas, caixinhasAtualizadas } = await liquidarTransacoes(usuarioId, idsParaLiquidar);
    if (pagas.length === 0) return `✅ Essas transações já estão marcadas como pagas. Tudo certo!`;
    return formatarRespostaLiquidacao(pagas, infoPendentes, caixinhasAtualizadas);
  }

  // 5. Não entendeu — fica preso no fluxo
  return gerarAjudaConfirmacao(transacoesInfo);
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
  if (estadoOnboarding === 'confirmando_nome') {
    return await handleConfirmacaoNome(usuarioId, msg);
  }
  if (estadoOnboarding === 'trocando_nome') {
    return await handleTrocaNome(usuarioId, msg);
  }
  if (estadoOnboarding === 'trocando_nome_from_inicio') {
    return await handleTrocaNome(usuarioId, msg, 'aguardando_inicio');
  }

  // Detecção de intenção de trocar nome — antes de qualquer fluxo ativo (inclusive aguardando_inicio)
  {
    const lowerNorm = normalizarTextoBusca(lower);
    // Só dispara se o usuário mencionar explicitamente "meu nome" ou frases pessoais
    const matchTrocaNome =
      /\bmeu\s+nome\b/.test(lowerNorm) ||
      /\bnome\s+do\s+meu\s+(usuario|perfil|conta)\b/.test(lowerNorm) ||
      /\bquero me chamar\b|\bme chama de\b|\bme chamem de\b/.test(lowerNorm);
    if (matchTrocaNome) {
      // Determina para onde voltar após a troca
      const retornarA = estadoOnboarding === 'aguardando_inicio' ? 'aguardando_inicio' : null;
      const matchPara = lower.match(/(?:para|pra|como|ser?ia)\s+(.+)$/i);
      if (matchPara) {
        const nomeCandidato = matchPara[1].trim().replace(/[.,!?]+$/, '');
        return await handleTrocaNome(usuarioId, nomeCandidato, retornarA);
      }
      // Sem nome na mensagem: pede e guarda o estado de origem
      setOnboardingState(usuarioId, retornarA === 'aguardando_inicio' ? 'trocando_nome_from_inicio' : 'trocando_nome');
      return `Claro! Como você quer ser chamado(a)?\n\n_Ex: "João", "Ana", "chefe", "meu rei"_`;
    }
  }

  if (estadoOnboarding === 'aguardando_inicio') {
    return await handleOnboardingInicio(usuarioId, msg);
  }

  // Verificar se está no fluxo Finanças em Dia — posição #2 para bloquear todos os outros estados
  const pontoZero = await obterPontoZero(usuarioId);
  if (pontoZero) {
    return await handlePontoZero(usuarioId, msg, pontoZero);
  }

  // Verificar se há feedback pendente para este usuário
  const feedbackPendente = await db.buscarFeedbackPendente(usuarioId);
  if (feedbackPendente) {
    await db.registrarRespostaFeedback(usuarioId, msg.trim());
    return '🙏 Muito obrigado pelo seu feedback! Sua opinião é muito importante para melhorarmos o Cronos.\n\nSe tiver mais alguma sugestão, é só mandar a qualquer momento!';
  }

  // Verificar se está no fluxo de cadastro do painel web
  const cadastroPainel = obterCadastroPainel(usuarioId);
  if (cadastroPainel) {
    const resposta = await handleCadastroPainel(usuarioId, msg, cadastroPainel);
    if (resposta !== null) return resposta;
  }

  // Verificar se há confirmação de lembrete financeiro pendente
  // Fluxo fechado: se há lembrete ativo, o usuário fica preso até resolver
  const confLembrete = obterConfirmacaoLembrete(usuarioId);
  if (confLembrete) {
    return await handleConfirmacaoLembrete(usuarioId, lower, confLembrete);
  }

  // Verificar se há múltiplas transações com dados incompletos
  const multiPendente = obterTransacoesMultiplasPendentes(usuarioId);
  if (multiPendente) {
    return await handleMultiplasPendentesResposta(usuarioId, msg, multiPendente);
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

  // Verificar se há seleção pendente para excluir por nome
  const excluirPend = obterExcluirPendente(usuarioId);
  if (excluirPend) {
    return await handleEscolhaExcluir(usuarioId, msg, excluirPend);
  }

  // Verificar se há edição de transação em andamento
  const editarTxPend = obterEditarTxPendente(usuarioId);
  if (editarTxPend) {
    const resposta = await handleEditarTxPendente(usuarioId, msg, editarTxPend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há confirmação pendente de edição de recorrência (sim/não)
  const editarRecPend = obterEditarRecPendente(usuarioId);
  if (editarRecPend) {
    const resposta = await handleEditarRecPendente(usuarioId, msg, editarRecPend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há edição de recorrência em andamento (fluxo multi-turn)
  const editarRecDiretoPend = obterEditarRecDiretoPendente(usuarioId);
  if (editarRecDiretoPend) {
    const resposta = await handleEditarRecDiretoPendente(usuarioId, msg, editarRecDiretoPend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há edição de cartão em andamento
  const editarCartaoPend = obterEditarCartaoPendente(usuarioId);
  if (editarCartaoPend) {
    const resposta = await handleEditarCartaoPendente(usuarioId, msg, editarCartaoPend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há edição/exclusão de caixinha em andamento
  const editarCaixinhaPend = obterEditarCaixinhaPendente(usuarioId);
  if (editarCaixinhaPend) {
    const resposta = await handleEditarCaixinhaPendente(usuarioId, msg, editarCaixinhaPend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há edição de limite em andamento
  const editarLimitePend = obterEditarLimitePendente(usuarioId);
  if (editarLimitePend) {
    const resposta = await handleEditarLimitePendente(usuarioId, msg, editarLimitePend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há edição de lembrete em andamento
  const editarLembretePend = obterEditarLembretePendente(usuarioId);
  if (editarLembretePend) {
    const resposta = await handleEditarLembretePendente(usuarioId, msg, editarLembretePend);
    if (resposta !== null) return resposta;
  }

  // Verificar se há seleção pendente para remover contato compartilhado
  const remocaoContato = obterRemocaoContatoPendente(usuarioId);
  if (remocaoContato) {
    return await handleEscolhaRemocaoContato(usuarioId, msg, remocaoContato);
  }

  // Verificar se há seleção pendente para remover cartão
  const removerCartaoPend = obterRemoverCartaoPendente(usuarioId);
  if (removerCartaoPend) {
    return await handleEscolhaRemoverCartao(usuarioId, msg, removerCartaoPend);
  }

  // Verificar se tem lembrete aguardando horário
  const lembretePend = obterLembretePendente(usuarioId);
  if (lembretePend) {
    return await handleLembreteHorario(usuarioId, msg, lembretePend);
  }

  // Verificar se há recorrência aguardando valor
  const recValorPend = obterRecorrenciaValorPendente(usuarioId);
  if (recValorPend) {
    return await handleRecorrenciaValorResposta(usuarioId, msg, recValorPend);
  }

  // Verificar se há recorrência aguardando dia do mês
  const recPend = obterRecorrenciaDiaPendente(usuarioId);
  if (recPend) {
    return await handleRecorrenciaDiaResposta(usuarioId, msg, recPend);
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
    return { msg: ajudaMsg(), semCitacao: true };
  }

  // Comando: categorias
  if (lower === 'categorias') {
    const catsPrincipais = await db.listarCategoriasPrincipais(usuarioId);
    if (catsPrincipais.length === 0) {
      return '📂 Nenhuma categoria principal definida. Use o *Finanças em Dia* para configurar.';
    }
    const limites = await db.listarLimites(usuarioId);
    const subMap = {};
    for (const l of limites) {
      if (l.parent) {
        if (!subMap[l.parent]) subMap[l.parent] = [];
        subMap[l.parent].push(l.categoria);
      }
    }
    let msg = '📂 *Categorias e Subcategorias:*\n\n';
    for (const cp of catsPrincipais) {
      msg += `📁 *${cp.nome}* (${cp.percentual}%)\n`;
      const subs = subMap[cp.nome] || [];
      if (subs.length > 0) {
        for (const s of subs) msg += `   • ${s}\n`;
      } else {
        msg += `   _Nenhuma subcategoria_\n`;
      }
      msg += '\n';
    }
    return msg;
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

  // Comando: despesas / receitas (atalho para lista filtrada)
  if (lower === 'despesas' || lower === 'minhas despesas') {
    return await handleLista(usuarioId, 'lista despesas');
  }
  if (lower === 'receitas' || lower === 'minhas receitas') {
    return await handleLista(usuarioId, 'lista receitas');
  }

  // Comando: lista (transações financeiras - despesas/receitas)
  if (lower.startsWith('lista')) {
    return await handleLista(usuarioId, msg);
  }

  // Comando: editar cartão de crédito
  if (/^(?:editar|alterar|mudar)\s+cart[aã]o/i.test(lower)) {
    const resto = lower
      .replace(/^(?:editar|alterar|mudar)\s+/, '')
      .replace(/^cart[aã]o\s*(?:de\s+cr[eé]dito)?\s*/, '')
      .trim();
    return await handleEditarCartao(usuarioId, { cartao_nome: resto || null, campo: null, novo_valor: null });
  }

  // Comando: editar/excluir caixinha
  if (/^(?:editar|alterar|mudar)\s+(?:caixinha|investimento)/i.test(lower)) {
    const resto = lower
      .replace(/^(?:editar|alterar|mudar)\s+/, '')
      .replace(/^(?:caixinha|investimento)\s*/, '')
      .trim();
    return await handleEditarCaixinha(usuarioId, { nome: resto || null, campo: null, novo_valor: null });
  }
  if (/^(?:excluir|remover|deletar|apagar)\s+(?:caixinha|investimento)/i.test(lower)) {
    const resto = lower
      .replace(/^(?:excluir|remover|deletar|apagar)\s+/, '')
      .replace(/^(?:caixinha|investimento)\s*/, '')
      .trim();
    return await handleExcluirCaixinha(usuarioId, { nome: resto || null });
  }

  // Comando: editar limite
  if (/^(?:editar|alterar|mudar)\s+limite/i.test(lower)) {
    const resto = lower
      .replace(/^(?:editar|alterar|mudar)\s+/, '')
      .replace(/^limite\s*(?:de\s+(?:gastos?|categoria))?\s*/, '')
      .trim();
    return await handleEditarLimite(usuarioId, { categoria: resto || null, novo_valor: null });
  }

  // Comando: editar lembrete
  if (/^(?:editar|alterar|mudar)\s+lembrete/i.test(lower)) {
    const tipoLembrete = lower.includes('recorrente') ? 'recorrente' : null;
    return await handleEditarLembrete(usuarioId, { tipo_lembrete: tipoLembrete });
  }

  // Comando: excluir cartão de crédito (redirecionar para remover cartão)
  if (/^(?:excluir|remover|deletar|apagar)\s+cart[aã]o/i.test(lower)) {
    // Remove o verbo e "cartão de crédito" / "cartão" para extrair o nome real do cartão
    const resto = lower
      .replace(/^(?:excluir|remover|deletar|apagar)\s+/, '')
      .replace(/^cart[aã]o\s*(?:de\s+cr[eé]dito)?\s*/, '')
      .trim();
    const cartao_nome = resto || null;
    return await handleRemoverCartao(usuarioId, { cartao_nome });
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
  if (lower === 'pendentes' || lower === 'a pagar' || lower === 'contas' || lower === 'a receber') {
    const tipoPendente = lower === 'a pagar' ? 'despesa' : lower === 'a receber' ? 'receita' : null;
    const pendentes = await db.listarPendentes(usuarioId, tipoPendente);
    return fmt.formatarPendentes(pendentes);
  }

  // Comando: pagar / liquidar / receber / recebi — DESATIVADO
  // Roteamento direto para handleLiquidar causava conflito com registro de receitas/despesas
  // Ex: "recebi 80 freela" era interpretado como ID de lançamento em vez de ir para a IA
  // if (lower.startsWith('pagar ') || lower.startsWith('liquidar ') || lower.startsWith('receber ') || lower.startsWith('recebi ')) {
  //   return await handleLiquidar(usuarioId, msg);
  // }

  // Cancelar/excluir lançamento por nome natural (antes da IA para evitar interpretação errada)
  // Ex: "cancelar despesa cadastrada com o nome de emprestimo" → excluir por nome
  {
    const matchCancelarTx = lower.match(/\b(cancelar?|excluir?|apagar?|remover?|deletar?)\s+(?:a\s+|o\s+)?(?:despesa|receita|lan[çc]amento|compra|registro|pagamento)\s+(?:cadastrad[ao]\s+)?(?:com\s+o\s+nome\s+(?:de|do|da)\s+|chamad[ao](?:\s+de)?\s+|de\s+)?(.+)/i);
    if (matchCancelarTx) {
      return await handleExcluir(usuarioId, `excluir ${matchCancelarTx[2].trim()}`);
    }
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

  // Tentar identificar subcategoria no final da linha
  const limites = await db.listarLimites(usuarioId);
  const subcats = limites.filter(l => l.parent).map(l => l.categoria);
  let categoria = null;

  const possivelCat = partes[fimDescricao - 1];
  const catEncontrada = subcats.find(c => c.toLowerCase() === possivelCat.toLowerCase());
  if (catEncontrada && fimDescricao > 3) {
    categoria = catEncontrada;
    fimDescricao--;
  }

  const descricao = partes.slice(2, fimDescricao).join(' ');
  if (!descricao) {
    return `❌ Informe uma descrição para o lançamento.`;
  }

  // Auto-criar subcategoria se necessária
  if (tipo === 'despesa' && categoria) await garantirSubcategoriaVinculada(usuarioId, categoria);

  const result = await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data);
  const emoji = tipo === 'receita' ? '✅💰' : '✅💸';
  const dataFormatada = data ? fmt.formatarData(data) : 'Hoje';

  return `${emoji} *${tipo.charAt(0).toUpperCase() + tipo.slice(1)} registrada!*\n\n` +
    `💵 Valor: ${fmt.formatarMoeda(valor)}\n` +
    `📝 Descrição: ${descricao}\n` +
    `📂 Categoria: ${categoria || 'Outros'}\n` +
    `📅 Data: ${dataFormatada}`;
}

async function handleResumo(usuarioId, msg) {
  const lower = msg.toLowerCase().trim();

  if (lower.startsWith('resumo anual')) {
    const partes = lower.split(/\s+/);
    const ano = partes[2] && /^\d{4}$/.test(partes[2]) ? parseInt(partes[2]) : undefined;
    const resumo = await db.resumoAnual(usuarioId, ano);
    return fmt.formatarResumoAnual(resumo);
  }

  // Usar o mesmo extrator de período que funciona no fluxo de lista/consulta
  let periodo = extrairPeriodoNaturalNoTexto(lower);

  // Fallback: formato numérico "resumo 3" ou "resumo 3/2026"
  if (!periodo) {
    const partes = lower.split(/\s+/);
    if (partes[1]) {
      const subPartes = partes[1].split('/');
      const mesNum = parseInt(subPartes[0]);
      if (!isNaN(mesNum) && mesNum >= 1 && mesNum <= 12) {
        const anoNum = subPartes[1] ? parseInt(subPartes[1]) : new Date().getFullYear();
        const mesStr = String(mesNum).padStart(2, '0');
        const ultimoDia = new Date(anoNum, mesNum, 0).getDate();
        periodo = {
          dataInicio: `${anoNum}-${mesStr}-01`,
          dataFim: `${anoNum}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`,
          rotulo: `${mesNum}/${anoNum}`,
        };
      }
    }
  }

  // Sem período detectado → mês atual
  if (!periodo) {
    const p = intervaloMes(0);
    const MESES = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
    const hoje = new Date();
    periodo = { ...p, rotulo: `${MESES[hoje.getMonth() + 1]}/${hoje.getFullYear()}` };
  }

  // Buscar usando os mesmos métodos que lista/consulta
  const filtros = {
    dataInicio: periodo.dataInicio,
    dataFim: periodo.dataFim,
  };

  const [transacoes, totaisReceita, totaisDespesa] = await Promise.all([
    db.consultarTransacoes(usuarioId, { ...filtros, limite: 50 }),
    db.consultarTotalTransacoes(usuarioId, { ...filtros, tipo: 'receita' }),
    db.consultarTotalTransacoes(usuarioId, { ...filtros, tipo: 'despesa' }),
  ]);

  const totalReceitas = totaisReceita.total || 0;
  const totalDespesas = totaisDespesa.total || 0;
  const saldo = totalReceitas - totalDespesas;

  if (totaisReceita.quantidade === 0 && totaisDespesa.quantidade === 0) {
    return `📊 *Resumo — ${periodo.rotulo}*\n\nNenhum lançamento encontrado neste período.`;
  }

  let msgTexto = `📊 *Resumo — ${periodo.rotulo}*\n\n`;
  msgTexto += `💰 *Receitas:* ${fmt.formatarMoeda(totalReceitas)} (${totaisReceita.quantidade} lanç.)\n`;
  msgTexto += `💸 *Despesas:* ${fmt.formatarMoeda(totalDespesas)} (${totaisDespesa.quantidade} lanç.)\n`;
  msgTexto += `━━━━━━━━━━━━━━━\n`;
  msgTexto += `${saldo >= 0 ? '✅' : '🔴'} *Saldo:* ${fmt.formatarMoeda(saldo)}\n`;

  if (transacoes.length > 0) {
    msgTexto += `\n📋 *Detalhes:*\n`;
    for (const t of transacoes.slice(0, 15)) {
      const emoji = t.tipo === 'receita' ? '🟢' : '🔴';
      const statusIcon = t.status === 'pendente' ? ' ⏳' : '';
      msgTexto += `${emoji} ${fmt.formatarData(t.data)} | ${fmt.formatarMoeda(t.valor)} | _${t.descricao}_ (${t.categoria})${statusIcon}\n`;
    }

    if (transacoes.length > 15) {
      msgTexto += `\n_... e mais ${transacoes.length - 15} lançamentos_`;
    }
  }

  return msgTexto;
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

  // Excluir por ID (comportamento original)
  if (id && !isNaN(id)) {
    const result = await db.excluirTransacao(usuarioId, id);
    if (result.changes === 0) {
      return `❌ Lançamento #${id} não encontrado.`;
    }
    return `🗑️ Lançamento #${id} excluído com sucesso!`;
  }

  // Excluir por nome/descrição
  const query = msg.replace(/^excluir\s*/i, '')
    .replace(/\b(receita|despesa|investimento|cartao|cartão|lancamento|lançamento)\b/gi, '')
    .trim();

  if (!query) {
    return `Qual lançamento quer excluir? Me diz o nome ou parte da descrição.\n\n_Ex: "excluir financiamento carro"_`;
  }

  return handleExcluirTxPorNome(usuarioId, query, null);
}

// Busca e inicia fluxo de exclusão por nome (chamado pela IA e pelo handleExcluir)
async function handleExcluirTxPorNome(usuarioId, descricaoBusca, tipo) {
  const transacoes = await db.buscarTransacoesPorDescricao(usuarioId, descricaoBusca, tipo);

  if (transacoes.length === 0) {
    const filtro = tipo ? ` do tipo "${tipo}"` : '';
    return `❌ Nenhum lançamento${filtro} encontrado com "${descricaoBusca}".\n\nTente _"lista"_ para ver todos os lançamentos.`;
  }

  if (transacoes.length === 1) {
    const t = transacoes[0];
    const emoji = t.tipo === 'receita' ? '💰' : '💸';
    salvarExcluirPendente(usuarioId, { aguardandoConfirmacao: true, transacao: t });
    return `Encontrei este lançamento:\n\n${emoji} *${t.descricao}* — ${fmt.formatarMoeda(t.valor)}\n📅 ${fmt.formatarData(t.data)} | ${t.categoria} | ${t.status === 'pendente' ? '⏳ pendente' : '✅ pago'}\n\nÉ esse que quer excluir? _(sim / não)_`;
  }

  // Múltiplos — pedir qual
  salvarExcluirPendente(usuarioId, { transacoes });
  const lista = transacoes.map((t, i) => {
    const emoji = t.tipo === 'receita' ? '💰' : '💸';
    return `  ${i + 1}. ${emoji} *${t.descricao}* — ${fmt.formatarMoeda(t.valor)} | ${fmt.formatarData(t.data)}`;
  }).join('\n');
  return `Encontrei ${transacoes.length} lançamentos com "${descricaoBusca}":\n\n${lista}\n\nQual deles quer excluir? Responda com o número ou _"cancelar"_.`;
}

async function handleEscolhaExcluir(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();

  // Modo: confirmação de item único
  if (pendente.aguardandoConfirmacao) {
    const cancelou = /^(n[aã]o|nope|cancelar?|não quero|errado|errei)$/i.test(lower);
    if (cancelou) {
      limparExcluirPendente(usuarioId);
      return '❌ Cancelado, nenhum lançamento excluído.';
    }
    const confirmou = PALAVRAS_PAGAMENTO_CONFIRMADO.some(p => lower === p || lower.startsWith(p + ' ')) ||
      /^(sim|s|é esse|esse mesmo|confirmar?|pode|ok|isso|correto|certo)$/i.test(lower);
    if (!confirmou) {
      return `Responda _"sim"_ para confirmar a exclusão ou _"não"_ para cancelar.`;
    }
    const t = pendente.transacao;
    limparExcluirPendente(usuarioId);
    await db.excluirTransacao(usuarioId, t.id);
    return `🗑️ *${t.descricao}* — ${fmt.formatarMoeda(t.valor)} excluído com sucesso!`;
  }

  // Modo: seleção de múltiplos
  if (lower === 'cancelar' || lower === 'não' || lower === 'nao') {
    limparExcluirPendente(usuarioId);
    return '❌ Cancelado.';
  }
  const num = parseInt(msg.trim());
  if (!num || isNaN(num) || num < 1 || num > pendente.transacoes.length) {
    return `Responda com um número de 1 a ${pendente.transacoes.length}, ou _"cancelar"_ para desistir.`;
  }
  const t = pendente.transacoes[num - 1];
  limparExcluirPendente(usuarioId);
  await db.excluirTransacao(usuarioId, t.id);
  return `🗑️ *${t.descricao}* — ${fmt.formatarMoeda(t.valor)} excluído com sucesso!`;
}

// ── Editar Transação ──────────────────────────────────────────────────────────

function resumoTransacaoEdit(t) {
  const emoji = t.tipo === 'receita' ? '💰' : '💸';
  return `${emoji} *${t.descricao}*\n` +
    `  💵 Valor: ${fmt.formatarMoeda(t.valor)}\n` +
    `  📅 Data: ${fmt.formatarData(t.data)}\n` +
    `  📂 Categoria: ${t.categoria}\n` +
    `  ${t.status === 'pendente' ? '⏳ Pendente' : '✅ Pago'}`;
}

async function handleEditarTxPorNome(usuarioId, resultado) {
  const { descricao_busca, tipo, campo, novo_valor } = resultado;
  if (!descricao_busca) {
    return `Qual lançamento quer editar? Me diz o nome.\n\n_Ex: "editar aluguel"_`;
  }

  const transacoes = await db.buscarTransacoesPorDescricao(usuarioId, descricao_busca, tipo || null);

  if (transacoes.length === 0) {
    const filtro = tipo ? ` do tipo "${tipo}"` : '';
    return `❌ Nenhum lançamento${filtro} encontrado com "${descricao_busca}".\n\nTente _"lista"_ para ver todos os lançamentos.`;
  }

  if (transacoes.length > 1) {
    // Múltiplos — pedir qual
    salvarEditarTxPendente(usuarioId, { fase: 'selecionar', transacoes, campo: campo || null, novo_valor: novo_valor || null });
    const lista = transacoes.map((t, i) => {
      const emoji = t.tipo === 'receita' ? '💰' : '💸';
      return `  ${i + 1}. ${emoji} *${t.descricao}* — ${fmt.formatarMoeda(t.valor)} | ${fmt.formatarData(t.data)}`;
    }).join('\n');
    return `Encontrei ${transacoes.length} lançamentos com "${descricao_busca}":\n\n${lista}\n\nQual deles quer editar? Responda com o número ou _"cancelar"_.`;
  }

  const t = transacoes[0];

  // Campo e valor já especificados → aplicar direto
  if (campo && novo_valor) {
    return aplicarEdicaoTx(usuarioId, t, campo, novo_valor);
  }

  // Campo especificado mas sem valor → pedir valor
  if (campo) {
    salvarEditarTxPendente(usuarioId, { fase: 'aguardando_valor', transacao: t, campo });
    const labelscampo = { valor: 'novo valor', data: 'nova data', descricao: 'nova descrição', categoria: 'nova categoria' };
    return `${resumoTransacaoEdit(t)}\n\nQual o ${labelscampo[campo] || campo}?\n_Ex: ${campo === 'valor' ? '"R$ 1.700"' : campo === 'data' ? '"dia 15" ou "15/03/2026"' : campo === 'categoria' ? '"Moradia"' : '"Aluguel Centro"'}_`;
  }

  // Nenhum campo especificado → perguntar o que quer editar
  salvarEditarTxPendente(usuarioId, { fase: 'escolher_campo', transacao: t });
  return `${resumoTransacaoEdit(t)}\n\nO que quer editar?\n\n_Ex: "alterar o valor para R$ 1.700", "mudar a data para dia 15", "corrigir a descrição para Aluguel Centro", "categoria Moradia"_`;
}

async function aplicarEdicaoTx(usuarioId, t, campo, novoValorStr) {
  let valorFinal = novoValorStr;

  if (campo === 'valor') {
    const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!v || v <= 0) return `❌ Valor inválido: "${novoValorStr}". Ex: _"R$ 1.700"_`;
    valorFinal = v;
  } else if (campo === 'data') {
    const d = resolverData(novoValorStr) || parseData(novoValorStr);
    if (!d) return `❌ Data inválida: "${novoValorStr}". Ex: _"15/03/2026"_ ou _"dia 15"_`;
    valorFinal = d;
  } else if (campo === 'descricao' || campo === 'categoria') {
    valorFinal = novoValorStr.trim();
    if (!valorFinal) return `❌ Texto inválido.`;
  }

  const atualizada = await db.atualizarTransacao(usuarioId, t.id, campo, valorFinal);
  if (!atualizada) return `❌ Não consegui atualizar o lançamento.`;

  const labelsAntes = { valor: fmt.formatarMoeda(t.valor), data: fmt.formatarData(t.data), descricao: t.descricao, categoria: t.categoria };
  const labelsDepois = { valor: fmt.formatarMoeda(atualizada.valor), data: fmt.formatarData(atualizada.data), descricao: atualizada.descricao, categoria: atualizada.categoria };
  let msg = `✅ *${atualizada.descricao}* atualizado!\n\n${labelsAntes[campo]} → *${labelsDepois[campo]}*`;

  // Se a transação está vinculada a uma recorrência e o campo editado também existe na regra, perguntar
  if (t.recorrencia_id && ['valor', 'descricao', 'categoria'].includes(campo)) {
    salvarEditarRecPendente(usuarioId, { recorrenciaId: t.recorrencia_id, campo, valorFinal });
    msg += `\n\n🔄 Esse lançamento faz parte de uma *conta fixa/recorrente*.\nQuer atualizar a regra também (para os próximos meses)?\n\n_Responda *sim* ou *não*._`;
  }

  return msg;
}

async function handleEditarTxPendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();

  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarTxPendente(usuarioId);
    return '❌ Cancelado.';
  }

  // Fase: selecionar entre múltiplos
  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > pendente.transacoes.length) {
      return `Responda com um número de 1 a ${pendente.transacoes.length}, ou _"cancelar"_.`;
    }
    const t = pendente.transacoes[num - 1];
    if (pendente.campo && pendente.novo_valor) {
      limparEditarTxPendente(usuarioId);
      return aplicarEdicaoTx(usuarioId, t, pendente.campo, pendente.novo_valor);
    }
    if (pendente.campo) {
      salvarEditarTxPendente(usuarioId, { fase: 'aguardando_valor', transacao: t, campo: pendente.campo });
      const labels = { valor: 'novo valor', data: 'nova data', descricao: 'nova descrição', categoria: 'nova categoria' };
      return `${resumoTransacaoEdit(t)}\n\nQual o ${labels[pendente.campo] || pendente.campo}?`;
    }
    salvarEditarTxPendente(usuarioId, { fase: 'escolher_campo', transacao: t });
    return `${resumoTransacaoEdit(t)}\n\nO que quer editar?\n\n_Ex: "valor para R$ 1.700", "data dia 15", "categoria Moradia", "descrição Aluguel Centro"_`;
  }

  // Fase: escolher o que editar
  if (pendente.fase === 'escolher_campo') {
    const t = pendente.transacao;
    const campo = detectarCampoEdicao(lower);
    if (!campo) {
      return `Não entendi 😅 O que quer mudar?\n\n_"valor para R$ X", "data dia X", "categoria X", "descrição X"_`;
    }
    const novoValor = extrairNovoValorEdicao(msg, campo);
    if (novoValor) {
      limparEditarTxPendente(usuarioId);
      return aplicarEdicaoTx(usuarioId, t, campo, novoValor);
    }
    salvarEditarTxPendente(usuarioId, { fase: 'aguardando_valor', transacao: t, campo });
    const labels = { valor: 'novo valor (ex: R$ 1.700)', data: 'nova data (ex: dia 15)', descricao: 'nova descrição', categoria: 'nova categoria' };
    return `Qual o ${labels[campo] || campo}?`;
  }

  // Fase: receber o valor do campo
  if (pendente.fase === 'aguardando_valor') {
    const t = pendente.transacao;
    const campo = pendente.campo;
    limparEditarTxPendente(usuarioId);
    return aplicarEdicaoTx(usuarioId, t, campo, msg.trim());
  }

  limparEditarTxPendente(usuarioId);
  return null;
}

function detectarCampoEdicao(lower) {
  if (/\b(valor|preco|preço|quanto|r\$|reais)\b/.test(lower)) return 'valor';
  if (/\b(data|dia|vencimento|prazo|quando)\b/.test(lower)) return 'data';
  if (/\b(descri[cç][aã]o|nome|titulo|título|chama[dr]|chamado)\b/.test(lower)) return 'descricao';
  if (/\b(categoria|tipo|classifica[cç][aã]o)\b/.test(lower)) return 'categoria';
  // Tenta inferir pelo padrão "para R$ X" → valor, "para dia X" → data
  if (/para\s+r?\$?\s*[\d.,]+/i.test(lower)) return 'valor';
  if (/para\s+dia\s+\d+/i.test(lower)) return 'data';
  return null;
}

function extrairNovoValorEdicao(texto, campo) {
  if (campo === 'valor') {
    const m = texto.match(/(?:para|pra|de|:)?\s*r?\$?\s*([\d.,]+k?)/i);
    return m ? m[1] : null;
  }
  if (campo === 'data') {
    const m = texto.match(/(?:para|pra|dia|:)?\s*(\d{1,2}(?:[/\-]\d{1,2}(?:[/\-]\d{2,4})?)?)/i);
    return m ? m[1] : null;
  }
  if (campo === 'descricao' || campo === 'categoria') {
    const m = texto.match(/(?:para|pra|:)\s+(.+)$/i);
    return m ? m[1].trim() : null;
  }
  return null;
}

// ── Editar Recorrência ────────────────────────────────────────────────────────

async function handleEditarRecPendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();
  limparEditarRecPendente(usuarioId);

  if (/^(sim|s|yes|claro|isso|pode|quero|bora|atualiza)$/i.test(lower)) {
    const atualizada = await db.atualizarRecorrencia(usuarioId, pendente.recorrenciaId, pendente.campo, pendente.valorFinal);
    if (!atualizada) return `❌ Não consegui atualizar a regra de recorrência.`;
    return `✅ Regra de recorrência *${atualizada.descricao}* atualizada!\n\nA partir do próximo mês, o ${pendente.campo} será *${pendente.campo === 'valor' ? fmt.formatarMoeda(atualizada.valor) : pendente.valorFinal}*.`;
  }

  if (/^(n[aã]o|nao|n|no|deixa|esquece|só esse|so esse)$/i.test(lower)) {
    return '👍 Beleza, só esse mês foi alterado. A recorrência continua como antes.';
  }

  return null; // não entendeu, seguir fluxo normal
}

function resumoRecorrenciaEdit(r) {
  const emoji = r.tipo === 'receita' ? '💰' : '💸';
  let quando = r.frequencia === 'semanal'
    ? (r.dia_semana != null ? `toda ${['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'][r.dia_semana]}` : 'toda semana')
    : (r.dia_mes ? `todo dia ${r.dia_mes}` : 'todo mês');
  return `${emoji} *${r.descricao}*\n` +
    `  💵 Valor: ${fmt.formatarMoeda(r.valor)}\n` +
    `  📅 Frequência: ${quando}\n` +
    `  📂 Categoria: ${r.categoria}`;
}

async function handleEditarRecorrenciaPorNome(usuarioId, resultado) {
  const { descricao_busca, campo, novo_valor } = resultado;
  if (!descricao_busca) {
    return `Qual recorrência quer editar? Me diz o nome.\n\n_Ex: "editar recorrência salário"_`;
  }

  const recorrencias = await db.buscarRecorrenciasPorDescricao(usuarioId, descricao_busca);

  if (recorrencias.length === 0) {
    return `❌ Nenhuma recorrência ativa encontrada com "${descricao_busca}".\n\nUse _"recorrentes"_ para ver suas contas fixas.`;
  }

  if (recorrencias.length > 1) {
    salvarEditarRecDiretoPendente(usuarioId, { fase: 'selecionar', recorrencias, campo: campo || null, novo_valor: novo_valor || null });
    const lista = recorrencias.map((r, i) => {
      const emoji = r.tipo === 'receita' ? '💰' : '💸';
      return `  ${i + 1}. ${emoji} *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (${r.frequencia})`;
    }).join('\n');
    return `Encontrei ${recorrencias.length} recorrências com "${descricao_busca}":\n\n${lista}\n\nQual delas quer editar? Responda com o número ou _"cancelar"_.`;
  }

  const r = recorrencias[0];

  if (campo && novo_valor) {
    return aplicarEdicaoRec(usuarioId, r, campo, novo_valor);
  }

  if (campo) {
    salvarEditarRecDiretoPendente(usuarioId, { fase: 'aguardando_valor', recorrencia: r, campo });
    const labels = { valor: 'novo valor', descricao: 'nova descrição', categoria: 'nova categoria', dia_mes: 'novo dia do mês' };
    return `${resumoRecorrenciaEdit(r)}\n\nQual o ${labels[campo] || campo}?`;
  }

  salvarEditarRecDiretoPendente(usuarioId, { fase: 'escolher_campo', recorrencia: r });
  return `${resumoRecorrenciaEdit(r)}\n\nO que quer editar?\n\n_Ex: "valor para R$ 1.700", "dia para 15", "descrição para Salário CLT", "categoria Salario"_`;
}

async function aplicarEdicaoRec(usuarioId, r, campo, novoValorStr) {
  let valorFinal = novoValorStr;
  let campoDb = campo;

  if (campo === 'valor') {
    const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!v || v <= 0) return `❌ Valor inválido: "${novoValorStr}". Ex: _"R$ 1.700"_`;
    valorFinal = v;
  } else if (campo === 'dia' || campo === 'dia_mes') {
    const d = parseInt(novoValorStr.toString().replace(/\D/g, ''), 10);
    if (isNaN(d) || d < 1 || d > 31) return `❌ Dia inválido. Informe um dia de 1 a 31.`;
    valorFinal = d;
    campoDb = 'dia_mes';
  } else if (campo === 'descricao' || campo === 'categoria') {
    valorFinal = novoValorStr.trim();
    if (!valorFinal) return `❌ Texto inválido.`;
  }

  // Perguntar ao usuário se quer alterar para todos os meses ou só o atual
  const labelsAntes = { valor: fmt.formatarMoeda(r.valor), descricao: r.descricao, categoria: r.categoria, dia_mes: `dia ${r.dia_mes || '?'}` };
  const labelsDepoisPreview = { valor: campo === 'valor' ? fmt.formatarMoeda(valorFinal) : novoValorStr, descricao: valorFinal, categoria: valorFinal, dia_mes: `dia ${valorFinal}` };

  salvarEditarRecDiretoPendente(usuarioId, {
    fase: 'escolher_escopo',
    recorrencia: r,
    campo: campoDb,
    valorFinal,
  });

  return `Alterar *${r.descricao}* — ${labelsAntes[campoDb]} → *${labelsDepoisPreview[campoDb]}*\n\nQuer alterar:\n\n  1️⃣ *Todos os meses* (regra + transações futuras)\n  2️⃣ *Somente este mês* (só a transação do mês atual)\n\nResponda *1* ou *2*, ou _"cancelar"_.`;
}

async function executarEdicaoRecEscopo(usuarioId, r, campoDb, valorFinal, escopo) {
  if (escopo === 'todos') {
    const atualizada = await db.atualizarRecorrencia(usuarioId, r.id, campoDb, valorFinal);
    if (!atualizada) return `❌ Não consegui atualizar a recorrência.`;

    // Também atualizar transações pendentes futuras vinculadas a essa recorrência
    if (['valor', 'descricao', 'categoria'].includes(campoDb)) {
      try {
        await db.pool.query(
          `UPDATE transacoes SET ${campoDb} = $1
           WHERE recorrencia_id = $2 AND usuario_id = (SELECT usuario_id FROM recorrencias WHERE id = $2)
             AND status = 'pendente'`,
          [valorFinal, r.id]
        );
      } catch (e) { /* best effort */ }
    }

    const labelsAntes = { valor: fmt.formatarMoeda(r.valor), descricao: r.descricao, categoria: r.categoria, dia_mes: `dia ${r.dia_mes || '?'}` };
    const labelsDepois = { valor: fmt.formatarMoeda(atualizada.valor), descricao: atualizada.descricao, categoria: atualizada.categoria, dia_mes: `dia ${atualizada.dia_mes}` };
    return `✅ Recorrência *${atualizada.descricao}* atualizada!\n\n${labelsAntes[campoDb]} → *${labelsDepois[campoDb]}*\n\n_Todos os meses futuros usarão o novo valor._`;
  }

  // escopo === 'atual' — só alterar transação pendente do mês atual
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString().slice(0, 10);
  const fimMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).toISOString().slice(0, 10);

  try {
    const result = await db.pool.query(
      `UPDATE transacoes SET ${campoDb} = $1
       WHERE recorrencia_id = $2 AND usuario_id = (SELECT usuario_id FROM recorrencias WHERE id = $2)
         AND status = 'pendente' AND data >= $3 AND data <= $4
       RETURNING *`,
      [valorFinal, r.id, inicioMes, fimMes]
    );

    if (result.rowCount === 0) {
      return `❌ Não encontrei transação pendente deste mês para *${r.descricao}*.\n\n_Talvez já tenha sido confirmada. Tente alterar para todos os meses._`;
    }

    const labelsAntes = { valor: fmt.formatarMoeda(r.valor), descricao: r.descricao, categoria: r.categoria, dia_mes: `dia ${r.dia_mes || '?'}` };
    const labelsDepoisMap = { valor: fmt.formatarMoeda(valorFinal), descricao: valorFinal, categoria: valorFinal, dia_mes: `dia ${valorFinal}` };
    return `✅ Transação de *${r.descricao}* deste mês atualizada!\n\n${labelsAntes[campoDb]} → *${labelsDepoisMap[campoDb]}*\n\n_A regra de recorrência não foi alterada — nos próximos meses voltará ao valor original._`;
  } catch (e) {
    return `❌ Erro ao atualizar transação do mês atual. Tente novamente.`;
  }
}

function detectarCampoEdicaoRec(lower) {
  if (/\b(valor|preco|preço|quanto|r\$|reais)\b/.test(lower)) return 'valor';
  if (/\b(dia|vencimento|dia.?mes)\b/.test(lower)) return 'dia_mes';
  if (/\b(descri[cç][aã]o|nome|titulo|título)\b/.test(lower)) return 'descricao';
  if (/\b(categoria|classifica[cç][aã]o)\b/.test(lower)) return 'categoria';
  if (/para\s+r?\$?\s*[\d.,]+/i.test(lower)) return 'valor';
  if (/para\s+dia\s+\d+/i.test(lower)) return 'dia_mes';
  return null;
}

async function handleEditarRecDiretoPendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();

  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarRecDiretoPendente(usuarioId);
    return '❌ Cancelado.';
  }

  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > pendente.recorrencias.length) {
      return `Responda com um número de 1 a ${pendente.recorrencias.length}, ou _"cancelar"_.`;
    }
    const r = pendente.recorrencias[num - 1];
    if (pendente.campo && pendente.novo_valor) {
      limparEditarRecDiretoPendente(usuarioId);
      return aplicarEdicaoRec(usuarioId, r, pendente.campo, pendente.novo_valor);
    }
    if (pendente.campo) {
      salvarEditarRecDiretoPendente(usuarioId, { fase: 'aguardando_valor', recorrencia: r, campo: pendente.campo });
      const labels = { valor: 'novo valor', descricao: 'nova descrição', categoria: 'nova categoria', dia_mes: 'novo dia do mês' };
      return `${resumoRecorrenciaEdit(r)}\n\nQual o ${labels[pendente.campo] || pendente.campo}?`;
    }
    salvarEditarRecDiretoPendente(usuarioId, { fase: 'escolher_campo', recorrencia: r });
    return `${resumoRecorrenciaEdit(r)}\n\nO que quer editar?\n\n_Ex: "valor para R$ 1.700", "dia para 15", "descrição para Salário CLT", "categoria Salario"_`;
  }

  if (pendente.fase === 'escolher_campo') {
    const r = pendente.recorrencia;
    const campo = detectarCampoEdicaoRec(lower);
    if (!campo) {
      return `Não entendi. O que quer mudar?\n\n_"valor para R$ X", "dia para X", "categoria X", "descrição X"_`;
    }
    const novoValor = extrairNovoValorEdicao(msg, campo === 'dia_mes' ? 'data' : campo);
    if (novoValor) {
      limparEditarRecDiretoPendente(usuarioId);
      return aplicarEdicaoRec(usuarioId, r, campo, novoValor);
    }
    salvarEditarRecDiretoPendente(usuarioId, { fase: 'aguardando_valor', recorrencia: r, campo });
    const labels = { valor: 'novo valor (ex: R$ 1.700)', dia_mes: 'novo dia do mês (ex: 15)', descricao: 'nova descrição', categoria: 'nova categoria' };
    return `Qual o ${labels[campo] || campo}?`;
  }

  if (pendente.fase === 'aguardando_valor') {
    const r = pendente.recorrencia;
    const campo = pendente.campo;
    return aplicarEdicaoRec(usuarioId, r, campo, msg.trim());
  }

  if (pendente.fase === 'escolher_escopo') {
    const r = pendente.recorrencia;
    const campo = pendente.campo;
    const valorFinal = pendente.valorFinal;

    if (/^(1|todos|tudo|todas|todos\s+os\s+meses)/i.test(lower)) {
      limparEditarRecDiretoPendente(usuarioId);
      return executarEdicaoRecEscopo(usuarioId, r, campo, valorFinal, 'todos');
    }
    if (/^(2|atual|s[oó]\s*(este|esse)|este\s+m[eê]s|somente|apenas)/i.test(lower)) {
      limparEditarRecDiretoPendente(usuarioId);
      return executarEdicaoRecEscopo(usuarioId, r, campo, valorFinal, 'atual');
    }

    return `Responda *1* (todos os meses) ou *2* (somente este mês), ou _"cancelar"_.`;
  }

  limparEditarRecDiretoPendente(usuarioId);
  return null;
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
  } else if (resposta === '2' || resposta === 'pendente' || resposta === 'a pagar' || resposta === 'nao' || resposta === 'não' || resposta === 'ainda nao' || resposta === 'ainda não' || resposta === 'nao paguei' || resposta === 'não paguei' || resposta === 'a receber') {
    status = 'pendente';
  } else {
    // Resposta não reconhecida - manter a confirmação ativa
    return `Responda com:\n*1* - Já paguei/recebi\n*2* - A pagar/receber\n*0* - Cancelar`;
  }

  limparConfirmacao(usuarioId);

  // Múltiplos itens de imagem
  if (dados.multiplos && dados.itens) {
    const salvos = [];
    const incompletos = [];

    for (const item of dados.itens) {
      const { tipo: itemTipo, valor: itemValor, descricao: itemDescricao, categoria: itemCategoria, data: itemData } = item;
      if (!itemValor || !itemDescricao) {
        incompletos.push({ ...item, status });
        continue;
      }

      const tipoFinal = itemTipo || 'despesa';
      if (tipoFinal === 'despesa' && itemCategoria) {
        await garantirSubcategoriaVinculada(usuarioId, itemCategoria);
      }
      const result = await db.adicionarTransacao(usuarioId, tipoFinal, itemValor, itemDescricao, itemCategoria, itemData, status);
      const dataExibir = itemData ? fmt.formatarData(itemData) : 'Hoje';
      const emoji = status === 'pendente' ? (tipoFinal === 'receita' ? '⏳💰' : '⏳💸') : (tipoFinal === 'receita' ? '✅💰' : '✅💸');
      salvos.push(`${emoji} ${itemDescricao} — ${fmt.formatarMoeda(itemValor)} (${dataExibir})`);
    }

    let msg = '';
    if (salvos.length > 0) {
      msg = `📋 *${salvos.length} ${salvos.length === 1 ? 'transação registrada' : 'transações registradas'}!*\n\n${salvos.join('\n')}`;
    }

    // Se tem incompletos, iniciar fluxo de perguntas
    if (incompletos.length > 0) {
      const [primeiro, ...restante] = incompletos;
      const faltaValor = !primeiro.valor;
      salvarTransacoesMultiplasPendentes(usuarioId, {
        itemAtual: { ...primeiro, status },
        filaRestante: restante.map(i => ({ ...i, status })),
        campoEsperado: faltaValor ? 'valor' : 'data',
      });
      const pergunta = faltaValor
        ? `💰 Qual o valor de *${primeiro.descricao}*?`
        : `📅 Qual a data de vencimento de *${primeiro.descricao}*?`;

      if (msg) msg += `\n\nMas preciso da sua ajuda 👇\n\n${pergunta}`;
      else msg = `Preciso de mais informações 👇\n\n${pergunta}`;
    }

    return msg || '❌ Não consegui registrar os itens da imagem.';
  }

  const { tipo, valor, descricao, categoria, data } = dados;

  // Auto-criar subcategoria vinculada se for nova
  if (tipo === 'despesa' && categoria) await garantirSubcategoriaVinculada(usuarioId, categoria);

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
    `📅 Data: ${dataExibir}`;

  if (status === 'pendente') {
    const quando = tipo === 'receita' ? 'receber' : 'pagar';
    msg += `\n\n_Vou te lembrar quando chegar o dia de ${quando}! 📅_`;
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

  // Se for um aporte agendado em caixinha, atualizar o saldo da caixinha
  let extraMsg = '';
  const matchAporte = transacao.descricao?.match(/^Aporte\s*-\s*(.+)$/i);
  if (matchAporte && transacao.categoria === 'Investimentos') {
    const nomeCaixinha = matchAporte[1].trim();
    const caixinhas = await db.buscarCaixinhasPorNome(usuarioId, nomeCaixinha);
    if (caixinhas.length > 0) {
      const atualizada = await db.adicionarSaldoCaixinha(caixinhas[0].id, transacao.valor);
      extraMsg = `\n\n💰 *${nomeCaixinha}*: ${fmt.formatarMoeda(atualizada.saldo - transacao.valor)} → *${fmt.formatarMoeda(atualizada.saldo)}*`;
    }
  }

  const emoji = transacao.tipo === 'receita' ? '💰' : '💸';
  const acao = transacao.tipo === 'receita' ? 'Recebido' : 'Pago';

  return `✅${emoji} *${acao}!* Lançamento #${transacao.id} liquidado.\n\n` +
    `📝 ${transacao.descricao}\n` +
    `💵 ${fmt.formatarMoeda(transacao.valor)}\n` +
    `📂 ${transacao.categoria}${extraMsg}`;
}

// === MÚLTIPLAS TRANSAÇÕES ===

async function processarTransacoesMultiplas(usuarioId, itens, textoOriginal) {
  const salvos = [];
  const incompletos = [];

  for (const item of itens) {
    const { tipo, descricao, categoria, status, cartao_nome, parcelas } = item;
    const valor = item.valor && item.valor > 0 ? item.valor : null;
    const statusFinal = status === 'pendente' ? 'pendente' : 'pago';

    // Resolver data
    let dataFinal = resolverData(item.data);
    if (!dataFinal && item.data && typeof item.data === 'string' && item.data.includes('/')) {
      dataFinal = parseData(item.data);
    }

    // Item sem descrição: impossível salvar ou perguntar
    if (!tipo || !descricao) continue;

    // Verificar o que falta
    const faltaValor = !valor;
    const faltaData = statusFinal === 'pendente' && !dataFinal;

    if (faltaValor || faltaData) {
      // Guardar na fila de incompletos para perguntar depois
      incompletos.push({
        tipo,
        valor: valor || null,
        descricao,
        categoria: categoria || 'Outros',
        data: dataFinal || null,
        status: statusFinal,
        cartao_nome: cartao_nome || null,
        parcelas: parcelas || 1,
      });
      continue;
    }

    // Item completo: salvar direto
    try {
      let cartaoId = null;
      if (tipo === 'despesa' && cartao_nome) {
        const cartoes = await db.buscarCartoesPorNome(usuarioId, cartao_nome);
        if (cartoes.length >= 1) cartaoId = cartoes[0].id;
      }

      const numParcelas = parcelas && parcelas > 1 ? Math.round(parcelas) : 1;
      if (numParcelas > 1) {
        const msg = await salvarTransacaoParcelada(usuarioId, valor, descricao, categoria, dataFinal, cartaoId, numParcelas);
        salvos.push({ descricao, valor, msg });
      } else {
        const msg = await salvarTransacao(usuarioId, tipo, valor, descricao, categoria || 'Outros', dataFinal, statusFinal, cartaoId);
        salvos.push({ descricao, valor, msg });
      }
    } catch (err) {
      console.error(`[MULTI-TX] Erro ao salvar item:`, err.message);
      incompletos.push({ tipo, valor, descricao, categoria: categoria || 'Outros', data: dataFinal, status: statusFinal });
    }
  }

  // Montar resposta
  let resposta = '';

  if (salvos.length > 0) {
    resposta += `📋 *${salvos.length} ${salvos.length === 1 ? 'transação registrada' : 'transações registradas'}!*\n`;
    for (const r of salvos) {
      resposta += `\n${r.msg}\n`;
    }
  }

  // Se tem incompletos, iniciar fluxo de perguntas
  if (incompletos.length > 0) {
    const [primeiro, ...restante] = incompletos;

    // Determinar o que falta do primeiro item
    const faltaValor = !primeiro.valor;
    const faltaData = primeiro.status === 'pendente' && !primeiro.data;

    // Salvar estado: item atual + fila dos restantes
    salvarTransacoesMultiplasPendentes(usuarioId, {
      itemAtual: primeiro,
      filaRestante: restante,
      campoEsperado: faltaValor ? 'valor' : 'data',
    });

    // Montar pergunta
    let pergunta;
    if (faltaValor) {
      pergunta = `💰 Qual o valor de *${primeiro.descricao}*?`;
    } else if (faltaData) {
      pergunta = `📅 Qual a data de vencimento de *${primeiro.descricao}*?`;
    }

    if (salvos.length > 0) {
      resposta += `\nMas preciso da sua ajuda com ${incompletos.length === 1 ? 'um item' : `${incompletos.length} itens`} 👇\n\n${pergunta}`;
    } else {
      resposta = `Anotei ${incompletos.length} ${incompletos.length === 1 ? 'item' : 'itens'}! Só preciso de mais algumas informações 👇\n\n${pergunta}`;
    }
  }

  if (!resposta) {
    return '❌ Não consegui registrar nenhuma transação. Tente enviar uma de cada vez.';
  }

  return resposta;
}

async function handleMultiplasPendentesResposta(usuarioId, texto, dados) {
  const lower = texto.toLowerCase().trim();

  // Cancelar
  if (lower === 'cancelar' || lower === 'pular') {
    limparTransacoesMultiplasPendentes(usuarioId);
    return '❌ Itens pendentes cancelados.';
  }

  const { itemAtual, filaRestante, campoEsperado } = dados;

  // Preencher campo que está faltando
  if (campoEsperado === 'valor' || !itemAtual.valor) {
    const valorExtraido = await extrairValorRobusto(texto);
    if (valorExtraido && valorExtraido > 0) {
      itemAtual.valor = valorExtraido;
    }

    // Também tentar extrair data se veio junto
    if (!itemAtual.data && itemAtual.status === 'pendente') {
      const dataExtraida = extrairDataDoTexto(texto);
      if (dataExtraida) itemAtual.data = dataExtraida;
    }

    // Se ainda falta valor
    if (!itemAtual.valor) {
      return `❌ Não entendi o valor de *${itemAtual.descricao}*. Me diz só o número:\n\n_Ex: "150", "R$ 1.200,50", "50 reais"_\n\n_Ou manda "cancelar" pra pular._`;
    }
  }

  if (campoEsperado === 'data' || (itemAtual.status === 'pendente' && !itemAtual.data)) {
    const dataExtraida = extrairDataDoTexto(texto);
    if (!dataExtraida && campoEsperado === 'data') {
      return `Não consegui entender a data de *${itemAtual.descricao}* 😅\n\nMe diz de um jeito mais direto:\n_Ex: "sexta-feira", "dia 20", "amanhã", "hoje"_\n\n_Ou manda "cancelar" pra pular._`;
    }
    if (dataExtraida) itemAtual.data = dataExtraida;
  }

  // Verificar se o item atual ainda tem campos faltantes
  const aindaFaltaValor = !itemAtual.valor;
  const aindaFaltaData = itemAtual.status === 'pendente' && !itemAtual.data;

  if (aindaFaltaValor || aindaFaltaData) {
    salvarTransacoesMultiplasPendentes(usuarioId, {
      itemAtual,
      filaRestante,
      campoEsperado: aindaFaltaValor ? 'valor' : 'data',
    });
    if (aindaFaltaValor) return `💰 Qual o valor de *${itemAtual.descricao}*?`;
    return `📅 Qual a data de vencimento de *${itemAtual.descricao}*?`;
  }

  // Item atual completo! Salvar
  let msgSalvo;
  try {
    let cartaoId = null;
    if (itemAtual.tipo === 'despesa' && itemAtual.cartao_nome) {
      const cartoes = await db.buscarCartoesPorNome(usuarioId, itemAtual.cartao_nome);
      if (cartoes.length >= 1) cartaoId = cartoes[0].id;
    }

    const numParcelas = itemAtual.parcelas && itemAtual.parcelas > 1 ? Math.round(itemAtual.parcelas) : 1;
    if (numParcelas > 1) {
      msgSalvo = await salvarTransacaoParcelada(usuarioId, itemAtual.valor, itemAtual.descricao, itemAtual.categoria, itemAtual.data, cartaoId, numParcelas);
    } else {
      msgSalvo = await salvarTransacao(usuarioId, itemAtual.tipo, itemAtual.valor, itemAtual.descricao, itemAtual.categoria || 'Outros', itemAtual.data, itemAtual.status || 'pago', cartaoId);
    }
  } catch (err) {
    console.error(`[MULTI-TX] Erro ao salvar item:`, err.message);
    msgSalvo = `❌ Erro ao salvar *${itemAtual.descricao}*`;
  }

  // Verificar se há mais itens na fila
  if (filaRestante && filaRestante.length > 0) {
    const [proximo, ...resto] = filaRestante;
    const faltaValorProx = !proximo.valor;
    const faltaDataProx = proximo.status === 'pendente' && !proximo.data;

    salvarTransacoesMultiplasPendentes(usuarioId, {
      itemAtual: proximo,
      filaRestante: resto,
      campoEsperado: faltaValorProx ? 'valor' : 'data',
    });

    let pergunta;
    if (faltaValorProx) {
      pergunta = `💰 Qual o valor de *${proximo.descricao}*?`;
    } else if (faltaDataProx) {
      pergunta = `📅 Qual a data de vencimento de *${proximo.descricao}*?`;
    }

    return `${msgSalvo}\n\nAgora o próximo 👇\n\n${pergunta}`;
  }

  // Fila vazia, tudo salvo!
  limparTransacoesMultiplasPendentes(usuarioId);
  return msgSalvo;
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

    let texto;
    if (jaUsaBot) {
      const nomeExibir = nome || 'amigo(a)';
      texto = resultado.resposta.replace(/{{NOME}}/g, nomeExibir);
    } else {
      texto = mensagemBoasVindas(nome);
    }
    return { msg: texto, semCitacao: true };
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
    return { msg: resultado.resposta, semCitacao: true };
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

  if (resultado.acao === 'remover_cartao') {
    return await handleRemoverCartao(usuarioId, resultado);
  }

  // Excluir transação por nome (via IA)
  if (resultado.acao === 'excluir_transacao') {
    return await handleExcluirTxPorNome(usuarioId, resultado.descricao_busca, resultado.tipo || null);
  }

  // Editar transação por nome (via IA)
  if (resultado.acao === 'editar_transacao') {
    return await handleEditarTxPorNome(usuarioId, resultado);
  }

  // Editar recorrência por nome (via IA)
  if (resultado.acao === 'editar_recorrencia') {
    return await handleEditarRecorrenciaPorNome(usuarioId, resultado);
  }

  // Editar cartão (via IA)
  if (resultado.acao === 'editar_cartao') {
    return await handleEditarCartao(usuarioId, resultado);
  }

  // Editar caixinha (via IA)
  if (resultado.acao === 'editar_caixinha') {
    return await handleEditarCaixinha(usuarioId, resultado);
  }

  // Excluir caixinha (via IA)
  if (resultado.acao === 'excluir_caixinha') {
    return await handleExcluirCaixinha(usuarioId, resultado);
  }

  // Editar limite (via IA)
  if (resultado.acao === 'editar_limite') {
    return await handleEditarLimite(usuarioId, resultado);
  }

  // Editar lembrete (via IA)
  if (resultado.acao === 'editar_lembrete') {
    return await handleEditarLembrete(usuarioId, resultado);
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
      return await handleLista(usuarioId, textoOriginal || 'lista');
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
    const { tipo, descricao, status } = resultado;
    const categoria = (!resultado.categoria || resultado.categoria === 'null' || resultado.categoria === 'undefined') ? 'Outros' : resultado.categoria;
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
    if (tipo === 'despesa') {
      if (resultado.cartao_nome) {
        // Validar: só usar cartão se o texto original indica compra no cartão.
        // Evita que o nome do cartão que aparece dentro da descrição da despesa
        // seja confundido com uma referência ao cartão de compra.
        // Padrões válidos: "no nubank", "via nubank", "nubank 300" (cartão no início),
        //                  "no cartão nubank", "comprei no nubank"
        const nomePrimeiro = resultado.cartao_nome.toLowerCase().split(/\s+/)[0];
        const cartaoNoInicio = lower.startsWith(nomePrimeiro + ' ');
        const reContextoCartao = new RegExp(
          `\\b(?:no\\s+(?:cart[aã]o\\s+)?${nomePrimeiro}|via\\s+${nomePrimeiro}|pelo\\s+${nomePrimeiro}|${nomePrimeiro}\\s+(?:cart[aã]o)|comprei\\s+(?:n[oa]\\s+)?${nomePrimeiro}|\\d+(?:[.,]\\d+)?\\s+${nomePrimeiro})\\b`,
          'i'
        );
        if (cartaoNoInicio || reContextoCartao.test(lower)) {
          const cartoes = await db.buscarCartoesPorNome(usuarioId, resultado.cartao_nome);
          if (cartoes.length >= 1) cartaoId = cartoes[0].id;
        }
      }

      const parcelas = resultado.parcelas && resultado.parcelas > 1 ? Math.round(resultado.parcelas) : 1;

      // Compra parcelada com cartão já identificado
      if (parcelas > 1 && cartaoId) {
        return await salvarTransacaoParcelada(usuarioId, valor, descricao, categoria, dataFinal, cartaoId, parcelas);
      }

      // Parcelado sem cartão e sem cartões cadastrados → salvar direto em conta corrente
      if (parcelas > 1 && !cartaoId) {
        const cartoesUsuario = await db.listarCartoes(usuarioId);
        if (cartoesUsuario.length > 0) {
          // Tem cartões, perguntar em qual (ou conta corrente)
          const pendente = { tipo, valor, descricao, categoria: categoria || 'Outros', data: dataFinal, status: statusFinal, aguardandoCartao: true, cartoesDisponiveis: cartoesUsuario, parcelas };
          salvarTransacaoPendente(usuarioId, pendente);
          let pergunta = `Anotei *${descricao}* de *${fmt.formatarMoeda(valor)}* em *${parcelas}x* 👍\n\nFoi no cartão ou conta corrente?\n\n`;
          pergunta += cartoesUsuario.map((c, i) => `  ${i + 1}. ${c.nome}`).join('\n');
          pergunta += `\n  ${cartoesUsuario.length + 1}. Conta corrente`;
          return pergunta;
        }
        // Sem cartões cadastrados → salvar parcelado direto em conta corrente
        return await salvarTransacaoParcelada(usuarioId, valor, descricao, categoria, dataFinal, null, parcelas);
      }

      // Se não identificou cartão e a despesa já tem valor, perguntar se foi no cartão
      if (!cartaoId && valor && statusFinal === 'pago') {
        const cartoesUsuario = await db.listarCartoes(usuarioId);
        if (cartoesUsuario.length > 0) {
          // Salvar transação como pendente-de-cartão e perguntar (preservando parcelas)
          const pendente = { tipo, valor, descricao, categoria: categoria || 'Outros', data: dataFinal, status: statusFinal, aguardandoCartao: true, cartoesDisponiveis: cartoesUsuario, parcelas };
          salvarTransacaoPendente(usuarioId, pendente);

          let pergunta = `Anotei *${descricao}* de *${fmt.formatarMoeda(valor)}* 👍\n\nFoi no cartão ou conta corrente?\n\n`;
          if (cartoesUsuario.length === 1) {
            pergunta += `  1. ${cartoesUsuario[0].nome}\n  2. Conta corrente`;
          } else {
            pergunta += cartoesUsuario.map((c, i) => `  ${i + 1}. ${c.nome}`).join('\n');
            pergunta += `\n  ${cartoesUsuario.length + 1}. Conta corrente`;
          }
          return pergunta;
        }
      }
    }

    return await salvarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal, cartaoId);
  }

  // Múltiplas transações via IA
  if (resultado.acao === 'transacoes_multiplas' && resultado.itens && resultado.itens.length > 0) {
    return await processarTransacoesMultiplas(usuarioId, resultado.itens, lower);
  }

  if (resultado.acao === 'uso_cartao') {
    return await handleUsoCartao(usuarioId, resultado.cartao_nome || null);
  }

  if (resultado.acao === 'consulta_funcionalidade') {
    return handleConsultaFuncionalidade(resultado.funcionalidade || '');
  }

  return foraDoEscopoMsg();
}

// Mapa de funcionalidades do Cronos para consulta do usuário
const FUNCIONALIDADES_CRONOS = [
  {
    chaves: ['audio', 'áudio', 'voz', 'mensagem de voz', 'falar', 'gravar'],
    suportado: true,
    resposta: 'Sim! Pode mandar áudio à vontade 🎙️\n\nEu transcrevo automaticamente e processo como se fosse texto. Perfeito para registrar um gasto sem parar o que tá fazendo!',
  },
  {
    chaves: ['foto', 'imagem', 'picture', 'boleto', 'nota fiscal', 'cupom', 'recibo', 'documento', 'comprovante'],
    suportado: true,
    resposta: 'Sim! Manda foto de boleto, nota fiscal, cupom ou recibo 📸\n\nEu leio o documento e registro tudo automaticamente — valor, descrição, data de vencimento e categoria.',
  },
  {
    chaves: ['csv', 'extrato', 'planilha', 'importar', 'exportar extrato'],
    suportado: true,
    resposta: 'Sim! Pode enviar o extrato do banco em CSV 📊\n\nEu importo todas as transações, categorizo automaticamente via IA e registro tudo de uma vez.',
  },
  {
    chaves: ['cartao', 'cartão', 'cartão de crédito', 'credito', 'crédito', 'limite', 'fatura'],
    suportado: true,
    resposta: 'Sim! Tenho controle completo de cartão de crédito 💳\n\nPosso rastrear compras por cartão, mostrar quanto você usou do limite no ciclo atual e avisar quando estiver chegando perto do limite.',
  },
  {
    chaves: ['painel', 'painel web', 'dashboard', 'site', 'navegador', 'graficos', 'gráficos'],
    suportado: true,
    resposta: 'Sim! Tenho um painel web completo 📱💻\n\nÉ só mandar *"meu painel"* que eu te envio o link com login e senha. Lá você vê gráficos, tabelas de transações e muito mais.',
  },
  {
    chaves: ['compartilhar', 'compartilhado', 'familia', 'família', 'marido', 'esposa', 'casal', 'multi usuario', 'multi-usuário', 'conta compartilhada', 'adicionar contato'],
    suportado: true,
    resposta: 'Sim! Dá pra compartilhar a conta com outras pessoas 👫\n\nÉ só mandar *"adicionar contato [número]"* e a pessoa receberá um convite. Tudo que qualquer membro registrar aparece para todos.',
  },
  {
    chaves: ['lembrete', 'lembrar', 'notificacao', 'notificação', 'aviso', 'alerta'],
    suportado: true,
    resposta: 'Sim! Posso criar lembretes 🔔\n\nÉ só falar: *"me lembra amanhã às 10h de pagar o aluguel"* ou *"todo dia 5 me avisa do cartão"*. Recorrentes e únicos, com confirmação de pagamento automática.',
  },
  {
    chaves: ['investimento', 'caixinha', 'poupança', 'reserva', 'guardar dinheiro'],
    suportado: true,
    resposta: 'Sim! Tenho caixinhas de investimento 💰\n\nVocê cria quantas quiser, cada uma com nome, meta e rendimento. É só falar *"criar caixinha"* para começar.',
  },
  {
    chaves: ['analise', 'análise', 'analise financeira', 'análise financeira', '50 30 20', 'orcamento', 'orçamento'],
    suportado: true,
    resposta: 'Sim! Faço análise financeira completa 📈\n\nEnvie seus extratos em CSV e eu categorizo tudo, calculo a divisão 50/30/20 (necessidades, desejos e poupança) e mostro onde ajustar.',
  },
  {
    chaves: ['localizacao', 'localização', 'lugares', 'perto', 'proximo', 'próximo', 'maps', 'google maps'],
    suportado: true,
    resposta: 'Sim! Posso encontrar lugares próximos de você 📍\n\nManda sua localização pelo WhatsApp e me diz o que procura — restaurantes, farmácias, bancos — eu mostro os melhores resultados com avaliações e endereço.',
  },
  {
    chaves: ['pesquisa', 'internet', 'busca', 'google', 'preço', 'preco', 'noticias', 'notícias'],
    suportado: true,
    resposta: 'Sim! Posso pesquisar na internet pra você 🔍\n\nÉ só perguntar qualquer coisa — preço de produto, taxa Selic, notícias, dicas — que eu pesquiso e trago os melhores resultados.',
  },
  {
    chaves: ['finanças em dia', 'financas em dia', 'setup', 'configurar', 'configuração', 'ponto zero', 'organizar tudo'],
    suportado: true,
    resposta: 'Sim! Tenho o *Finanças em Dia* 🎯\n\nÉ um setup guiado que organiza teu financeiro completo em poucos minutos — saldo, receitas fixas, despesas, investimentos e cartões. É só falar *"finanças em dia"* para começar.',
  },
  {
    chaves: ['assessor', 'assessor de compra', 'posso comprar', 'vale a pena comprar', 'devo comprar'],
    suportado: true,
    resposta: 'Sim! Tenho um assessor de compra 🛒\n\nÉ só perguntar: *"posso comprar um notebook de 3 mil?"* que eu analiso seu saldo, pendências e histórico e te dou uma recomendação clara.',
  },
  {
    chaves: ['ligar', 'ligacao', 'ligação', 'chamada', 'video chamada', 'vídeo chamada', 'ligar pelo whatsapp', 'call'],
    suportado: false,
    resposta: 'Infelizmente não consigo fazer ou receber ligações 📵\n\nO WhatsApp não permite isso via API. Mas posso enviar mensagens de texto, áudio e alertas — que na maioria dos casos resolvem bem! 😊',
  },
  {
    chaves: ['pagar boleto', 'efetuar pagamento', 'pagar pelo app', 'transferir dinheiro', 'fazer pix'],
    suportado: false,
    resposta: 'Não consigo realizar pagamentos ou transferências 💸\n\nSou um assistente de *controle* financeiro — registro, organizo e analiso. Para pagar, você usa o app do seu banco normalmente. Posso te lembrar de pagar! 😄',
  },
  {
    chaves: ['open banking', 'conectar banco', 'sincronizar banco', 'importar automatico', 'importar automático', 'conectar conta'],
    suportado: false,
    resposta: 'Ainda não tenho integração automática com bancos 🏦\n\nPor enquanto você importa os extratos em CSV ou registra as transações por texto, áudio ou foto. É rápido e prático!',
  },
  {
    chaves: ['excel', 'exportar excel', 'exportar planilha', 'exportar dados', 'baixar dados'],
    suportado: false,
    resposta: 'Ainda não tenho exportação de dados para Excel ou planilha 📄\n\nO painel web (*"meu painel"*) mostra tudo com gráficos e tabelas, mas exportação em arquivo ainda não está disponível.',
  },
  {
    chaves: ['video', 'vídeo', 'gif', 'sticker', 'figurinha'],
    suportado: false,
    resposta: 'Não processo vídeos, GIFs ou figurinhas 🙅\n\nMas aceito texto, áudio, foto de documento e CSV! Se quiser registrar algo, manda por qualquer um desses.',
  },
];

function handleConsultaFuncionalidade(funcionalidade) {
  const termo = funcionalidade.toLowerCase().trim();
  if (!termo) return 'Pode perguntar! O que você queria saber se eu consigo fazer? 😊';

  const match = FUNCIONALIDADES_CRONOS.find(f =>
    f.chaves.some(chave => termo.includes(chave) || chave.includes(termo))
  );

  if (match) return match.resposta;

  // Não encontrou na lista
  return `Hmm, ainda não tenho essa funcionalidade disponível 😅\n\nSe quiser, pode sugerir! O Cronos está sempre evoluindo. 🚀\n\nAlgumas coisas que já faço: áudio, foto de boleto, CSV, cartão de crédito, lembretes, caixinhas, análise financeira e muito mais.`;
}

async function salvarTransacaoParcelada(usuarioId, valor, descricao, categoria, dataFinal, cartaoId, parcelas) {
  const dataBase = dataFinal || dataHojeBRISO();
  await db.adicionarTransacoesParcelas(usuarioId, valor, descricao, categoria, dataBase, cartaoId, parcelas);

  const valorParcela = Math.round((valor / parcelas) * 100) / 100;
  let listaParcelas = '';
  for (let i = 0; i < parcelas; i++) {
    const d = new Date(dataBase + 'T12:00:00');
    d.setMonth(d.getMonth() + i);
    const mesAno = d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
    const icone = i === 0 ? '✅' : '⏳';
    const vAtual = i === parcelas - 1
      ? Math.round((valor - valorParcela * (parcelas - 1)) * 100) / 100
      : valorParcela;
    listaParcelas += `  ${i + 1}/${parcelas} — ${fmt.formatarMoeda(vAtual)} (${mesAno}) ${icone}\n`;
  }

  const iconeHeader = cartaoId ? '💳' : '📋';
  const sufixo = cartaoId ? ' no cartão' : '';
  let msg = `${iconeHeader} *${descricao}* registrada em *${parcelas}x*${sufixo}!\n\n` +
    `💵 Total: ${fmt.formatarMoeda(valor)}\n📋 *Parcelas:*\n${listaParcelas}`;

  msg += '\n💡 _Para ver suas despesas, tente:_\n_"minhas despesas", "despesas desse mês" ou "resumo"_';

  return msg;
}

async function salvarTransacao(usuarioId, tipo, valor, descricao, categoria, dataFinal, statusFinal, cartaoId = null) {
  // Sanitizar categoria: tratar string "null"/"undefined"/vazia como null real
  if (!categoria || categoria === 'null' || categoria === 'undefined') categoria = 'Outros';
  // Auto-criar subcategoria vinculada se for nova
  if (tipo === 'despesa' && categoria) await garantirSubcategoriaVinculada(usuarioId, categoria);

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
    `📅 Data: ${dataExibir}`;

  if (statusFinal === 'pendente') {
    const quando = tipo === 'receita' ? 'receber' : 'pagar';
    msg += `\n\n_Vou te lembrar quando chegar o dia de ${quando}! 📅_`;
  }

  if (tipo === 'despesa') {
    msg += '\n\n💡 _Para ver suas despesas, tente:_\n_"minhas despesas", "despesas desse mês" ou "resumo"_';
  } else {
    msg += '\n\n💡 _Para ver suas receitas, tente:_\n_"minhas receitas", "receitas desse mês" ou "resumo"_';
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

  // Aguardando escolha de cartão
  if (pendente.aguardandoCartao) {
    const cartoes = pendente.cartoesDisponiveis || [];
    let cartaoId = null;
    let ehContaCorrenteSelecionada = false;

    // "conta corrente", "corrente", "cc", "débito", "não", "direto", "pix", etc. → sem cartão
    if (/\b(conta corrente|corrente|cc|d[eé]bito|n[aã]o|direto|sem cart[aã]o|pix|esp[eé]cie|dinheiro)\b/.test(lower)) {
      ehContaCorrenteSelecionada = true;
    } else {
      // Tentar número (1, 2, 3...)
      const numMatch = lower.match(/^(\d+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        if (idx >= 0 && idx < cartoes.length) {
          cartaoId = cartoes[idx].id;
        } else if (idx === cartoes.length) {
          // Número correspondente à opção "Conta corrente" na lista
          ehContaCorrenteSelecionada = true;
        }
      }

      // "foi no cartão", "cartão", "crédito" sem nome específico
      if (!cartaoId && !ehContaCorrenteSelecionada && /\b(cart[aã]o|cr[eé]dito)\b/.test(lower)) {
        if (cartoes.length === 1) {
          cartaoId = cartoes[0].id;
        } else {
          const opcoes = cartoes.map((c, i) => `  ${i + 1}. ${c.nome}`).join('\n');
          return `Qual cartão? 😊\n\n${opcoes}\n\n_Ou "conta corrente" / "cancelar"._`;
        }
      }

      // Tentar nome parcial do cartão
      if (!cartaoId && !ehContaCorrenteSelecionada) {
        const match = cartoes.find(c => c.nome.toLowerCase().includes(lower) || lower.includes(c.nome.toLowerCase()));
        if (match) cartaoId = match.id;
      }

      // Não reconheceu — pedir de novo
      if (!cartaoId && !ehContaCorrenteSelecionada) {
        const opcoes = cartoes.map((c, i) => `  ${i + 1}. ${c.nome}`).join('\n');
        return `Não entendi 😅 Responde com o número ou nome:\n\n${opcoes}\n  ${cartoes.length + 1}. Conta corrente\n\n_Ou "cancelar" pra desistir._`;
      }
    }

    delete pendente.aguardandoCartao;
    delete pendente.cartoesDisponiveis;
    limparTransacaoPendente(usuarioId);
    if (pendente.parcelas && pendente.parcelas > 1) {
      return await salvarTransacaoParcelada(usuarioId, pendente.valor, pendente.descricao, pendente.categoria, pendente.data, cartaoId, pendente.parcelas);
    }
    return await salvarTransacao(usuarioId, pendente.tipo, pendente.valor, pendente.descricao, pendente.categoria, pendente.data, pendente.status || 'pago', cartaoId);
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
    return mensagemApresentacao();
  }

  const resultado = await interpretarMensagem(texto, usuarioId);

  if (!resultado) {
    const saudacoes = ['oi', 'olá', 'ola', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'e aí', 'eai'];
    if (saudacoes.some(s => texto.toLowerCase().includes(s))) {
      return ajudaMsg();
    }
  }

  return await processarResultadoIA(usuarioId, resultado, null, texto, enviarAck);
}

async function handleImageMessage(usuarioId, base64Data, mimetype) {
  const resultado = await analisarImagem(base64Data, mimetype, usuarioId);

  if (!resultado) {
    return '❌ Não consegui analisar a imagem. Envie uma foto clara de um boleto, nota fiscal ou cupom.';
  }

  // Se não for transação (imagem não financeira), retorna resposta criativa do AI
  if (resultado.acao !== 'transacao' && resultado.acao !== 'transacoes_multiplas') {
    return resultado.resposta || '😄 Não encontrei nenhum documento financeiro aí... Manda um boleto, nota fiscal, cupom ou recibo que eu registro na hora! 🧾';
  }

  // Múltiplos itens de imagem (cupom fiscal com vários produtos)
  if (resultado.acao === 'transacoes_multiplas' && resultado.itens && resultado.itens.length > 0) {
    salvarConfirmacao(usuarioId, {
      multiplos: true,
      itens: resultado.itens,
    });

    let resumo = `📄 *${resultado.itens.length} itens identificados:*\n\n`;
    for (const item of resultado.itens) {
      resumo += `• ${item.descricao} — ${fmt.formatarMoeda(item.valor)}\n`;
    }
    resumo += `\nEsses lançamentos já foram pagos ou ainda estão pendentes?\n\n`;
    resumo += `*1* - ✅ Já paguei / Já recebi\n`;
    resumo += `*2* - ⏳ A pagar / A receber\n`;
    resumo += `*0* - ❌ Cancelar`;
    return resumo;
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
  // Salvar no Postgres e enfileirar no BullMQ com delay preciso
  const id = await db.createReminder(usuarioId, mensagem, disparaEm.toISOString());
  try {
    const { reminderQueue } = require('./queue');
    const delay = Math.max(0, disparaEm.getTime() - Date.now());
    await reminderQueue.add('reminder',
      { tipo: 'one_time', reminderId: id },
      { jobId: `one-${id}`, delay, removeOnComplete: true,
        attempts: 5, backoff: { type: 'exponential', delay: 10000 } }
    );
  } catch (err) {
    console.error('[HANDLER] Erro ao enfileirar lembrete no BullMQ:', err.message);
    // O sweeper vai re-enfileirar depois se necessário
  }

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
  // Busca nos dois sistemas: novo (reminders) + legado (lembretes_gerais)
  const [novos, legados] = await Promise.all([
    db.buscarRemindersAgendados(usuarioId),
    db.listarLembretesGerais(usuarioId),
  ]);
  const lembretes = [...novos, ...legados];

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
  const [novos, legados, recorrentes] = await Promise.all([
    db.buscarRemindersAgendados(usuarioId),
    db.listarLembretesGerais(usuarioId),
    db.listarLembretesRecorrentes(usuarioId),
  ]);
  const lembretes = [...novos, ...legados];

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

  // Tentar cancelar primeiro na tabela nova (reminders), depois na legada (lembretes_gerais)
  const resultado = await db.cancelReminder(id, usuarioId)
    || await db.cancelarLembreteGeral(usuarioId, id);

  if (!resultado) {
    return `❌ Lembrete #${id} não encontrado ou já foi enviado.`;
  }

  return `✅ Lembrete #${id} cancelado!\n\n_"${resultado.mensagem}"_`;
}

const NOMES_DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

async function handleTransacaoRecorrente(usuarioId, resultado) {
  const { tipo, valor, descricao, frequencia, dia_mes, dia_semana } = resultado;
  const categoria = (!resultado.categoria || resultado.categoria === 'null' || resultado.categoria === 'undefined') ? 'Outros' : resultado.categoria;

  if (!valor || valor <= 0) {
    salvarRecorrenciaValorPendente(usuarioId, { tipo, descricao, categoria, frequencia, dia_mes, dia_semana });
    const periodo = frequencia === 'semanal' ? 'semana' : 'mês';
    const nome = descricao ? ` de *${descricao}*` : '';
    return `💰 Preciso do valor para cadastrar a recorrência${nome}. Quanto é por ${periodo}?`;
  }
  if (!descricao) {
    return '❌ Preciso saber o nome dessa despesa/receita recorrente.';
  }

  // Para recorrências mensais sem dia definido, perguntar ao usuário
  if (frequencia !== 'semanal' && !dia_mes && dia_mes !== 0) {
    salvarRecorrenciaDiaPendente(usuarioId, { tipo, valor, descricao, categoria, frequencia, dia_semana });
    return `📅 Pra qual *dia do mês* você quer cadastrar essa recorrência de *${descricao}*?\n\n_Ex: "5", "10", "20"_`;
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

async function handleRecorrenciaDiaResposta(usuarioId, msg, pendente) {
  const lower = msg.trim().toLowerCase();

  if (lower === 'cancelar' || lower === '0') {
    limparRecorrenciaDiaPendente(usuarioId);
    return '❌ Cadastro de recorrência cancelado.';
  }

  const dia = parseInt(lower.replace(/^dia\s*/, ''), 10);
  if (isNaN(dia) || dia < 1 || dia > 31) {
    return '❌ Informe um dia válido entre 1 e 31.\n\n_Ex: "5", "10", "dia 20"_';
  }

  limparRecorrenciaDiaPendente(usuarioId);
  return await handleTransacaoRecorrente(usuarioId, { ...pendente, dia_mes: dia });
}

async function handleRecorrenciaValorResposta(usuarioId, msg, pendente) {
  const lower = msg.trim().toLowerCase();

  if (lower === 'cancelar' || lower === '0') {
    limparRecorrenciaValorPendente(usuarioId);
    return '❌ Cadastro de recorrência cancelado.';
  }

  const valor = extrairValorDoTexto(msg);
  if (!valor || valor <= 0) {
    return '❌ Não entendi o valor. Informe um número válido.\n\n_Ex: "500", "1200,50", "R$ 3.000"_';
  }

  limparRecorrenciaValorPendente(usuarioId);
  return await handleTransacaoRecorrente(usuarioId, { ...pendente, valor });
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

  const diaSemanaFinal = frequencia === 'semanal' ? (dia_semana ?? new Date().getDay()) : null;
  const diaMesFinal = frequencia === 'mensal' ? (dia_mes ?? new Date().getDate()) : null;

  const id = await db.criarLembreteRecorrente(
    usuarioId, mensagem, horario, frequencia,
    diaSemanaFinal,
    diaMesFinal,
    dataFim
  );

  // Agendar a primeira ocorrência na fila BullMQ
  try {
    const { reminderQueue } = require('./queue');
    const regraParaCalculo = {
      id, horario, frequencia,
      dia_semana: diaSemanaFinal,
      dia_mes: diaMesFinal,
      data_fim: dataFim,
    };
    const proxima = db.calcularProximaOcorrenciaRecorrente(regraParaCalculo, new Date());
    if (proxima) {
      const delay = Math.max(0, proxima.getTime() - Date.now());
      const spDateJobId = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(proxima);
      const jobId = `rec-${id}-${spDateJobId}`;
      await reminderQueue.add('reminder',
        { tipo: 'recurrente', lembreteRecorrenteId: id, runAt: proxima.toISOString() },
        { jobId, delay, removeOnComplete: true, attempts: 3,
          backoff: { type: 'exponential', delay: 30000 } }
      );
      const delayMin = Math.round(delay / 60000);
      console.log(`[HANDLER] Recorrente #${id} enfileirado: próxima ocorrência ${proxima.toISOString()} (delay ~${delayMin}min, jobId=${jobId})`);
    } else {
      console.warn(`[HANDLER] Recorrente #${id}: calcularProximaOcorrencia retornou null — sem job agendado`);
    }
  } catch (err) {
    console.error('[HANDLER] Erro ao enfileirar recorrente no BullMQ:', err.message);
  }

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
    const { total: faturaAtual, qtd, inicioStr } = await db.calcularUsoCartao(c.id, c.dia_fechamento);
    const comprometido = await db.calcularCreditoComprometido(c.id);
    const limite = c.limite_total;
    const disponivel = limite ? limite - comprometido : null;
    const pct = limite ? Math.round((comprometido / limite) * 100) : null;
    const cor = pct !== null ? (pct >= 80 ? '🔴' : pct >= 50 ? '🟡' : '🟢') : '🔵';

    msg += `*${c.nome}*`;
    if (c.dia_vencimento) msg += ` — vence dia ${c.dia_vencimento}`;
    msg += `\n`;
    msg += `  💸 Fatura atual: *${fmt.formatarMoeda(faturaAtual)}* (${qtd} compras no ciclo)\n`;
    if (comprometido > faturaAtual) {
      msg += `  ⏳ Total comprometido: *${fmt.formatarMoeda(comprometido)}* (inclui parcelas futuras)\n`;
    }
    if (limite) msg += `  💳 Limite: ${fmt.formatarMoeda(limite)} ${cor} ${pct}% comprometido\n`;
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

  // Resolver data: se informada e futura → aporte agendado (pendente); senão → imediato
  let dataAporte = null;
  if (resultado.data) {
    dataAporte = resolverData(resultado.data);
    if (!dataAporte && resultado.data.includes('/')) dataAporte = parseData(resultado.data);
  }
  const hojeISO = dateParaISO(new Date());
  const isAgendado = dataAporte && dataAporte > hojeISO;

  if (isAgendado) {
    // Criar despesa pendente — a caixinha só é atualizada quando o usuário pagar
    await db.adicionarTransacao(usuarioId, 'despesa', valor, `Aporte - ${caixinha.nome}`, 'Investimentos', dataAporte, 'pendente');
    return `📅 Aporte agendado!\n\n` +
      `  Caixinha: *${caixinha.nome}*\n` +
      `  Valor: *${fmt.formatarMoeda(valor)}*\n` +
      `  Data: *${fmt.formatarData(dataAporte)}*\n\n` +
      `No dia ${fmt.formatarData(dataAporte)} vou te lembrar de confirmar. É só responder _"paguei"_ e o valor é adicionado à caixinha automaticamente! 💰`;
  }

  // Depósito imediato
  const saldoAnterior = caixinha.saldo;
  const atualizada = await db.adicionarSaldoCaixinha(caixinha.id, valor);
  const novoSaldo = atualizada.saldo;
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

  // Se é uma categoria principal (Despesas Fixas, Variáveis, Lazer, etc.), salva sem parent
  const PRINCIPAIS_PADRAO = ['Despesas Fixas', 'Variáveis', 'Lazer', 'Investimentos', 'Objetivos'];
  const catsPrincipaisDB = await db.listarCategoriasPrincipais(usuarioId);
  const nomesPrincipais = catsPrincipaisDB.length > 0
    ? catsPrincipaisDB.map(c => c.nome)
    : PRINCIPAIS_PADRAO;
  if (nomesPrincipais.includes(categoria)) {
    await db.definirLimite(usuarioId, categoria, valor, null);
    return `✅ *Limite definido!*\n\n📂 Categoria principal: ${categoria}\n💰 Limite mensal: ${fmt.formatarMoeda(valor)}\n\n_Vou te avisar sempre que registrar uma despesa nessa categoria!_`;
  }

  // Subcategoria: resolver a principal e salvar com parent
  const budgetCat = await resolverBudgetCategoria(categoria);
  const parent = budgetCat || 'Variáveis';
  await db.definirLimite(usuarioId, categoria, valor, parent);

  // Verificar se soma das subs excede o limite da principal
  let aviso = '';
  const limitePrincipal = await db.verificarLimite(usuarioId, parent);
  if (limitePrincipal) {
    const limites = await db.listarLimites(usuarioId);
    const somaSubs = limites
      .filter(l => l.parent === parent)
      .reduce((s, l) => s + l.valor_limite, 0);
    if (somaSubs > limitePrincipal.limite) {
      aviso = `\n\n⚠️ _Atenção: a soma das subcategorias de ${parent} (${fmt.formatarMoeda(somaSubs)}) excede o limite da principal (${fmt.formatarMoeda(limitePrincipal.limite)}). Considere ajustar!_`;
    }
  }

  return `✅ *Limite definido!*\n\n📂 Subcategoria: ${categoria} _(dentro de ${parent})_\n💰 Limite mensal: ${fmt.formatarMoeda(valor)}\n\n_Vou te avisar sempre que registrar uma despesa nessa categoria!_${aviso}`;
}

async function handleListarLimites(usuarioId) {
  const grupos = await db.listarLimitesComSub(usuarioId);

  if (grupos.length === 0) {
    return '📊 Você ainda não definiu nenhum limite de gastos.\n\n_Dica: Me fala algo como "limitar gastos com Alimentação em 1000 reais"_';
  }

  let msg = '📊 *Seus limites de gastos:*\n\n';
  for (const g of grupos) {
    // Categoria principal
    const subcats = [...(MAPA_BUDGET[g.categoria] || [])];
    const info = await db.verificarLimite(usuarioId, g.categoria, subcats.length > 0 ? subcats : null);
    if (!info) continue;

    const { gastos, limite, restante, percentual } = info;
    let emoji = '';
    if (percentual >= 100) emoji = '🚨';
    else if (percentual >= 80) emoji = '⚠️';
    else if (percentual >= 60) emoji = '📊';
    else emoji = '✅';

    msg += `${emoji} *${g.categoria}* — ${fmt.formatarMoeda(limite)}\n`;
    msg += `   Gasto: ${fmt.formatarMoeda(gastos)} (${percentual}%)`;
    if (restante > 0) msg += ` | Restam: ${fmt.formatarMoeda(restante)}`;
    else msg += ` | ⚠️ Excedido em ${fmt.formatarMoeda(Math.abs(restante))}`;
    msg += '\n';

    // Subcategorias
    for (const sub of g.subs) {
      const subInfo = await db.verificarLimiteSub(usuarioId, sub.categoria);
      if (!subInfo) continue;
      let subEmoji = '';
      if (subInfo.percentual >= 100) subEmoji = '🚨';
      else if (subInfo.percentual >= 80) subEmoji = '⚠️';
      else subEmoji = '✅';
      msg += `   ${subEmoji} ${sub.categoria}: ${fmt.formatarMoeda(subInfo.gastos)}/${fmt.formatarMoeda(sub.valor_limite)} (${subInfo.percentual}%)\n`;
    }

    // Valor livre (não alocado em subcategorias)
    const somaSubs = g.subs.reduce((s, sub) => s + sub.valor_limite, 0);
    const livre = g.valor_limite - somaSubs;
    if (livre > 0 && g.subs.length > 0) {
      msg += `   💡 ${fmt.formatarMoeda(livre)} livre\n`;
    }
    msg += '\n';
  }

  return msg;
}

async function handleRemoverCartao(usuarioId, resultado) {
  const { cartao_nome } = resultado;

  const cartoes = cartao_nome
    ? await db.buscarCartoesPorNome(usuarioId, cartao_nome)
    : await db.listarCartoes(usuarioId);

  if (cartoes.length === 0) {
    return cartao_nome
      ? `❌ Não encontrei nenhum cartão com o nome *${cartao_nome}*.\n_Use "meus cartões" para ver os cadastrados._`
      : `❌ Você não tem cartões cadastrados.\n_Cadastre com "novo cartão" ou pelo fluxo Finanças em Dia._`;
  }

  if (cartoes.length > 1 || !cartao_nome) {
    const lista = cartoes.map((c, i) => `  ${i + 1}. *${c.nome}*`).join('\n');
    salvarRemoverCartaoPendente(usuarioId, { cartoes });
    return `Qual cartão você quer remover?\n\n${lista}\n\nResponda com o *número* ou *"cancelar"* para desistir.`;
  }

  const cartao = cartoes[0];
  const nomeRemovido = await db.deletarCartaoCompleto(usuarioId, cartao.id);
  if (!nomeRemovido) {
    return `❌ Não foi possível remover o cartão.`;
  }

  return `✅ Cartão *${nomeRemovido}* removido com sucesso!\n\n_Todas as transações, recorrências e lembretes vinculados a esse cartão foram excluídos._`;
}

async function handleEscolhaRemoverCartao(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();

  if (lower === 'cancelar' || lower === 'cancela' || lower === 'não' || lower === 'nao') {
    limparRemoverCartaoPendente(usuarioId);
    return '❌ Remoção de cartão cancelada.';
  }

  const num = parseInt(msg.trim(), 10);
  if (isNaN(num) || num < 1 || num > pendente.cartoes.length) {
    // Tentar buscar pelo nome exato
    const cartaoByName = pendente.cartoes.find(c => c.nome.toLowerCase() === lower);
    if (cartaoByName) {
      limparRemoverCartaoPendente(usuarioId);
      const nomeRemovido = await db.deletarCartaoCompleto(usuarioId, cartaoByName.id);
      if (!nomeRemovido) return '❌ Não foi possível remover o cartão.';
      return `✅ Cartão *${nomeRemovido}* removido com sucesso!\n\n_Todas as transações, recorrências e lembretes vinculados a esse cartão foram excluídos._`;
    }
    return `❌ Número inválido. Escolha entre 1 e ${pendente.cartoes.length}, ou "cancelar".`;
  }

  const cartao = pendente.cartoes[num - 1];
  limparRemoverCartaoPendente(usuarioId);
  const nomeRemovido = await db.deletarCartaoCompleto(usuarioId, cartao.id);
  if (!nomeRemovido) return '❌ Não foi possível remover o cartão.';
  return `✅ Cartão *${nomeRemovido}* removido com sucesso!\n\n_Todas as transações, recorrências e lembretes vinculados a esse cartão foram excluídos._`;
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

// ─── EDITAR CARTÃO ─────────────────────────────────────────
async function handleEditarCartao(usuarioId, resultado) {
  const { cartao_nome, campo, novo_valor } = resultado;

  const cartoes = cartao_nome
    ? await db.buscarCartoesPorNome(usuarioId, cartao_nome)
    : await db.listarCartoes(usuarioId);

  if (cartoes.length === 0) {
    return cartao_nome
      ? `❌ Não encontrei cartão com o nome *${cartao_nome}*.\n_Use "meus cartões" para ver os cadastrados._`
      : `❌ Você não tem cartões cadastrados.`;
  }

  if (cartoes.length > 1 || !cartao_nome) {
    const lista = cartoes.map((c, i) => `  ${i + 1}. 💳 *${c.nome}* — limite ${fmt.formatarMoeda(c.limite_total || 0)}`).join('\n');
    salvarEditarCartaoPendente(usuarioId, { fase: 'selecionar', cartoes, campo: campo || null, novo_valor: novo_valor || null });
    return `Qual cartão quer editar?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
  }

  const c = cartoes[0];
  if (campo && novo_valor) {
    return aplicarEdicaoCartao(usuarioId, c, campo, novo_valor);
  }
  if (campo) {
    salvarEditarCartaoPendente(usuarioId, { fase: 'aguardando_valor', cartao: c, campo });
    const labels = { limite_total: 'novo limite (ex: R$ 5.000)', dia_fechamento: 'novo dia de fechamento (ex: 10)', dia_vencimento: 'novo dia de vencimento (ex: 17)', nome: 'novo nome' };
    return `💳 *${c.nome}*\nLimite: ${fmt.formatarMoeda(c.limite_total || 0)} | Fecha dia ${c.dia_fechamento || '?'} | Vence dia ${c.dia_vencimento || '?'}\n\nQual o ${labels[campo] || campo}?`;
  }

  salvarEditarCartaoPendente(usuarioId, { fase: 'escolher_campo', cartao: c });
  return `💳 *${c.nome}*\nLimite: ${fmt.formatarMoeda(c.limite_total || 0)} | Fecha dia ${c.dia_fechamento || '?'} | Vence dia ${c.dia_vencimento || '?'}\n\nO que quer editar?\n\n_Ex: "limite para R$ 5.000", "fechamento dia 10", "vencimento dia 17", "nome para Nubank Gold"_`;
}

async function aplicarEdicaoCartao(usuarioId, c, campo, novoValorStr) {
  let valorFinal = novoValorStr;
  let campoDb = campo;

  if (campo === 'limite' || campo === 'limite_total') {
    const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
    if (!v || v <= 0) return `❌ Limite inválido: "${novoValorStr}". Ex: _"R$ 5.000"_`;
    valorFinal = v;
    campoDb = 'limite_total';
  } else if (campo === 'fechamento' || campo === 'dia_fechamento') {
    const d = parseInt(novoValorStr.toString().replace(/\D/g, ''), 10);
    if (isNaN(d) || d < 1 || d > 31) return `❌ Dia inválido. Informe um dia de 1 a 31.`;
    valorFinal = d;
    campoDb = 'dia_fechamento';
  } else if (campo === 'vencimento' || campo === 'dia_vencimento') {
    const d = parseInt(novoValorStr.toString().replace(/\D/g, ''), 10);
    if (isNaN(d) || d < 1 || d > 31) return `❌ Dia inválido. Informe um dia de 1 a 31.`;
    valorFinal = d;
    campoDb = 'dia_vencimento';
  } else if (campo === 'nome') {
    valorFinal = novoValorStr.trim();
    if (!valorFinal) return `❌ Nome inválido.`;
  } else {
    return `❌ Campo "${campo}" não pode ser editado. Campos disponíveis: limite, fechamento, vencimento, nome.`;
  }

  const atualizado = await db.atualizarCartao(usuarioId, c.id, campoDb, valorFinal);
  if (!atualizado) return `❌ Não consegui atualizar o cartão.`;

  const labelsAntes = { limite_total: fmt.formatarMoeda(c.limite_total || 0), dia_fechamento: `dia ${c.dia_fechamento || '?'}`, dia_vencimento: `dia ${c.dia_vencimento || '?'}`, nome: c.nome };
  const labelsDepois = { limite_total: fmt.formatarMoeda(atualizado.limite_total || 0), dia_fechamento: `dia ${atualizado.dia_fechamento}`, dia_vencimento: `dia ${atualizado.dia_vencimento}`, nome: atualizado.nome };
  return `✅ Cartão *${atualizado.nome}* atualizado!\n\n${labelsAntes[campoDb]} → *${labelsDepois[campoDb]}*`;
}

function detectarCampoCartao(lower) {
  if (/\b(limite|credito|crédito)\b/.test(lower)) return 'limite_total';
  if (/\b(fecha|fechamento)\b/.test(lower)) return 'dia_fechamento';
  if (/\b(vence|vencimento)\b/.test(lower)) return 'dia_vencimento';
  if (/\b(nome|renomear)\b/.test(lower)) return 'nome';
  return null;
}

async function handleEditarCartaoPendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();
  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarCartaoPendente(usuarioId);
    return '❌ Cancelado.';
  }

  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > pendente.cartoes.length) {
      return `Responda com um número de 1 a ${pendente.cartoes.length}, ou _"cancelar"_.`;
    }
    const c = pendente.cartoes[num - 1];
    if (pendente.campo && pendente.novo_valor) {
      limparEditarCartaoPendente(usuarioId);
      return aplicarEdicaoCartao(usuarioId, c, pendente.campo, pendente.novo_valor);
    }
    salvarEditarCartaoPendente(usuarioId, { fase: 'escolher_campo', cartao: c });
    return `💳 *${c.nome}*\nLimite: ${fmt.formatarMoeda(c.limite_total || 0)} | Fecha dia ${c.dia_fechamento || '?'} | Vence dia ${c.dia_vencimento || '?'}\n\nO que quer editar?\n\n_Ex: "limite para R$ 5.000", "fechamento dia 10", "vencimento dia 17", "nome para Nubank Gold"_`;
  }

  if (pendente.fase === 'escolher_campo') {
    const c = pendente.cartao;
    const campo = detectarCampoCartao(lower);
    if (!campo) {
      return `Não entendi. O que quer mudar?\n\n_"limite para R$ X", "fechamento dia X", "vencimento dia X", "nome para X"_`;
    }
    const match = msg.match(/(?:para|pra|=)\s*(.+)/i);
    if (match) {
      limparEditarCartaoPendente(usuarioId);
      return aplicarEdicaoCartao(usuarioId, c, campo, match[1].trim());
    }
    salvarEditarCartaoPendente(usuarioId, { fase: 'aguardando_valor', cartao: c, campo });
    const labels = { limite_total: 'novo limite (ex: R$ 5.000)', dia_fechamento: 'novo dia de fechamento (1 a 31)', dia_vencimento: 'novo dia de vencimento (1 a 31)', nome: 'novo nome' };
    return `Qual o ${labels[campo] || campo}?`;
  }

  if (pendente.fase === 'aguardando_valor') {
    const c = pendente.cartao;
    limparEditarCartaoPendente(usuarioId);
    return aplicarEdicaoCartao(usuarioId, c, pendente.campo, msg.trim());
  }

  limparEditarCartaoPendente(usuarioId);
  return null;
}

// ─── EDITAR / EXCLUIR CAIXINHA ─────────────────────────────
async function handleEditarCaixinha(usuarioId, resultado) {
  const { nome, campo, novo_valor } = resultado;

  const caixinhas = nome
    ? await db.buscarCaixinhasPorNome(usuarioId, nome)
    : await db.listarCaixinhas(usuarioId);

  if (caixinhas.length === 0) {
    return nome
      ? `❌ Não encontrei caixinha com o nome *${nome}*.\n_Use "caixinhas" para ver as cadastradas._`
      : `❌ Você não tem caixinhas cadastradas.`;
  }

  if (caixinhas.length > 1 || !nome) {
    const lista = caixinhas.map((c, i) => `  ${i + 1}. 💰 *${c.nome}* — ${fmt.formatarMoeda(c.saldo)}`).join('\n');
    salvarEditarCaixinhaPendente(usuarioId, { fase: 'selecionar', caixinhas, campo: campo || null, novo_valor: novo_valor || null, acao: 'editar' });
    return `Qual caixinha quer editar?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
  }

  const c = caixinhas[0];
  if (campo && novo_valor) {
    return aplicarEdicaoCaixinha(usuarioId, c, campo, novo_valor);
  }

  salvarEditarCaixinhaPendente(usuarioId, { fase: 'escolher_campo', caixinha: c });
  return resumoCaixinhaEdit(c) + `\n\nO que quer editar?\n\n_Ex: "nome para CDB Inter", "meta para R$ 10.000", "rendimento para 1.2", "tipo para CDB"_`;
}

function resumoCaixinhaEdit(c) {
  let r = `💰 *${c.nome}*\n   Saldo: ${fmt.formatarMoeda(c.saldo)}`;
  if (c.meta) r += ` | Meta: ${fmt.formatarMoeda(c.meta)}`;
  if (c.tipo) r += `\n   Tipo: ${c.tipo}`;
  if (c.rendimento_mensal) r += ` | Rendimento: ${c.rendimento_mensal}%/mês`;
  return r;
}

async function aplicarEdicaoCaixinha(usuarioId, c, campo, novoValorStr) {
  let valorFinal = novoValorStr;
  let campoDb = campo;

  if (campo === 'meta' || campo === 'saldo') {
    const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(v) || v < 0) return `❌ Valor inválido: "${novoValorStr}".`;
    valorFinal = v;
  } else if (campo === 'rendimento' || campo === 'rendimento_mensal') {
    const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
    if (isNaN(v)) return `❌ Rendimento inválido: "${novoValorStr}". Ex: _"1.2"_ (para 1.2%/mês)`;
    valorFinal = v;
    campoDb = 'rendimento_mensal';
  } else if (campo === 'nome' || campo === 'tipo') {
    valorFinal = novoValorStr.trim();
    if (!valorFinal) return `❌ Texto inválido.`;
  } else {
    return `❌ Campo "${campo}" não pode ser editado. Campos: nome, saldo, meta, tipo, rendimento.`;
  }

  const atualizada = await db.atualizarCaixinha(usuarioId, c.id, campoDb, valorFinal);
  if (!atualizada) return `❌ Não consegui atualizar a caixinha.`;

  const antes = { nome: c.nome, saldo: fmt.formatarMoeda(c.saldo), meta: fmt.formatarMoeda(c.meta || 0), tipo: c.tipo || '—', rendimento_mensal: `${c.rendimento_mensal || 0}%/mês` };
  const depois = { nome: atualizada.nome, saldo: fmt.formatarMoeda(atualizada.saldo), meta: fmt.formatarMoeda(atualizada.meta || 0), tipo: atualizada.tipo || '—', rendimento_mensal: `${atualizada.rendimento_mensal || 0}%/mês` };
  return `✅ Caixinha *${atualizada.nome}* atualizada!\n\n${antes[campoDb]} → *${depois[campoDb]}*`;
}

function detectarCampoCaixinha(lower) {
  if (/\b(nome|renomear)\b/.test(lower)) return 'nome';
  if (/\b(saldo|valor)\b/.test(lower)) return 'saldo';
  if (/\b(meta|objetivo)\b/.test(lower)) return 'meta';
  if (/\b(tipo|modalidade)\b/.test(lower)) return 'tipo';
  if (/\b(rendimento|rentabilidade|juros)\b/.test(lower)) return 'rendimento_mensal';
  return null;
}

async function handleEditarCaixinhaPendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();
  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarCaixinhaPendente(usuarioId);
    return '❌ Cancelado.';
  }

  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > (pendente.caixinhas || pendente.cartoes || []).length) {
      const items = pendente.caixinhas || [];
      return `Responda com um número de 1 a ${items.length}, ou _"cancelar"_.`;
    }
    const c = pendente.caixinhas[num - 1];
    if (pendente.acao === 'excluir') {
      limparEditarCaixinhaPendente(usuarioId);
      return executarExclusaoCaixinha(usuarioId, c);
    }
    if (pendente.campo && pendente.novo_valor) {
      limparEditarCaixinhaPendente(usuarioId);
      return aplicarEdicaoCaixinha(usuarioId, c, pendente.campo, pendente.novo_valor);
    }
    salvarEditarCaixinhaPendente(usuarioId, { fase: 'escolher_campo', caixinha: c });
    return resumoCaixinhaEdit(c) + `\n\nO que quer editar?\n\n_Ex: "nome para CDB Inter", "meta para R$ 10.000", "rendimento para 1.2", "tipo para CDB"_`;
  }

  if (pendente.fase === 'escolher_campo') {
    const c = pendente.caixinha;
    const campo = detectarCampoCaixinha(lower);
    if (!campo) {
      return `Não entendi. O que quer mudar?\n\n_"nome para X", "meta para R$ X", "saldo para R$ X", "tipo X", "rendimento X"_`;
    }
    const match = msg.match(/(?:para|pra|=)\s*(.+)/i);
    if (match) {
      limparEditarCaixinhaPendente(usuarioId);
      return aplicarEdicaoCaixinha(usuarioId, c, campo, match[1].trim());
    }
    salvarEditarCaixinhaPendente(usuarioId, { fase: 'aguardando_valor', caixinha: c, campo });
    const labels = { nome: 'novo nome', saldo: 'novo saldo (ex: R$ 5.000)', meta: 'nova meta (ex: R$ 10.000)', tipo: 'novo tipo (ex: CDB, Poupança)', rendimento_mensal: 'novo rendimento mensal (ex: 1.2)' };
    return `Qual o ${labels[campo] || campo}?`;
  }

  if (pendente.fase === 'aguardando_valor') {
    const c = pendente.caixinha;
    limparEditarCaixinhaPendente(usuarioId);
    return aplicarEdicaoCaixinha(usuarioId, c, pendente.campo, msg.trim());
  }

  limparEditarCaixinhaPendente(usuarioId);
  return null;
}

async function handleExcluirCaixinha(usuarioId, resultado) {
  const { nome } = resultado;

  const caixinhas = nome
    ? await db.buscarCaixinhasPorNome(usuarioId, nome)
    : await db.listarCaixinhas(usuarioId);

  if (caixinhas.length === 0) {
    return nome
      ? `❌ Não encontrei caixinha com o nome *${nome}*.\n_Use "caixinhas" para ver as cadastradas._`
      : `❌ Você não tem caixinhas cadastradas.`;
  }

  if (caixinhas.length > 1 || !nome) {
    const lista = caixinhas.map((c, i) => `  ${i + 1}. 💰 *${c.nome}* — ${fmt.formatarMoeda(c.saldo)}`).join('\n');
    salvarEditarCaixinhaPendente(usuarioId, { fase: 'selecionar', caixinhas, acao: 'excluir' });
    return `Qual caixinha quer excluir?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
  }

  return executarExclusaoCaixinha(usuarioId, caixinhas[0]);
}

async function executarExclusaoCaixinha(usuarioId, c) {
  const removida = await db.excluirCaixinha(usuarioId, c.id);
  if (!removida) return `❌ Não consegui excluir a caixinha.`;
  return `✅ Caixinha *${removida.nome}* excluída com sucesso!`;
}

// ─── EDITAR LIMITE DE GASTOS ─────────────────────────────
async function handleEditarLimite(usuarioId, resultado) {
  const { categoria, novo_valor } = resultado;

  if (!categoria) {
    const limites = await db.listarLimites(usuarioId);
    if (limites.length === 0) return `❌ Você não tem limites cadastrados.\n_Use "limitar gastos com X em R$ Y" para criar._`;
    const lista = limites.filter(l => !l.parent).map((l, i) => `  ${i + 1}. *${l.categoria}* — ${fmt.formatarMoeda(l.valor_limite)}`).join('\n');
    salvarEditarLimitePendente(usuarioId, { fase: 'selecionar', limites: limites.filter(l => !l.parent), novo_valor: novo_valor || null });
    return `Qual limite quer editar?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
  }

  if (novo_valor) {
    return aplicarEdicaoLimite(usuarioId, categoria, novo_valor);
  }

  salvarEditarLimitePendente(usuarioId, { fase: 'aguardando_valor', categoria });
  return `Qual o novo valor do limite para *${categoria}*?\n\n_Ex: "R$ 800" ou "1500"_`;
}

async function aplicarEdicaoLimite(usuarioId, categoria, novoValorStr, parent) {
  const v = parseFloat(novoValorStr.toString().replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!v || v <= 0) return `❌ Valor inválido: "${novoValorStr}". Ex: _"R$ 800"_`;

  const id = await db.definirLimite(usuarioId, categoria, v, parent || null);
  if (!id) return `❌ Não consegui atualizar o limite.`;
  return `✅ Limite de *${categoria}* atualizado para *${fmt.formatarMoeda(v)}*!`;
}

async function handleEditarLimitePendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();
  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarLimitePendente(usuarioId);
    return '❌ Cancelado.';
  }

  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > pendente.limites.length) {
      return `Responda com um número de 1 a ${pendente.limites.length}, ou _"cancelar"_.`;
    }
    const l = pendente.limites[num - 1];
    if (pendente.novo_valor) {
      limparEditarLimitePendente(usuarioId);
      return aplicarEdicaoLimite(usuarioId, l.categoria, pendente.novo_valor);
    }
    salvarEditarLimitePendente(usuarioId, { fase: 'aguardando_valor', categoria: l.categoria });
    return `Qual o novo valor do limite para *${l.categoria}*? (atual: ${fmt.formatarMoeda(l.valor_limite)})\n\n_Ex: "R$ 800" ou "1500"_`;
  }

  if (pendente.fase === 'aguardando_valor') {
    limparEditarLimitePendente(usuarioId);
    return aplicarEdicaoLimite(usuarioId, pendente.categoria, msg.trim());
  }

  limparEditarLimitePendente(usuarioId);
  return null;
}

// ─── EDITAR LEMBRETE (GERAL E RECORRENTE) ────────────────
async function handleEditarLembrete(usuarioId, resultado) {
  const { tipo_lembrete } = resultado; // 'geral' ou 'recorrente'

  if (tipo_lembrete === 'recorrente' || !tipo_lembrete) {
    const lembretes = await db.listarLembretesRecorrentes(usuarioId);
    if (lembretes.length === 0) {
      if (tipo_lembrete === 'recorrente') return `❌ Você não tem lembretes recorrentes ativos.`;
      // Tenta lembretes gerais
      const gerais = await db.listarLembretesGerais(usuarioId);
      if (gerais.length === 0) return `❌ Você não tem lembretes cadastrados.`;
      return montarListaLembretesGeraisParaEditar(usuarioId, gerais);
    }
    if (tipo_lembrete !== 'recorrente') {
      // Mostrar ambos
      const gerais = await db.listarLembretesGerais(usuarioId);
      if (gerais.length > 0) {
        const listaRec = lembretes.map((l, i) => {
          const freq = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' }[l.frequencia] || l.frequencia;
          return `  ${i + 1}. 🔁 *${l.mensagem}* — ${freq} às ${l.horario}`;
        });
        const listaGer = gerais.map((l, i) => `  ${listaRec.length + i + 1}. ⏰ *${l.mensagem}* — ${l.horario}`);
        const todos = [...lembretes.map(l => ({ ...l, _tipo: 'recorrente' })), ...gerais.map(l => ({ ...l, _tipo: 'geral' }))];
        salvarEditarLembretePendente(usuarioId, { fase: 'selecionar', lembretes: todos });
        return `Qual lembrete quer editar?\n\n${[...listaRec, ...listaGer].join('\n')}\n\nResponda com o *número* ou _"cancelar"_.`;
      }
    }
    const lista = lembretes.map((l, i) => {
      const freq = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' }[l.frequencia] || l.frequencia;
      return `  ${i + 1}. 🔁 *${l.mensagem}* — ${freq} às ${l.horario}`;
    }).join('\n');
    salvarEditarLembretePendente(usuarioId, { fase: 'selecionar', lembretes: lembretes.map(l => ({ ...l, _tipo: 'recorrente' })) });
    return `Qual lembrete recorrente quer editar?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
  }

  // tipo_lembrete === 'geral'
  const gerais = await db.listarLembretesGerais(usuarioId);
  if (gerais.length === 0) return `❌ Você não tem lembretes únicos pendentes.`;
  return montarListaLembretesGeraisParaEditar(usuarioId, gerais);
}

function montarListaLembretesGeraisParaEditar(usuarioId, gerais) {
  const lista = gerais.map((l, i) => `  ${i + 1}. ⏰ *${l.mensagem}* — ${l.horario}`).join('\n');
  salvarEditarLembretePendente(usuarioId, { fase: 'selecionar', lembretes: gerais.map(l => ({ ...l, _tipo: 'geral' })) });
  return `Qual lembrete quer editar?\n\n${lista}\n\nResponda com o *número* ou _"cancelar"_.`;
}

async function handleEditarLembretePendente(usuarioId, msg, pendente) {
  const lower = msg.toLowerCase().trim();
  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(lower)) {
    limparEditarLembretePendente(usuarioId);
    return '❌ Cancelado.';
  }

  if (pendente.fase === 'selecionar') {
    const num = parseInt(msg.trim());
    if (!num || isNaN(num) || num < 1 || num > pendente.lembretes.length) {
      return `Responda com um número de 1 a ${pendente.lembretes.length}, ou _"cancelar"_.`;
    }
    const l = pendente.lembretes[num - 1];
    salvarEditarLembretePendente(usuarioId, { fase: 'escolher_campo', lembrete: l });

    if (l._tipo === 'recorrente') {
      const freq = { diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal' }[l.frequencia] || l.frequencia;
      return `🔁 *${l.mensagem}* — ${freq} às ${l.horario}\n\nO que quer editar?\n\n_Ex: "mensagem para Tomar remédio", "horário para 08:00", "frequência para semanal"_`;
    }
    return `⏰ *${l.mensagem}* — ${l.horario}\n\nO que quer editar?\n\n_Ex: "mensagem para Comprar presente", "data para 25/03 14:00"_`;
  }

  if (pendente.fase === 'escolher_campo') {
    const l = pendente.lembrete;
    let campo = null;
    let valor = null;

    if (/\b(mensagem|texto|nome)\b/.test(lower)) {
      campo = 'mensagem';
      const match = msg.match(/(?:para|pra|=)\s*(.+)/i);
      if (match) valor = match[1].trim();
    } else if (/\b(hor[aá]rio|hora|horario)\b/.test(lower)) {
      campo = 'horario';
      const match = msg.match(/(\d{1,2}[:\s]?\d{2})/);
      if (match) valor = match[1].replace(/\s/, ':');
    } else if (/\b(frequ[eê]ncia|frequencia|periodicidade)\b/.test(lower) && l._tipo === 'recorrente') {
      campo = 'frequencia';
      if (/di[aá]ri/i.test(lower)) valor = 'diario';
      else if (/semanal/i.test(lower)) valor = 'semanal';
      else if (/mensal/i.test(lower)) valor = 'mensal';
    } else if (/\b(data|dia|quando)\b/.test(lower) && l._tipo === 'geral') {
      campo = 'dispara_em';
      const match = msg.match(/(?:para|pra|=)\s*(.+)/i);
      if (match) valor = match[1].trim();
    }

    if (!campo) {
      if (l._tipo === 'recorrente') {
        return `Não entendi. O que quer mudar?\n\n_"mensagem para X", "horário para HH:MM", "frequência para diário/semanal/mensal"_`;
      }
      return `Não entendi. O que quer mudar?\n\n_"mensagem para X", "data para DD/MM HH:MM"_`;
    }

    if (valor) {
      limparEditarLembretePendente(usuarioId);
      return aplicarEdicaoLembrete(usuarioId, l, campo, valor);
    }
    salvarEditarLembretePendente(usuarioId, { fase: 'aguardando_valor', lembrete: l, campo });
    const labels = { mensagem: 'nova mensagem', horario: 'novo horário (ex: 08:00)', frequencia: 'nova frequência (diário, semanal ou mensal)', dispara_em: 'nova data e hora (ex: 25/03 14:00)' };
    return `Qual o ${labels[campo] || campo}?`;
  }

  if (pendente.fase === 'aguardando_valor') {
    const l = pendente.lembrete;
    limparEditarLembretePendente(usuarioId);
    return aplicarEdicaoLembrete(usuarioId, l, pendente.campo, msg.trim());
  }

  limparEditarLembretePendente(usuarioId);
  return null;
}

async function aplicarEdicaoLembrete(usuarioId, l, campo, novoValorStr) {
  if (l._tipo === 'recorrente') {
    let valorFinal = novoValorStr;
    let campoDb = campo;

    if (campo === 'horario') {
      const match = novoValorStr.match(/(\d{1,2})[:\s](\d{2})/);
      if (!match) return `❌ Horário inválido. Use o formato HH:MM (ex: 08:00).`;
      valorFinal = `${match[1].padStart(2, '0')}:${match[2]}`;
    } else if (campo === 'frequencia') {
      const freqMap = { diario: 'diario', diária: 'diario', diaria: 'diario', semanal: 'semanal', mensal: 'mensal' };
      valorFinal = freqMap[novoValorStr.toLowerCase()] || null;
      if (!valorFinal) return `❌ Frequência inválida. Use: _diário_, _semanal_ ou _mensal_.`;
    } else if (campo === 'mensagem') {
      valorFinal = novoValorStr.trim();
      if (!valorFinal) return `❌ Mensagem inválida.`;
    }

    const atualizado = await db.atualizarLembreteRecorrente(usuarioId, l.id, campoDb, valorFinal);
    if (!atualizado) return `❌ Não consegui atualizar o lembrete.`;

    const labelAntes = { mensagem: l.mensagem, horario: l.horario, frequencia: l.frequencia };
    const labelDepois = { mensagem: atualizado.mensagem, horario: atualizado.horario, frequencia: atualizado.frequencia };
    return `✅ Lembrete recorrente atualizado!\n\n${labelAntes[campoDb]} → *${labelDepois[campoDb]}*`;
  }

  // Lembrete geral
  let valorFinal = novoValorStr;
  let campoDb = campo;

  if (campo === 'mensagem') {
    valorFinal = novoValorStr.trim();
    if (!valorFinal) return `❌ Mensagem inválida.`;
  } else if (campo === 'dispara_em') {
    // Tenta parsear data no formato DD/MM HH:MM ou DD/MM/YYYY HH:MM
    const match = novoValorStr.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2})[:\s](\d{2})/);
    if (!match) return `❌ Data inválida. Use o formato DD/MM HH:MM (ex: 25/03 14:00).`;
    const dia = parseInt(match[1]);
    const mes = parseInt(match[2]) - 1;
    const ano = match[3] ? (match[3].length === 2 ? 2000 + parseInt(match[3]) : parseInt(match[3])) : new Date().getFullYear();
    const hora = parseInt(match[4]);
    const min = parseInt(match[5]);
    const data = new Date(ano, mes, dia, hora, min);
    if (isNaN(data.getTime())) return `❌ Data inválida.`;
    // Converter para timestamp com timezone de São Paulo
    valorFinal = data.toISOString();
  }

  const atualizado = await db.atualizarLembreteGeral(usuarioId, l.id, campoDb, valorFinal);
  if (!atualizado) return `❌ Não consegui atualizar o lembrete.`;

  if (campoDb === 'mensagem') {
    return `✅ Lembrete atualizado!\n\n${l.mensagem} → *${atualizado.mensagem}*`;
  }
  return `✅ Lembrete atualizado!\n\n*${atualizado.mensagem}* — reagendado para ${atualizado.horario}`;
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

async function gerarOrcamentoProporcional(estado, categoriasPrincipais) {
  const totalReceitas = (estado.receitasFixas || []).reduce((s, r) => s + r.valor, 0);
  const totalFixas = (estado.despesasFixas || []).reduce((s, d) => s + d.valor, 0);
  const cats = categoriasPrincipais || db.CATEGORIAS_PRINCIPAIS_PADRAO;
  const orcamentos = cats.map(c => ({
    descricao: c.nome,
    valor: Math.round(totalReceitas * (c.percentual / 100)),
    categoria: c.nome,
  }));
  const catFixas = cats.find(c => c.nome === 'Despesas Fixas');
  const limiteFixas = catFixas ? Math.round(totalReceitas * (catFixas.percentual / 100)) : Math.round(totalReceitas * 0.50);
  const alertaFixas = totalFixas > limiteFixas;
  return { totalReceitas, totalFixas, limiteFixas, alertaFixas, orcamentos };
}

async function iniciarPontoZero(usuarioId) {
  salvarPontoZero(usuarioId, {
    etapa: 'saldo',
    saldoInicial: 0,
    receitasFixas: [],
    despesasFixas: [],
    investimentos: [],
    cartoes: [],
    orcamentos: [],
  });

  return { msg: (
    `Vamos colocar tudo em dia então!\n\n` +
    `Primeiro: *quanto você tem disponível hoje na conta ou carteira?*\n\n` +
    `> ⚠️ Se tiver em mais de um lugar é só dizer o total, ele será seu ponta pé inicial.\n` +
    `> 💰 Caso tenha investimentos, caixinhas ou poupança deixe esses pra registrar depois\n\n` +
    `_*Diga* Ex: "1250" ou "tenho uns 2 mil"_`
  ), semCitacao: true };
}

function coletarItens(item, lista, etapa) {
  // Múltiplos itens
  if (item.tipo === 'itens' && item.itens && item.itens.length > 0) {
    let msg = '';
    const incompletos = [];
    for (const it of item.itens) {
      const campo = proximoCampoFaltante(it, etapa);
      if (campo) {
        incompletos.push({ descricao: it.descricao, valor: it.valor || null, dia: it.dia || null, categoria: it.categoria || null, esperandoCampo: campo });
      } else {
        lista.push({ valor: it.valor, descricao: it.descricao, dia: it.dia, categoria: it.categoria });
        msg += `✅ *${it.descricao}* - ${fmt.formatarMoeda(it.valor)}${it.dia ? ` (dia ${it.dia})` : ''}\n`;
      }
    }
    return { ok: true, msg, quantidade: item.itens.length - incompletos.length, incompletos };
  }

  // Item único — verifica completude antes de adicionar
  if (item.tipo === 'item' && (item.valor || item.descricao)) {
    const campoPendente = proximoCampoFaltante({ descricao: item.descricao, valor: item.valor, dia: item.dia }, etapa);
    if (campoPendente) {
      return {
        ok: true, msg: '', quantidade: 0,
        incompletos: [{ descricao: item.descricao, valor: item.valor || null, dia: item.dia || null, categoria: item.categoria || null, esperandoCampo: campoPendente }],
      };
    }
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
  // "para 7", "pra 10" — número após preposição
  const matchPara = t.match(/\b(?:para|pra)\s+(\d{1,2})\b/);
  if (matchPara) {
    const d = parseInt(matchPara[1]);
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
    case 'dia':       return `Em que dia do mês entra o ${nome}? 📅\n> Ex: "dia 5" ou só "5"`;
    default:          return null;
  }
}

// Coleta o campo faltante de um item parcial salvo no estado
async function handleItemParcialPontoZero(usuarioId, texto, estado) {
  const ip = estado.itemParcial;
  const campo = ip.esperandoCampo;
  const lower = texto.toLowerCase().trim();

  // Detectar intenção de editar o PRÓPRIO item parcial em andamento
  if (/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?)\b/.test(lower)) {
    // Verificar se quer editar um campo do item parcial atual (valor, nome, dia)
    const querEditarValor = /\b(valor|preco|preço|quanto|custo)\b/.test(lower);
    const querEditarNome = /\b(nome|descri[çc][aã]o|chamar?)\b/.test(lower);
    const querEditarDia = /\b(dia|data|vencimento)\b/.test(lower);

    const nomeItemLower = normalizarTextoBusca(ip.descricao || '');
    const textoRefereItemAtual = nomeItemLower && lower.includes(nomeItemLower);

    // Se não menciona campo específico nem item específico, assume edição do campo principal do item atual
    // "alterar para 1500" → edita valor do item atual
    const nenhumCampoEspecifico = !querEditarValor && !querEditarNome && !querEditarDia;
    const temValorNoTexto = /\d/.test(texto);
    const assumirValorAtual = nenhumCampoEspecifico && temValorNoTexto;

    if ((querEditarValor || textoRefereItemAtual || assumirValorAtual) && !querEditarNome && !querEditarDia) {
      // Editar valor do item parcial
      const valor = await extrairValorRobusto(texto);
      if (valor && valor > 0) {
        ip.valor = valor;
        salvarPontoZero(usuarioId, estado);
        const proximoCampo = proximoCampoFaltante(ip, estado.etapa);
        if (proximoCampo) {
          ip.esperandoCampo = proximoCampo;
          salvarPontoZero(usuarioId, estado);
          return `✅ Valor de *${ip.descricao}* atualizado para *${fmt.formatarMoeda(valor)}*!\n\n${perguntarCampoFaltante(proximoCampo, ip.descricao)}`;
        }
        // Item completo — não deveria acontecer aqui, mas por segurança
        return `✅ Valor de *${ip.descricao}* atualizado para *${fmt.formatarMoeda(valor)}*!`;
      }
      return `Qual o novo valor para *${ip.descricao}*?\n_Ex: "R$ 1.500" ou "1500"_`;
    }

    if (querEditarNome) {
      const matchPara = texto.match(/\b(?:para|pra)\s+(.+)$/i);
      if (matchPara) {
        const novoNome = matchPara[1].trim().replace(/[.,!?]+$/, '');
        if (novoNome.length >= 2) {
          ip.descricao = novoNome;
          salvarPontoZero(usuarioId, estado);
          return `✅ Renomeado para *${novoNome}*!\n\n${perguntarCampoFaltante(campo, ip.descricao)}`;
        }
      }
      return `Qual o novo nome?\n_Ex: "alterar nome para Financiamento"_`;
    }

    if (querEditarDia) {
      const dia = extrairDiaDoTexto(texto);
      if (dia) {
        ip.dia = dia;
        salvarPontoZero(usuarioId, estado);
        const proximoCampo = proximoCampoFaltante(ip, estado.etapa);
        if (proximoCampo && proximoCampo !== campo) {
          ip.esperandoCampo = proximoCampo;
          salvarPontoZero(usuarioId, estado);
          return `✅ Dia de *${ip.descricao}* atualizado para dia *${dia}*!\n\n${perguntarCampoFaltante(proximoCampo, ip.descricao)}`;
        }
        return `✅ Dia de *${ip.descricao}* atualizado para dia *${dia}*!\n\n${perguntarCampoFaltante(campo, ip.descricao)}`;
      }
      return `Qual o novo dia?\n_Ex: "dia 10" ou "10"_`;
    }

    // Se não é edição do item atual, tenta editar itens já adicionados
    const resp = await editarItemFluxo(usuarioId, texto, estado);
    if (!resp.includes('Não encontrei')) {
      return resp + `\n\n_Continuando..._\n${perguntarCampoFaltante(campo, ip.descricao)}`;
    }
    // Fallback: não encontrou nada, tratar como resposta normal
  }

  // Detectar intenção de remover itens já adicionados
  const matchRemoverSub = lower.match(/^(remover?|excluir?|deletar?|tirar|apagar?)\s+(.+)$/);
  if (matchRemoverSub) {
    const campoFaltante = perguntarCampoFaltante(campo, ip.descricao);
    return removerItemFluxo(usuarioId, estado, matchRemoverSub[2].trim()) + `\n\n_Continuando..._\n${campoFaltante}`;
  }

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
    estado.etapa === 'receitas_fixas' ? estado.receitasFixas : estado.despesasFixas;
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

  const nomeEtapa = estado.etapa === 'receitas_fixas' ? 'receita fixa' : 'despesa';
  return `${confirmacao}\n\nTem mais alguma ${nomeEtapa} ou pode passar pra frente?`;
}

function resumoCartaoEmCadastro(cc) {
  const linhas = [];
  if (cc.limiteTotal != null) linhas.push(`  Limite total: ${fmt.formatarMoeda(cc.limiteTotal)}`);
  if (cc.valorFatura != null) linhas.push(`  Fatura atual: ${fmt.formatarMoeda(cc.valorFatura)}`);
  if (cc.diaFechamento != null) linhas.push(`  Fecha: dia ${cc.diaFechamento}`);
  if (cc.diaVencimento != null) linhas.push(`  Vence: dia ${cc.diaVencimento}`);
  return linhas.length ? `_Cadastrado até agora para *${cc.nome}*:_\n${linhas.join('\n')}\n\n` : '';
}

async function handleCartaoCadastro(usuarioId, texto, estado) {
  const cc = estado.cartaoEmCadastro;
  const lower = normalizarTextoBusca(texto);

  // Cancelar o cartão em andamento sem cancelar o fluxo inteiro
  if (/^(pular|nao|nao tenho|não|n)$/.test(lower)) {
    delete estado.cartaoEmCadastro;
    salvarPontoZero(usuarioId, estado);
    return `Ok, pulei esse cartão.\n\nTem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
  }

  // Edição inline: detecta se quer ajustar um campo já respondido (ou antecipado)
  const editandoLimite  = /\b(limite|limite total|credito|cr[eé]dito)\b/.test(lower) && /\b(ajustar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|editar?)\b/.test(lower);
  const editandoFatura  = /\b(fatura|fatura atual|valor da fatura|valor em aberto)\b/.test(lower) && /\b(ajustar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|editar?)\b/.test(lower);
  const editandoFecha   = /\b(fechamento|fecha|dia de fechamento)\b/.test(lower) && /\b(ajustar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|editar?)\b/.test(lower);
  const editandoVence   = /\b(vencimento|vence|vence dia|pagamento)\b/.test(lower) && /\b(ajustar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|editar?)\b/.test(lower);

  if (editandoLimite) {
    const valor = await extrairValorRobusto(texto);
    if (valor && valor > 0) {
      cc.limiteTotal = valor;
      salvarPontoZero(usuarioId, estado);
      return `✅ Limite total atualizado para *${fmt.formatarMoeda(valor)}*!\n\n${resumoCartaoEmCadastro(cc)}${perguntaCartaoCampo(cc)}`;
    }
    return `Qual o novo limite total? _Ex: "R$ 8.000"_`;
  }

  if (editandoFatura) {
    const valor = await extrairValorRobusto(texto);
    if (valor != null && valor >= 0) {
      cc.valorFatura = valor;
      salvarPontoZero(usuarioId, estado);
      return `✅ Fatura atual atualizada para *${fmt.formatarMoeda(valor)}*!\n\n${resumoCartaoEmCadastro(cc)}${perguntaCartaoCampo(cc)}`;
    }
    return `Qual o valor da fatura atual? _Ex: "R$ 1.200" ou "0" se não tem_`;
  }

  if (editandoFecha) {
    const dia = extrairDiaDoTexto(texto);
    if (dia) {
      cc.diaFechamento = dia;
      salvarPontoZero(usuarioId, estado);
      return `✅ Dia de fechamento atualizado para dia *${dia}*!\n\n${resumoCartaoEmCadastro(cc)}${perguntaCartaoCampo(cc)}`;
    }
    return `Qual o dia de fechamento? _Ex: "dia 15"_`;
  }

  if (editandoVence) {
    const dia = extrairDiaDoTexto(texto);
    if (dia) {
      cc.diaVencimento = dia;
      salvarPontoZero(usuarioId, estado);
      return `✅ Dia de vencimento atualizado para dia *${dia}*!\n\n${resumoCartaoEmCadastro(cc)}${perguntaCartaoCampo(cc)}`;
    }
    return `Qual o dia de vencimento? _Ex: "dia 22"_`;
  }

  // Detectar intenção de editar/remover itens já adicionados (caixinhas, receitas, outros cartões)
  const matchRemoverSub = lower.match(/^(remover?|excluir?|deletar?|tirar|apagar?)\s+(.+)$/);
  if (matchRemoverSub && !/\b(limite|fatura|fechamento|vencimento)\b/.test(lower)) {
    return removerItemFluxo(usuarioId, estado, matchRemoverSub[2].trim()) + `\n\n_Continuando o cadastro do cartão *${cc.nome}*..._\n${perguntaCartaoCampo(cc)}`;
  }
  if (/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|renomear?)\b/.test(lower)
      && !editandoLimite && !editandoFatura && !editandoFecha && !editandoVence) {
    // Detectar edição do NOME do cartão em cadastro
    const querEditarNome = /\b(nome|renomear?|chamar?)\b/.test(lower) || /\b(cartao|cartão)\b/.test(lower);
    if (querEditarNome) {
      const matchPara = texto.match(/\b(?:para|pra)\s+(.+)$/i);
      if (matchPara) {
        const novoNome = matchPara[1].trim().replace(/[.,!?]+$/, '');
        if (novoNome.length >= 2) {
          cc.nome = novoNome;
          salvarPontoZero(usuarioId, estado);
          return `✅ Cartão renomeado para *${novoNome}*!\n\n${resumoCartaoEmCadastro(cc)}${perguntaCartaoCampo(cc)}`;
        }
      }
      return `Qual o novo nome do cartão?\n_Ex: "alterar nome para Itaú"_`;
    }
    // Está querendo editar algo que não é campo do cartão atual
    const resp = await editarItemFluxo(usuarioId, texto, estado);
    if (!resp.includes('Não encontrei')) {
      return resp + `\n\n_Continuando o cadastro do cartão *${cc.nome}*..._\n${perguntaCartaoCampo(cc)}`;
    }
    // Fallback: não encontrou, trata como resposta normal do fluxo
  }

  // Fluxo normal — cada campo em sequência
  switch (cc.campo) {

    case 'limiteTotal': {
      const valor = await extrairValorRobusto(texto);
      if (!valor || valor <= 0) {
        return `Não entendi o valor 😅 Qual o *limite total* do *${cc.nome}*?\n_Ex: "R$ 5.000" ou "5000"_`;
      }
      cc.limiteTotal = valor;
      cc.campo = 'valorFatura';
      salvarPontoZero(usuarioId, estado);
      return `Qual o *valor da fatura em aberto* até hoje no *${cc.nome}*? 💰\n_Ex: "R$ 1.200" — ou "0" se não tem nada lançado._`;
    }

    case 'valorFatura': {
      let valorFatura = 0;
      if (!/^(0|zero|nao sei|não sei|nada|nenhum)$/.test(lower)) {
        const valor = await extrairValorRobusto(texto);
        if (valor === null) {
          return `Não entendi o valor 😅 Qual o valor da fatura atual do *${cc.nome}*?\n_Ex: "R$ 1.200" — ou "0" se não tem._`;
        }
        valorFatura = valor;
      }
      cc.valorFatura = valorFatura;
      cc.campo = 'diaFechamento';
      salvarPontoZero(usuarioId, estado);
      return `Qual o *dia de fechamento* da fatura do *${cc.nome}*? 📅\n_Ex: "dia 15" ou só "15"_`;
    }

    case 'diaFechamento': {
      const dia = extrairDiaDoTexto(texto);
      if (!dia) {
        return `Não entendi 😅 Em que dia fecha a fatura do *${cc.nome}*? (1 a 31)\n_Ex: "dia 15" ou só "15"_`;
      }
      cc.diaFechamento = dia;
      cc.campo = 'diaVencimento';
      salvarPontoZero(usuarioId, estado);
      return `E o *dia de vencimento* (pagamento) da fatura? 📅\n_Ex: "dia 22" ou só "22"_`;
    }

    case 'diaVencimento': {
      const dia = extrairDiaDoTexto(texto);
      if (!dia) {
        return `Não entendi 😅 Em que dia vence a fatura do *${cc.nome}*? (1 a 31)\n_Ex: "dia 22" ou só "22"_`;
      }
      cc.diaVencimento = dia;
      // Finaliza direto com método simples (método completo desativado)
      return finalizarCadastroCartao(estado, cc, usuarioId);
    }

    // ── Método completo desativado — mantendo apenas cadastro simples ──────
    // case 'escolhaMetodo': {
    //   const ehCompleto = /^(1|completo|detalhar|detalhado|sim)$/.test(lower);
    //   const ehSimples = /^(2|simples|so o total|só o total|total|nao|não|rapido|rápido)$/.test(lower);
    //   if (!ehCompleto && !ehSimples) {
    //     return `Manda *1* pra detalhar os gastos ou *2* pra manter só o total da fatura.`;
    //   }
    //   if (ehSimples) {
    //     return finalizarCadastroCartao(estado, cc, usuarioId);
    //   }
    //   cc.metodoCompleto = true;
    //   cc.campo = 'gastosAssinaturas';
    //   salvarPontoZero(usuarioId, estado);
    //   return `Quais *assinaturas mensais* estão nesse cartão? 🔄\n\n` +
    //     `_Manda uma por vez ou várias separadas por vírgula:_\n` +
    //     `Ex: "Netflix 45,90" ou "Netflix 45,90, Spotify 21,90, iCloud 3,50"\n\n` +
    //     `_Manda "pular" se não tem assinatura nesse cartão._`;
    // }

    // case 'gastosAssinaturas': {
    //   if (/^(pular|pronto|proximo|próximo|nao|não|n|0|nenhum|nenhuma)$/.test(lower)) {
    //     cc.campo = 'gastosParcelados';
    //     salvarPontoZero(usuarioId, estado);
    //     return montarPerguntaParcelas(cc);
    //   }
    //   const itens = texto.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    //   let adicionadas = 0;
    //   for (const item of itens) {
    //     const parsed = parsearGastoSimples(item);
    //     if (parsed) {
    //       cc.assinaturas.push({ descricao: parsed.descricao, valor: parsed.valor });
    //       adicionadas++;
    //     }
    //   }
    //   if (adicionadas === 0) {
    //     return `Não entendi 😅 Manda no formato: *nome valor*\n_Ex: "Netflix 45,90"_\n\n_Ou "pular" se não tem._`;
    //   }
    //   salvarPontoZero(usuarioId, estado);
    //   const totalAss = cc.assinaturas.reduce((s, a) => s + a.valor, 0);
    //   const listaAss = cc.assinaturas.map(a => `  • ${a.descricao}: ${fmt.formatarMoeda(a.valor)}`).join('\n');
    //   return `✅ ${adicionadas > 1 ? `${adicionadas} assinaturas adicionadas` : 'Assinatura adicionada'}!\n\n` +
    //     `📋 *Assinaturas do ${cc.nome}:*\n${listaAss}\n` +
    //     `💰 Total mensal: ${fmt.formatarMoeda(totalAss)}\n\n` +
    //     `Tem mais alguma assinatura?\n_Manda mais ou "pronto" pra continuar._`;
    // }

    // case 'gastosParcelados': {
    //   if (/^(pular|pronto|proximo|próximo|nao|não|n|0|nenhum|nenhuma)$/.test(lower)) {
    //     cc.campo = 'gastosAvulsos';
    //     salvarPontoZero(usuarioId, estado);
    //     return montarPerguntaAvulsos(cc);
    //   }
    //   const parsed = parsearParcelaEmAndamento(texto);
    //   if (!parsed) {
    //     return `Não entendi 😅 Manda no formato:\n` +
    //       `*nome (valor da parcela) faltam (X parcelas)*\n` +
    //       `_Ex: "Notebook 500 faltam 4" ou "TV 300 restam 3"_\n\n` +
    //       `_Ou "pular" se não tem parcela._`;
    //   }
    //   cc.parcelas.push(parsed);
    //   salvarPontoZero(usuarioId, estado);
    //   const listaPar = cc.parcelas.map(p => `  • ${p.descricao}: ${fmt.formatarMoeda(p.valorParcela)}/mês (${p.restantes}x restantes)`).join('\n');
    //   return `✅ Parcela adicionada!\n\n` +
    //     `📋 *Parcelas em andamento no ${cc.nome}:*\n${listaPar}\n\n` +
    //     `Tem mais alguma parcela?\n_Manda mais ou "pronto" pra continuar._`;
    // }

    // case 'gastosAvulsos': {
    //   if (/^(pular|pronto|proximo|próximo|nao|não|n|0|nenhum|nenhuma)$/.test(lower)) {
    //     return finalizarCadastroCartaoCompleto(estado, cc, usuarioId);
    //   }
    //   const itens = texto.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
    //   let adicionados = 0;
    //   if (!cc.avulsos) cc.avulsos = [];
    //   for (const item of itens) {
    //     const parsed = parsearGastoSimples(item);
    //     if (parsed) {
    //       cc.avulsos.push({ descricao: parsed.descricao, valor: parsed.valor });
    //       adicionados++;
    //     }
    //   }
    //   if (adicionados === 0) {
    //     return `Não entendi 😅 Manda no formato: *nome valor*\n_Ex: "Mercado 350"_\n\n_Ou "pronto" pra finalizar._`;
    //   }
    //   salvarPontoZero(usuarioId, estado);
    //   const totalAv = cc.avulsos.reduce((s, a) => s + a.valor, 0);
    //   return `✅ ${adicionados > 1 ? `${adicionados} gastos adicionados` : 'Gasto adicionado'}! (total avulsos: ${fmt.formatarMoeda(totalAv)})\n\n` +
    //     `Tem mais algum gasto dessa fatura?\n_Manda mais ou "pronto" pra finalizar o ${cc.nome}._`;
    // }
    // ── Fim do método completo desativado ────────────────────────────────────

    default:
      delete estado.cartaoEmCadastro;
      salvarPontoZero(usuarioId, estado);
      return `Algo deu errado no cadastro do cartão 😅 Tente novamente.`;
  }
}

// Retorna a próxima pergunta pendente para o cartão em cadastro
function perguntaCartaoCampo(cc) {
  switch (cc.campo) {
    case 'limiteTotal':  return `Qual o *limite total* do *${cc.nome}*?\n_Ex: "R$ 5.000"_`;
    case 'valorFatura':  return `Qual o *valor da fatura em aberto* até hoje?\n_Ex: "R$ 1.200" ou "0"_`;
    case 'diaFechamento': return `Qual o *dia de fechamento* da fatura?\n_Ex: "dia 15"_`;
    case 'diaVencimento': return `Qual o *dia de vencimento* da fatura?\n_Ex: "dia 22"_`;
    // Método completo desativado:
    // case 'escolhaMetodo': return `Manda *1* pra detalhar os gastos ou *2* pra manter só o total.`;
    // case 'gastosAssinaturas': return `Manda as assinaturas no formato: *nome valor*\n_Ex: "Netflix 45,90"_ ou "pular"`;
    // case 'gastosParcelados': return `Manda as parcelas: *nome valor faltam X*\n_Ex: "Notebook 500 faltam 4"_ ou "pular"`;
    // case 'gastosAvulsos': return `Manda os gastos avulsos: *nome valor*\n_Ex: "Mercado 350"_ ou "pronto"`;
    default: return '';
  }
}

// ─── Helpers para cadastro completo de cartão (DESATIVADO) ────────────────────
// Método completo comentado — mantendo apenas cadastro simples de cartão.
//
// function parsearGastoSimples(texto) {
//   const t = texto.trim();
//   if (!t) return null;
//   const match = t.match(/^(.+?)\s+(?:R\$\s*)?(\d[\d.,]*\d|\d)$/i);
//   if (match) {
//     const descricao = match[1].trim();
//     const valorStr = match[2].replace(/\./g, '').replace(',', '.');
//     const valor = parseFloat(valorStr);
//     if (descricao && valor > 0) return { descricao, valor };
//   }
//   const match2 = t.match(/^(?:R\$\s*)?(\d[\d.,]*\d|\d)\s+(.+)$/i);
//   if (match2) {
//     const valorStr = match2[1].replace(/\./g, '').replace(',', '.');
//     const valor = parseFloat(valorStr);
//     const descricao = match2[2].trim();
//     if (descricao && valor > 0) return { descricao, valor };
//   }
//   return null;
// }
//
// function parsearParcelaEmAndamento(texto) {
//   const t = texto.trim();
//   if (!t) return null;
//   const match = t.match(/^(.+?)\s+(?:R\$\s*)?(\d[\d.,]*\d|\d)\s+(?:faltam?|restam?|restantes?)\s*(\d+)/i);
//   if (match) {
//     const descricao = match[1].trim();
//     const valorStr = match[2].replace(/\./g, '').replace(',', '.');
//     const valorParcela = parseFloat(valorStr);
//     const restantes = parseInt(match[3]);
//     if (descricao && valorParcela > 0 && restantes > 0) return { descricao, valorParcela, restantes };
//   }
//   const match2 = t.match(/^(.+?)\s+(?:faltam?|restam?)\s*(\d+)\s*(?:parcelas?|x|vezes?)?\s*(?:de\s+)?(?:R\$\s*)?(\d[\d.,]*\d|\d)/i);
//   if (match2) {
//     const descricao = match2[1].trim();
//     const restantes = parseInt(match2[2]);
//     const valorStr = match2[3].replace(/\./g, '').replace(',', '.');
//     const valorParcela = parseFloat(valorStr);
//     if (descricao && valorParcela > 0 && restantes > 0) return { descricao, valorParcela, restantes };
//   }
//   const match3 = t.match(/^(.+?)\s+(\d+)\s*[xX]\s*(?:de\s+)?(?:R\$\s*)?(\d[\d.,]*\d|\d)/i);
//   if (match3) {
//     const descricao = match3[1].trim();
//     const restantes = parseInt(match3[2]);
//     const valorStr = match3[3].replace(/\./g, '').replace(',', '.');
//     const valorParcela = parseFloat(valorStr);
//     if (descricao && valorParcela > 0 && restantes > 0) return { descricao, valorParcela, restantes };
//   }
//   return null;
// }
//
// function montarPerguntaParcelas(cc) {
//   return `Tem alguma *compra parcelada* em andamento nesse cartão? 🔢\n\n` +
//     `_Manda no formato: nome (valor da parcela) faltam (quantas):_\n` +
//     `Ex: "Notebook 500 faltam 4" ou "TV 300 restam 3"\n\n` +
//     `_Manda "pular" se não tem parcela._`;
// }
//
// function montarPerguntaAvulsos(cc) {
//   const totalAss = (cc.assinaturas || []).reduce((s, a) => s + a.valor, 0);
//   const totalPar = (cc.parcelas || []).reduce((s, p) => s + p.valorParcela, 0);
//   const totalDetalhado = totalAss + totalPar;
//   const diferenca = cc.valorFatura > 0 ? cc.valorFatura - totalDetalhado : 0;
//   let msg = `Agora, tem algum *gasto avulso* dessa fatura? (mercado, restaurante, etc.) 🛒\n\n`;
//   if (diferenca > 0) {
//     msg += `📊 Até agora você detalhou ${fmt.formatarMoeda(totalDetalhado)} de ${fmt.formatarMoeda(cc.valorFatura)}\n`;
//     msg += `   Faltam ${fmt.formatarMoeda(diferenca)} pra bater com a fatura.\n\n`;
//   }
//   msg += `_Manda: "Mercado 350" ou "Restaurante 120, Uber 45"_\n`;
//   msg += `_Ou "pronto" pra finalizar o ${cc.nome}._`;
//   return msg;
// }

function finalizarCadastroCartao(estado, cc, usuarioId) {
  estado.cartoes.push({
    nome: cc.nome,
    limiteTotal: cc.limiteTotal,
    diaFechamento: cc.diaFechamento,
    diaVencimento: cc.diaVencimento,
    valorFatura: cc.valorFatura,
  });
  delete estado.cartaoEmCadastro;
  salvarPontoZero(usuarioId, estado);

  const faturaStr = cc.valorFatura > 0 ? fmt.formatarMoeda(cc.valorFatura) : 'R$ 0';
  const listaAtual = estado.cartoes.length > 1
    ? `\n\n*Cartões adicionados:*\n${estado.cartoes.map(c => `  💳 ${c.nome}`).join('\n')}\n_Para remover um, manda "remover [nome]"._`
    : '';
  return `✅ *${cc.nome}* cadastrado!\n` +
    `  Limite: ${fmt.formatarMoeda(cc.limiteTotal)}\n` +
    `  Fatura atual: ${faturaStr}\n` +
    `  Fecha dia ${cc.diaFechamento} · Vence dia ${cc.diaVencimento}${listaAtual}\n\n` +
    `Tem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
}

// function finalizarCadastroCartaoCompleto(estado, cc, usuarioId) {
//   const totalAss = (cc.assinaturas || []).reduce((s, a) => s + a.valor, 0);
//   const totalPar = (cc.parcelas || []).reduce((s, p) => s + p.valorParcela, 0);
//   const totalAv  = (cc.avulsos || []).reduce((s, a) => s + a.valor, 0);
//   const totalDetalhado = totalAss + totalPar + totalAv;
//   estado.cartoes.push({
//     nome: cc.nome,
//     limiteTotal: cc.limiteTotal,
//     diaFechamento: cc.diaFechamento,
//     diaVencimento: cc.diaVencimento,
//     valorFatura: cc.valorFatura,
//     metodoCompleto: true,
//     assinaturas: cc.assinaturas || [],
//     parcelas: cc.parcelas || [],
//     avulsos: cc.avulsos || [],
//   });
//   delete estado.cartaoEmCadastro;
//   salvarPontoZero(usuarioId, estado);
//   let resumo = `✅ *${cc.nome}* cadastrado com detalhamento completo!\n\n`;
//   if (cc.assinaturas.length > 0) {
//     resumo += `🔄 *Assinaturas:* ${fmt.formatarMoeda(totalAss)}/mês\n`;
//     resumo += cc.assinaturas.map(a => `  • ${a.descricao}: ${fmt.formatarMoeda(a.valor)}`).join('\n') + '\n';
//   }
//   if (cc.parcelas.length > 0) {
//     resumo += `🔢 *Parcelas:* ${fmt.formatarMoeda(totalPar)}/mês\n`;
//     resumo += cc.parcelas.map(p => `  • ${p.descricao}: ${fmt.formatarMoeda(p.valorParcela)} (${p.restantes}x restantes)`).join('\n') + '\n';
//   }
//   if ((cc.avulsos || []).length > 0) {
//     resumo += `🛒 *Avulsos:* ${fmt.formatarMoeda(totalAv)}\n`;
//   }
//   resumo += `\n📊 Total detalhado: ${fmt.formatarMoeda(totalDetalhado)}`;
//   if (cc.valorFatura > 0) {
//     const diff = cc.valorFatura - totalDetalhado;
//     if (Math.abs(diff) > 1) {
//       resumo += ` | Fatura informada: ${fmt.formatarMoeda(cc.valorFatura)}`;
//       if (diff > 0) resumo += `\n_Diferença de ${fmt.formatarMoeda(diff)} será registrada como gasto não detalhado._`;
//     }
//   }
//   resumo += `\n  Fecha dia ${cc.diaFechamento} · Vence dia ${cc.diaVencimento}`;
//   const listaAtual = estado.cartoes.length > 1
//     ? `\n\n*Cartões adicionados:*\n${estado.cartoes.map(c => `  💳 ${c.nome}`).join('\n')}\n_Para remover um, manda "remover [nome]"._`
//     : '';
//   resumo += `${listaAtual}\n\nTem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
//   return resumo;
// }

function perguntaCaixinhaCampo(inv) {
  switch (inv.campo) {
    case 'saldo': return `Quanto você tem guardado na *${inv.nome}*?\n_Ex: "R$ 5.000" ou "5000"_`;
    case 'meta': return `Qual a *meta* para *${inv.nome}*? 🎯\n_Ex: "R$ 20.000" — ou "pular"_`;
    case 'tipo': return `Que *tipo* de investimento é *${inv.nome}*?\n_Ex: "Renda fixa", "Ações"... ou "pular"_`;
    default: return '';
  }
}

async function handleInvestimentoCadastro(usuarioId, texto, estado) {
  const inv = estado.investimentoEmCadastro;
  const lower = texto.toLowerCase().trim();
  const isPular = lower === 'pular' || lower === 'nao' || lower === 'não' || lower === 'n' || lower === '-';

  // Detectar intenção de editar/remover itens já adicionados (sem sair do sub-fluxo)
  const matchRemoverSub = lower.match(/^(remover?|excluir?|deletar?|tirar|apagar?)\s+(.+)$/);
  if (matchRemoverSub) {
    return removerItemFluxo(usuarioId, estado, matchRemoverSub[2].trim()) + `\n\n_Continuando o cadastro da caixinha *${inv.nome}*..._\n${perguntaCaixinhaCampo(inv)}`;
  }
  if (/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|renomear?)\b/.test(lower)) {
    const querEditarNome = /\b(nome|renomear?|chamar?|caixinha)\b/.test(lower);
    const querEditarSaldo = /\b(saldo|valor|quanto)\b/.test(lower);
    const querEditarMeta = /\b(meta|objetivo)\b/.test(lower);
    const querEditarTipo = /\b(tipo|categoria)\b/.test(lower);

    // Editar nome da caixinha em cadastro
    if (querEditarNome) {
      const matchPara = texto.match(/\b(?:para|pra)\s+(.+)$/i);
      if (matchPara) {
        const novoNome = matchPara[1].trim().replace(/[.,!?]+$/, '');
        if (novoNome.length >= 2) {
          inv.nome = novoNome;
          salvarPontoZero(usuarioId, estado);
          return `✅ Caixinha renomeada para *${novoNome}*!\n\n${perguntaCaixinhaCampo(inv)}`;
        }
      }
      return `Qual o novo nome da caixinha?\n_Ex: "alterar nome para CDB Nubank"_`;
    }

    // Editar saldo da caixinha em cadastro
    if (querEditarSaldo && inv.saldo) {
      const valor = await extrairValorRobusto(texto);
      if (valor && valor > 0) {
        inv.saldo = valor;
        salvarPontoZero(usuarioId, estado);
        return `✅ Saldo de *${inv.nome}* atualizado para *${fmt.formatarMoeda(valor)}*!\n\n${perguntaCaixinhaCampo(inv)}`;
      }
      return `Qual o novo saldo de *${inv.nome}*?\n_Ex: "R$ 5.000"_`;
    }

    // Editar meta da caixinha em cadastro
    if (querEditarMeta && inv.meta !== undefined) {
      const valor = await extrairValorRobusto(texto);
      if (valor && valor > 0) {
        inv.meta = valor;
        salvarPontoZero(usuarioId, estado);
        return `✅ Meta de *${inv.nome}* atualizada para *${fmt.formatarMoeda(valor)}*!\n\n${perguntaCaixinhaCampo(inv)}`;
      }
      return `Qual a nova meta de *${inv.nome}*?\n_Ex: "R$ 20.000"_`;
    }

    // Editar tipo da caixinha em cadastro
    if (querEditarTipo && inv.tipo) {
      const matchPara2 = texto.match(/\b(?:para|pra)\s+(.+)$/i);
      if (matchPara2) {
        inv.tipo = matchPara2[1].trim().replace(/[.,!?]+$/, '');
        salvarPontoZero(usuarioId, estado);
        return `✅ Tipo de *${inv.nome}* atualizado para *${inv.tipo}*!\n\n${perguntaCaixinhaCampo(inv)}`;
      }
      return `Qual o novo tipo?\n_Ex: "alterar tipo para Renda fixa"_`;
    }

    // Se não é campo da caixinha atual, tenta editar itens já adicionados
    const resp = await editarItemFluxo(usuarioId, texto, estado);
    if (!resp.includes('Não encontrei')) {
      return resp + `\n\n_Continuando o cadastro da caixinha *${inv.nome}*..._\n${perguntaCaixinhaCampo(inv)}`;
    }
    // Fallback: não encontrou, trata como resposta normal do fluxo
  }

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
      estado.investimentos.push({
        nome: inv.nome,
        saldo: inv.saldo,
        meta: inv.meta,
        tipo: inv.tipo,
        rendimento: null,
      });
      delete estado.investimentoEmCadastro;
      salvarPontoZero(usuarioId, estado);

      let detalhes = `  Saldo: ${fmt.formatarMoeda(inv.saldo)}`;
      if (inv.meta) detalhes += ` | Meta: ${fmt.formatarMoeda(inv.meta)}`;
      if (inv.tipo) detalhes += `\n  Tipo: ${inv.tipo}`;

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
    despesas_fixas: 'Me diz suas despesas fixas (aluguel, internet, luz...).\n_Ex: "Aluguel dia 5 R$ 1.500"_\n_Ou manda "não"._',
    investimentos: 'Me diz o nome da sua primeira caixinha de investimento.\n_Ex: "Poupança", "CDB Nubank"_\n_Ou manda "não"._',
    cartoes: 'Tem cartão de crédito? Me diz o nome.\n_Ex: "Nubank", "Inter"_\n_Ou manda "não"._',
    despesas_dia_a_dia: 'Me diz os gastos do mês atual.\n_Ex: "mercado R$ 350, uber R$ 80"_\n_Ou manda "não"._',
  };
  return perguntas[etapa] || 'Me manda a informação que estou esperando 😊';
}

async function redireccionarPontoZero(usuarioId, texto, etapa) {
  const etapaLabel = {
    saldo: 'saldo atual', receitas_fixas: 'receitas fixas',
    despesas_fixas: 'despesas fixas', investimentos: 'investimentos/caixinhas',
    cartoes: 'cartões de crédito', despesas_dia_a_dia: 'gastos do mês',
  };
  const pergunta = perguntaAtualEtapa(etapa);
  return `Não entendi essa parte 😅 Vamos continuar!\n\n${pergunta}`;
}

function mostrarResumoFluxo(estado) {
  let msg = '📋 *O que você cadastrou até agora:*\n\n';
  msg += `💰 *Saldo:* ${fmt.formatarMoeda(estado.saldoInicial || 0)}\n`;

  if (estado.receitasFixas?.length) {
    msg += `\n📈 *Receitas fixas:*\n`;
    estado.receitasFixas.forEach((r, i) => {
      msg += `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)}${r.dia ? ` (dia ${r.dia})` : ''}\n`;
    });
  }
  if (estado.despesasFixas?.length) {
    msg += `\n📉 *Despesas fixas:*\n`;
    estado.despesasFixas.forEach((d, i) => {
      msg += `  ${i + 1}. *${d.descricao}* — ${fmt.formatarMoeda(d.valor)}${d.dia ? ` (dia ${d.dia})` : ''}\n`;
    });
  }
  if (estado.investimentos?.length) {
    msg += `\n🏦 *Investimentos/caixinhas:*\n`;
    estado.investimentos.forEach((inv, i) => {
      msg += `  ${i + 1}. *${inv.nome}* — ${fmt.formatarMoeda(inv.saldo)}\n`;
    });
  }
  if (estado.cartoes?.length) {
    msg += `\n💳 *Cartões:*\n`;
    estado.cartoes.forEach((c, i) => {
      msg += `  ${i + 1}. *${c.nome}* — vence dia ${c.diaVencimento}${c.valorFatura > 0 ? ` | ~${fmt.formatarMoeda(c.valorFatura)}/mês` : ''}\n`;
    });
  }
  return msg.trim();
}

function removerItemFluxo(usuarioId, estado, query) {
  // Normalizar: remover acentos e palavras-tipo como "despesa", "receita", "cartão" etc.
  const lq = normalizarTextoBusca(query)
    .replace(/\b(receita|despesa|investimento|cartao|caixinha|lancamento|fixo|fixa)\b/g, '')
    .replace(/\s+/g, ' ').trim();

  if (/saldo|conta/.test(lq)) {
    estado.saldoInicial = 0;
    salvarPontoZero(usuarioId, estado);
    return `✅ Saldo zerado. Qual o novo valor? 💰\n_Ex: "R$ 1.850"_`;
  }

  const listas = [
    { lista: estado.receitasFixas,  campo: 'descricao', label: 'receita' },
    { lista: estado.despesasFixas,  campo: 'descricao', label: 'despesa' },
    { lista: estado.investimentos,  campo: 'nome',      label: 'investimento' },
    { lista: estado.cartoes,        campo: 'nome',      label: 'cartão' },
  ];
  for (const { lista, campo } of listas) {
    if (!lista?.length) continue;
    const idx = lista.findIndex(i => normalizarTextoBusca(i[campo] || '').includes(lq));
    if (idx !== -1) {
      const nome = lista[idx][campo];
      lista.splice(idx, 1);
      salvarPontoZero(usuarioId, estado);
      return `🗑️ *${nome}* removido!\n\n${perguntaAtualEtapa(estado.etapa)}`;
    }
  }
  return `Não encontrei "${query}" para remover 😅\n\nManda *"listar"* para ver o que está cadastrado.`;
}

// Busca todos os itens cujo nome/descrição tem match com a query (sem acentos, case-insensitive)
function buscarItensPorNome(estado, queryNome) {
  const lq = normalizarTextoBusca(queryNome);
  const palavrasQuery = lq.split(/\s+/).filter(p => p.length > 2);
  if (!palavrasQuery.length) return [];

  const resultados = [];
  const pontuar = (nome) => {
    const n = normalizarTextoBusca(nome);
    // Conta quantas palavras da query estão no nome
    const matches = palavrasQuery.filter(p => n.includes(p)).length;
    return matches;
  };

  const todos = [
    ...(estado.receitasFixas || []).map(i => ({ item: i, tipo: 'receita', nome: i.descricao })),
    ...(estado.despesasFixas || []).map(i => ({ item: i, tipo: 'despesa', nome: i.descricao })),
    ...(estado.investimentos || []).map(i => ({ item: i, tipo: 'investimento', nome: i.nome })),
    ...(estado.cartoes || []).map(i => ({ item: i, tipo: 'cartão', nome: i.nome })),
  ];

  for (const candidato of todos) {
    const score = pontuar(candidato.nome);
    if (score > 0) resultados.push({ ...candidato, score });
  }

  if (resultados.length === 0) return [];

  // Priorizar match mais completo (mais palavras coincidindo)
  const maxScore = Math.max(...resultados.map(r => r.score));
  // Se algum item tem score maior, retorna apenas os melhores
  const melhores = resultados.filter(r => r.score === maxScore);
  return melhores.map(({ item, tipo }) => ({ item, tipo }));
}

async function aplicarEdicao(usuarioId, estado, candidato, campo, novoValor, textoOriginal) {
  const { item, tipo } = candidato;
  const nomeItem = item.descricao || item.nome;

  if (campo === 'nome') {
    if (!novoValor) {
      estado.edicaoPendente = { campo: 'nome', novoValor: null, candidatos: [candidato] };
      salvarPontoZero(usuarioId, estado);
      return `Qual o novo nome para *${nomeItem}*?\n_Ex: "Reserva de Emergência"_`;
    }
    if (tipo === 'investimento' || tipo === 'cartão') item.nome = novoValor;
    else item.descricao = novoValor;
    salvarPontoZero(usuarioId, estado);
    return `✅ *${nomeItem}* renomeado para *${novoValor}*!\n\n${perguntaAtualEtapa(estado.etapa)}`;
  }

  if (campo === 'dia') {
    const dia = novoValor || extrairDiaDoTexto(textoOriginal);
    if (!dia) {
      estado.edicaoPendente = { campo: 'dia', novoValor: null, candidatos: [candidato] };
      salvarPontoZero(usuarioId, estado);
      return `Qual o novo dia para *${nomeItem}*? _Ex: "dia 10" ou "7"_`;
    }
    if (tipo === 'cartão') item.diaVencimento = dia;
    else item.dia = dia;
    salvarPontoZero(usuarioId, estado);
    return `✅ Data de *${nomeItem}* atualizada para dia *${dia}*!\n\n${perguntaAtualEtapa(estado.etapa)}`;
  }

  // campo === 'valor'
  const valor = novoValor || await extrairValorRobusto(textoOriginal);
  if (!valor || valor <= 0) {
    estado.edicaoPendente = { campo: 'valor', novoValor: null, candidatos: [candidato] };
    salvarPontoZero(usuarioId, estado);
    return `Qual o novo valor para *${nomeItem}*? _Ex: "R$ 3.000"_`;
  }
  if (tipo === 'investimento') item.saldo = valor;
  else if (tipo === 'cartão') item.valorFatura = valor;
  else item.valor = valor;
  salvarPontoZero(usuarioId, estado);
  return `✅ Valor de *${nomeItem}* atualizado para *${fmt.formatarMoeda(valor)}*!\n\n${perguntaAtualEtapa(estado.etapa)}`;
}

async function handleEdicaoPendente(usuarioId, texto, estado) {
  const { campo, novoValor, candidatos } = estado.edicaoPendente;
  const lower = normalizarTextoBusca(texto);

  // Cancelar edição
  if (/^(cancelar?|sair|não|nao|deixa|esquece)$/i.test(texto.trim())) {
    delete estado.edicaoPendente;
    salvarPontoZero(usuarioId, estado);
    return `Ok, cancelei a edição.\n\n${perguntaAtualEtapa(estado.etapa)}`;
  }

  // Caso especial: 1 candidato e sem valor → estamos aguardando o valor/dia/nome
  if (candidatos.length === 1 && novoValor === null) {
    if (campo === 'dia') {
      const dia = extrairDiaDoTexto(texto);
      if (dia) {
        delete estado.edicaoPendente;
        return aplicarEdicao(usuarioId, estado, candidatos[0], campo, dia, texto);
      }
      return `Não entendi o dia 😅 Me diz um número de 1 a 31.\n_Ex: "dia 7" ou "7"_`;
    }
    if (campo === 'valor') {
      const valor = await extrairValorRobusto(texto);
      if (valor && valor > 0) {
        delete estado.edicaoPendente;
        return aplicarEdicao(usuarioId, estado, candidatos[0], campo, valor, texto);
      }
      return `Não entendi o valor 😅\n_Ex: "R$ 3.000" ou "3000"_`;
    }
    if (campo === 'nome') {
      const nome = texto.trim();
      if (nome.length >= 2) {
        delete estado.edicaoPendente;
        return aplicarEdicao(usuarioId, estado, candidatos[0], campo, nome, texto);
      }
      return `Me diz o novo nome.`;
    }
  }

  // Resolve por número (ex: "1", "o primeiro")
  const numMatch = lower.match(/\b([1-9])\b/);
  const num = numMatch ? parseInt(numMatch[1]) : NaN;
  if (!isNaN(num) && num >= 1 && num <= candidatos.length) {
    delete estado.edicaoPendente;
    return aplicarEdicao(usuarioId, estado, candidatos[num - 1], campo, novoValor, texto);
  }

  // Resolve por nome
  const palavras = lower.split(/\s+/).filter(p => p.length > 2);
  for (const c of candidatos) {
    const nNome = normalizarTextoBusca(c.item.descricao || c.item.nome);
    if (palavras.some(p => nNome.includes(p))) {
      delete estado.edicaoPendente;
      return aplicarEdicao(usuarioId, estado, c, campo, novoValor, texto);
    }
  }

  const lista = candidatos.map((c, i) => `${i + 1}. *${c.item.descricao || c.item.nome}* (${c.tipo})`).join('\n');
  return `Não entendi qual 😅 Responda com o número:\n${lista}`;
}

async function editarItemFluxo(usuarioId, texto, estado) {
  const lower = normalizarTextoBusca(texto);

  // Renomear item: "alterar nome [da] caixinha [X] para Y" ou "renomear X para Y"
  // Dispara se há "nome" na frase + verbo de edição, sem exigir artigo "da/do/de"
  if (/\b(trocar?|mudar?|alterar?|renomear?|corrigir?)\b.{0,12}\bnome\b/.test(lower)) {
    const matchPara = texto.match(/\b(?:para|pra)\s+(.+)$/i);
    const novoNome = matchPara ? matchPara[1].trim().replace(/[.,!?]+$/, '') : null;

    if (!novoNome) {
      return `Qual o novo nome?\n_Ex: "alterar nome da caixinha Nubank para Reserva de Emergência"_`;
    }

    // Extrai a query do nome atual: remove verbo, "nome", artigos, tipo e o novo nome
    const semSufixo = normalizarTextoBusca(texto.replace(/\b(?:para|pra)\s+.+$/i, '')).trim();
    let queryNome = semSufixo
      .replace(/\b(trocar?|mudar?|alterar?|renomear?|corrigir?)\b/g, '')
      .replace(/\bnome\s*d[aeo]?\b/g, '')
      .replace(/\bnome\b/g, '')
      .replace(/\b(caixinha|investimento|cartao|receita|despesa|conta)\b/g, '')
      .replace(/\b\d+\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const todosCandidatos = [
      ...(estado.investimentos  || []).map(i => ({ item: i, tipo: 'investimento' })),
      ...(estado.cartoes        || []).map(i => ({ item: i, tipo: 'cartão' })),
      ...(estado.receitasFixas  || []).map(i => ({ item: i, tipo: 'receita' })),
      ...(estado.despesasFixas  || []).map(i => ({ item: i, tipo: 'despesa' })),
    ];
    const candidatos = queryNome ? buscarItensPorNome(estado, queryNome) : todosCandidatos;

    if (candidatos.length === 0) {
      return `Não encontrei nenhum item${queryNome ? ` com o nome "${queryNome}"` : ''} para renomear 😅\n\nManda *"listar"* para ver o que está cadastrado.`;
    }
    if (candidatos.length === 1) {
      return aplicarEdicao(usuarioId, estado, candidatos[0], 'nome', novoNome, texto);
    }

    estado.edicaoPendente = { campo: 'nome', novoValor: novoNome, candidatos };
    salvarPontoZero(usuarioId, estado);
    const lista = candidatos.map((c, i) => `${i + 1}. *${c.item.descricao || c.item.nome}* (${c.tipo})`).join('\n');
    return `Qual deles quer renomear para *${novoNome}*?\n${lista}`;
  }

  // Editar saldo geral
  if (/saldo|valor da conta|conta corrente/.test(lower)) {
    const valor = await extrairValorRobusto(texto);
    if (valor && valor > 0) {
      estado.saldoInicial = valor;
      salvarPontoZero(usuarioId, estado);
      return `✅ Saldo atualizado para *${fmt.formatarMoeda(valor)}*!\n\n${perguntaAtualEtapa(estado.etapa)}`;
    }
    return `Qual o novo valor do saldo? 💰\n_Ex: "editar saldo para R$ 2.000"_`;
  }

  // Detectar campo que quer editar
  const querDia = /\b(dia|data|vencimento|entrada)\b/.test(lower);
  const campo = querDia ? 'dia' : 'valor';

  // Extrair nome do item: remover verbos de edição, palavras-chave de campo e valores numéricos
  let queryNome = lower
    .replace(/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?)\b/g, '')
    .replace(/\b(o|a|do|da|de|dos|das|para|pro|pra|ao)\b/g, ' ')
    .replace(/\b(dia|data|vencimento|entrada|valor|reais)\b/g, ' ')
    .replace(/r[$]?\s*[\d.,]+/gi, '')
    .replace(/\b[\d.,]+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!queryNome) {
    return `Qual item quer editar? Me diz o nome.\n_Ex: "alterar o salário para R$ 3.000"_\n_Ex: "editar dia do aluguel para 10"_`;
  }

  const candidatos = buscarItensPorNome(estado, queryNome);

  if (candidatos.length === 0) {
    return `Não encontrei nenhum item chamado "${queryNome}" 😅\n\nManda *"listar"* para ver o que está cadastrado.`;
  }

  // Extrair novo valor/dia do texto original
  let novoValor = null;
  if (campo === 'dia') {
    novoValor = extrairDiaDoTexto(texto);
  } else {
    novoValor = await extrairValorRobusto(texto);
  }

  if (candidatos.length === 1) {
    return aplicarEdicao(usuarioId, estado, candidatos[0], campo, novoValor, texto);
  }

  // Ambiguidade: perguntar qual
  estado.edicaoPendente = { campo, novoValor, candidatos };
  salvarPontoZero(usuarioId, estado);
  const lista = candidatos.map((c, i) => `${i + 1}. *${c.item.descricao || c.item.nome}* (${c.tipo})`).join('\n');
  return `Encontrei mais de um item com esse nome 😅\n\nQual deles quer editar?\n${lista}`;
}

async function handlePontoZero(usuarioId, texto, estado) {
  const lower = texto.toLowerCase().trim();
  const lowerNorm = normalizarTextoBusca(texto);

  // Começar do zero — reseta tudo mesmo dentro do fluxo
  if (lowerNorm === 'resetar' || lowerNorm.includes('comecar do zero') || lower === 'limpar tudo' || lower === 'zerar dados') {
    await db.limparDadosUsuario(usuarioId);
    limparPontoZero(usuarioId);
    setOnboardingState(usuarioId, 'aguardando_nome');
    return mensagemPerguntaNome();
  }

  if (lower === 'cancelar' || lower === 'sair' || lower === 'parar') {
    limparPontoZero(usuarioId);
    return '❌ Cancelado. Sem problemas! Quando quiser recomeçar é só me falar *"finanças em dia"*.';
  }

  // Se há uma edição aguardando desambiguação, resolve primeiro
  if (estado.edicaoPendente) {
    return await handleEdicaoPendente(usuarioId, texto, estado);
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

  // Listar o que foi cadastrado até agora
  if (/\b(listar?|o que|mostrar?|ver|resumo|cadastrei|coloquei|tenho at[eé])\b/.test(lower)) {
    return `${mostrarResumoFluxo(estado)}\n\n${perguntaAtualEtapa(estado.etapa)}`;
  }

  // Remover item
  const matchRemover = lower.match(/^(remover?|excluir?|deletar?|tirar|apagar?)\s+(.+)$/);
  if (matchRemover) {
    return removerItemFluxo(usuarioId, estado, matchRemover[2].trim());
  }

  // Editar/renomear item (não interceptar durante confirmação de saldo — o case 'saldo' trata isso)
  if (/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?|renomear?)\b/.test(lower) && !(estado.etapa === 'saldo' && estado.confirmandoSaldo)) {
    return await editarItemFluxo(usuarioId, texto, estado);
  }

  // Consultar saldo especificamente
  if (/\b(qual|quanto).*(saldo|conta|valor da conta)\b/.test(lower)) {
    return `💰 *Saldo cadastrado:* ${fmt.formatarMoeda(estado.saldoInicial || 0)}\n\nQuer alterar? _"editar saldo para R$ 2.000"_\n\n${perguntaAtualEtapa(estado.etapa)}`;
  }

  const item = await interpretarItemFinanceiro(texto, usuarioId);

  // Detecta qualquer variante de "quero avançar para o próximo passo"
  // Fast path: regex para palavras comuns (evita chamada IA desnecessária)
  const querAvancarRegex = /\b(n[aã]o( tem| tenho)?|nenhum[a]?|pra frente|pode passar|pode avan[çc]ar|pode pular|pode ir|pode continuar|pr[oó]xim[oa]|avan[çc]a(r)?|avan[çc]ar pra|pronto( isso)?|feito|mais nada|nada mais|s[oó] isso|s[oó] essa|pul[ao](r)?|skip|suficiente|chega( por)? (aí|ai)|seguir|continua(r)?|ok|okay|vai l[aá]|vai|bora|vamos|manda|segue|pode sim|pode|sim|beleza|blz|firmeza|fechou|combinado|partiu|simbora|vamo|bora l[aá])\b/.test(lower);
  // Combina regex + interpretação IA (tipo "sim" = confirmação positiva, tipo "nao" = encerramento)
  const querAvancar = querAvancarRegex || item.tipo === 'sim' || item.tipo === 'nao';

  switch (estado.etapa) {

    case 'saldo': {
      // Sub-estado: confirmando o valor do saldo
      if (estado.confirmandoSaldo) {
        // Confirma via regex (fast path) OU via IA (item.tipo === 'sim')
        if (querAvancar) {
          delete estado.confirmandoSaldo;
          estado.etapa = 'receitas_fixas';
          salvarPontoZero(usuarioId, estado);
          return { msg: `Perfeito, seu saldo inicial é de *${fmt.formatarMoeda(estado.saldoInicial)}*\n\n` +
            `📈 Agora me diz suas *receitas fixas* aquelas que você recebe todo mês no mesmo dia (salário, benefício, pensão, mesada...).\n\n` +
            `> Pode mandar tudo de uma vez e por áudio se quiser!🎤\n` +
            `> _Ex: "Salário dia 5 R$ 3.000 e benefício dia 10 R$ 800"_`, semCitacao: true };
        }
        // Tentou alterar o valor — primeiro tenta extração direta (mais rápido e confiável)
        const valorDireto = await extrairValorRobusto(texto);
        if (valorDireto && valorDireto > 0) {
          estado.saldoInicial = valorDireto;
          salvarPontoZero(usuarioId, estado);
          const usuario = await db.buscarUsuario(usuarioId);
          const nome = usuario?.nome || 'amigo(a)';
          return { msg: `Certo *${nome}*, alterei o saldo inicial para *${fmt.formatarMoeda(valorDireto)}*, podemos seguir assim ou deseja alterar novamente?`, semCitacao: true };
        }
        // Não entendeu — mas o valor JÁ está registrado, mostrar para o usuário
        const usuario = await db.buscarUsuario(usuarioId);
        const nome = usuario?.nome || 'amigo(a)';
        return { msg: `*${nome}*, registrei o valor de *${fmt.formatarMoeda(estado.saldoInicial)}*, você deseja continuar ou alterar o valor?`, semCitacao: true };
      }

      // Tenta pelo interpretador IA, senão fallback para extração direta
      let valorSaldo = (item.tipo === 'item' && item.valor) ? item.valor : null;
      if (!valorSaldo) {
        valorSaldo = await extrairValorRobusto(texto);
      }
      if (!valorSaldo || valorSaldo <= 0) {
        const usuario = await db.buscarUsuario(usuarioId);
        const nome = usuario?.nome || 'amigo(a)';
        return { msg: `Desculpa *${nome}* mas acho que não entendi o valor!😞\n\n*Diga* Ex: "1250" ou "tenho uns 2 mil"\n\n> Você pode me mandar por áudio, se quiser, também! 🎤`, semCitacao: true };
      }
      estado.saldoInicial = valorSaldo;
      estado.confirmandoSaldo = true;
      salvarPontoZero(usuarioId, estado);
      return { msg: `Maravilha, registrei *${fmt.formatarMoeda(valorSaldo)}*, posso seguir ou quer alterar o valor inicial?`, semCitacao: true };
    }

    case 'receitas_fixas': {
      // Sub-estado: confirmando as receitas listadas
      if (estado.confirmandoReceitas) {
        // Confirma via regex (fast path) OU via IA (item.tipo === 'sim' ou 'nao')
        if (querAvancar) {
          delete estado.confirmandoReceitas;
          estado.etapa = 'despesas_fixas';
          salvarPontoZero(usuarioId, estado);
          return `📉 Beleza! Agora as *despesas fixas* tudo que sai todo mês: aluguel, internet, luz, água, escola... *(caso alguma seja no cartão de crédito deixe para os próximos passos)*\n\n> Pode mandar várias de uma vez! Use um valor médio quando o valor varia, você poderá ajustar quando a conta chegar.\n> _Ex: "Aluguel dia 5 R$ 1.500, luz dia 10 R$ 150, internet dia 15 R$ 120"_`;
        }
        // Detectar edição: "alterar salário para 2000", "alterar dia do salário para 10"
        if (/\b(editar?|alterar?|mudar?|corrigir?|atualizar?|trocar?)\b/.test(lower)) {
          const resp = await editarItemFluxo(usuarioId, texto, estado);
          if (!resp.includes('Não encontrei')) {
            // Após edição, listar novamente e pedir confirmação
            const listaAtualizada = estado.receitasFixas.map((r, i) =>
              `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia})`
            ).join('\n');
            return { msg: `${resp}\n\n📋 Suas receitas fixas:\n${listaAtualizada}\n\nEstá tudo certo? Posso continuar?`, semCitacao: true };
          }
        }
        // Detectar remoção
        const matchRemover = lower.match(/^(remover?|excluir?|deletar?|tirar|apagar?)\s+(.+)$/);
        if (matchRemover) {
          const respRemover = removerItemFluxo(usuarioId, estado, matchRemover[2].trim());
          if (estado.receitasFixas.length === 0) {
            delete estado.confirmandoReceitas;
            salvarPontoZero(usuarioId, estado);
            return `${respRemover}\n\nNenhuma receita fixa restante. Tem alguma receita fixa pra adicionar ou quer seguir em frente?`;
          }
          const listaAtualizada = estado.receitasFixas.map((r, i) =>
            `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia})`
          ).join('\n');
          return { msg: `${respRemover}\n\n📋 Suas receitas fixas:\n${listaAtualizada}\n\nEstá tudo certo? Posso continuar?`, semCitacao: true };
        }
        // Não entendeu — repetir a lista
        const listaRepetida = estado.receitasFixas.map((r, i) =>
          `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia})`
        ).join('\n');
        return { msg: `📋 Suas receitas fixas:\n${listaRepetida}\n\nEstá tudo certo? Posso continuar?\n\n> Você pode alterar dizendo: _"alterar salário para 2000"_ ou _"alterar dia do salário para 10"_`, semCitacao: true };
      }

      if (item.tipo === 'nao' && estado.receitasFixas.length === 0) {
        estado.etapa = 'despesas_fixas';
        salvarPontoZero(usuarioId, estado);
        return `📉 Beleza! Agora as *despesas fixas* tudo que sai todo mês: aluguel, internet, luz, água, escola... *(caso alguma seja no cartão de crédito deixe para os próximos passos)*\n\n> Pode mandar várias de uma vez! Use um valor médio quando o valor varia, você poderá ajustar quando a conta chegar.\n> _Ex: "Aluguel dia 5 R$ 1.500, luz dia 10 R$ 150, internet dia 15 R$ 120"_`;
      }
      if ((item.tipo === 'nao' || querAvancar) && estado.receitasFixas.length > 0 && !estado.confirmandoReceitas) {
        // Antes de avançar, listar e pedir confirmação
        const listaConfirma = estado.receitasFixas.map((r, i) =>
          `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia})`
        ).join('\n');
        estado.confirmandoReceitas = true;
        salvarPontoZero(usuarioId, estado);
        return { msg: `📋 Suas receitas fixas:\n${listaConfirma}\n\nEstá tudo certo? Posso continuar?\n\n> Você pode alterar dizendo: _"alterar salário para 2000"_ ou _"alterar dia do salário para 10"_`, semCitacao: true };
      }
      const res = coletarItens(item, estado.receitasFixas, estado.etapa);
      if (res.ok) {
        if (res.incompletos && res.incompletos.length > 0) {
          const [primeiro, ...restante] = res.incompletos;
          estado.itemParcial = { ...primeiro };
          if (restante.length > 0) estado.itensPendentes = restante;
          else delete estado.itensPendentes;
          salvarPontoZero(usuarioId, estado);
          if (res.msg) {
            return `Certo, anotei:\n\n${res.msg}\nMas preciso da sua ajuda 👇\n\n${perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao)}`;
          }
          return perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao);
        }
        salvarPontoZero(usuarioId, estado);
        // Listar todas as receitas e pedir confirmação
        const listaCompleta = estado.receitasFixas.map((r, i) =>
          `  ${i + 1}. *${r.descricao}* — ${fmt.formatarMoeda(r.valor)} (dia ${r.dia})`
        ).join('\n');
        estado.confirmandoReceitas = true;
        salvarPontoZero(usuarioId, estado);
        return { msg: `📋 Suas receitas fixas:\n${listaCompleta}\n\nEstá tudo certo? Posso continuar?\n\n> Você pode alterar dizendo: _"alterar salário para 2000"_ ou _"alterar dia do salário para 10"_`, semCitacao: true };
      }
      return await redireccionarPontoZero(usuarioId, texto, 'receitas_fixas');
    }

    case 'despesas_fixas': {
      if (item.tipo === 'nao' || (querAvancar && estado.despesasFixas.length > 0)) {
        estado.etapa = 'cartoes';
        salvarPontoZero(usuarioId, estado);
        return `Ótimo! Agora vamos registrar seus *cartões de crédito* — assim as faturas entram na sua projeção e te lembro dos vencimentos.\n\nMe diz o nome do primeiro cartão.\n_Ex: "Nubank", "Inter", "Bradesco Visa"_\n\n_Se não tem cartão, manda "não"._`;
      }
      const res = coletarItens(item, estado.despesasFixas, estado.etapa);
      if (res.ok) {
        if (res.incompletos && res.incompletos.length > 0) {
          const [primeiro, ...restante] = res.incompletos;
          estado.itemParcial = { ...primeiro };
          if (restante.length > 0) estado.itensPendentes = restante;
          else delete estado.itensPendentes;
          salvarPontoZero(usuarioId, estado);
          if (res.msg) {
            return `Certo, anotei:\n\n${res.msg}\nMas preciso da sua ajuda 👇\n\n${perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao)}`;
          }
          return perguntarCampoFaltante(primeiro.esperandoCampo, primeiro.descricao);
        }
        salvarPontoZero(usuarioId, estado);
        const mais = res.quantidade > 1 ? `${res.quantidade} despesas anotadas` : `Anotado`;
        return `${mais}:\n\n${res.msg}\nTem mais alguma despesa ou pode passar pra frente?`;
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
        const budget = await gerarOrcamentoProporcional(estado);
        estado.orcamentos = budget.orcamentos;
        return await finalizarPontoZero(usuarioId, estado);
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
      // Remover cartão já adicionado nesse fluxo
      const matchRemover = lower.match(/^remover\s+(.+)$/);
      if (matchRemover) {
        const nomeBuscado = matchRemover[1].trim().toLowerCase();
        const idx = (estado.cartoes || []).findIndex(c => c.nome.toLowerCase().includes(nomeBuscado));
        if (idx !== -1) {
          const nomeRemovido = estado.cartoes[idx].nome;
          estado.cartoes.splice(idx, 1);
          salvarPontoZero(usuarioId, estado);
          const lista = estado.cartoes.length > 0
            ? `\n\n*Cartões adicionados:*\n${estado.cartoes.map(c => `  💳 ${c.nome}`).join('\n')}`
            : '';
          return `🗑️ *${nomeRemovido}* removido!${lista}\n\nTem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
        }
        const listaAtual = (estado.cartoes || []).length > 0
          ? `\n\n*Cartões adicionados:*\n${estado.cartoes.map(c => `  💳 ${c.nome}`).join('\n')}`
          : '';
        return `Não encontrei esse cartão para remover 😅${listaAtual}\n\nTem outro cartão pra cadastrar?\n_Manda o nome ou "não" pra avançar._`;
      }

      if (item.tipo === 'nao' || querAvancar) {
        if (estado.standalone === 'cartao') {
          // Modo standalone: salvar cartões diretamente e encerrar
          for (const c of estado.cartoes || []) {
            const cartaoId = await db.criarCartao(usuarioId, c.nome, c.limiteTotal, c.diaFechamento, c.diaVencimento);
            await salvarGastosCartao(usuarioId, c, cartaoId);
          }
          limparPontoZero(usuarioId);
          const qtd = (estado.cartoes || []).length;
          if (qtd === 0) return `Tudo bem! Nenhum cartão cadastrado.`;
          const lista = (estado.cartoes || []).map(c => `  💳 *${c.nome}* — vence dia ${c.diaVencimento}${c.valorFatura > 0 ? ` | fatura ${fmt.formatarMoeda(c.valorFatura)}` : ''}`).join('\n');
          return `✅ ${qtd === 1 ? 'Cartão cadastrado' : `${qtd} cartões cadastrados`} com sucesso!\n\n${lista}`;
        }
        estado.etapa = 'investimentos';
        salvarPontoZero(usuarioId, estado);
        return `Ótimo! Agora me conta sobre suas *reservas e investimentos* 🏦\n\nPoupança, CDB, Tesouro Direto, ações, fundos... cada um vira uma *caixinha* separada e entra no seu patrimônio total.\n\nMe diz o nome da primeira caixinha.\n_Ex: "Poupança", "CDB Nubank", "Reserva emergência"_\n\n_Se não tem nada guardado, manda "não"._`;
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
        const budget = await gerarOrcamentoProporcional(estado);
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
// Salva os gastos de um cartão (modo completo ou simples) no banco
async function salvarGastosCartao(usuarioId, c, cartaoId) {
  const hojeISO = dateParaISO(new Date());

  if (c.metodoCompleto) {
    // Assinaturas → recorrência mensal + transação no cartão
    for (const ass of c.assinaturas || []) {
      const recId = await db.criarRecorrencia(
        usuarioId, 'despesa', ass.valor, ass.descricao, 'Assinatura',
        'mensal', c.diaFechamento || 1, null, null, null
      );
      await db.adicionarTransacaoComRecorrencia(
        usuarioId, 'despesa', ass.valor, ass.descricao, 'Assinatura',
        hojeISO, 'pago', recId, cartaoId
      );
    }

    // Parcelas em andamento → criar parcelas restantes (primeira como pago, resto pendente)
    for (const par of c.parcelas || []) {
      const ids = [];
      for (let i = 0; i < par.restantes; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() + i);
        const dataStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(Math.min(c.diaFechamento || d.getDate(), 28)).padStart(2, '0')}`;
        const status = i === 0 ? 'pago' : 'pendente';
        const parcNum = i + 1;
        const result = await db.adicionarTransacao(
          usuarioId, 'despesa', par.valorParcela,
          `${par.descricao} (${parcNum}/${par.restantes})`,
          'Compras', dataStr, status, cartaoId
        );
        ids.push(result);
      }
    }

    // Gastos avulsos → transações simples no cartão
    for (const av of c.avulsos || []) {
      await db.adicionarTransacao(
        usuarioId, 'despesa', av.valor, av.descricao,
        'Outros', hojeISO, 'pago', cartaoId
      );
    }

    // Se o total detalhado não cobre a fatura, registrar a diferença
    const totalAss = (c.assinaturas || []).reduce((s, a) => s + a.valor, 0);
    const totalPar = (c.parcelas || []).reduce((s, p) => s + p.valorParcela, 0);
    const totalAv  = (c.avulsos || []).reduce((s, a) => s + a.valor, 0);
    const totalDetalhado = totalAss + totalPar + totalAv;
    const diferenca = (c.valorFatura || 0) - totalDetalhado;

    if (diferenca > 1) {
      await db.adicionarTransacao(
        usuarioId, 'despesa', diferenca, `Outros gastos ${c.nome}`,
        'Outros', hojeISO, 'pago', cartaoId
      );
    }
  } else {
    // Modo simples: registrar só o valor da fatura como pendente
    if (c.valorFatura && c.valorFatura > 0) {
      const dataVenc = calcularDataPendenteMesAtual(c.diaVencimento);
      await db.adicionarTransacao(usuarioId, 'despesa', c.valorFatura, `Fatura ${c.nome}`, 'Fatura', dataVenc, 'pendente', cartaoId);
    }
  }
}

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

  // Despesas fixas → regra de recorrência + transação pendente no mês atual (sempre neste mês no setup inicial)
  for (const d of estado.despesasFixas || []) {
    const recorrenciaId = await db.criarRecorrencia(
      usuarioId, 'despesa', d.valor, d.descricao, d.categoria || 'Outros',
      'mensal', d.dia || 1, null, null, null
    );
    const dataStr = calcularDataPendenteMesAtual(d.dia);
    await db.adicionarTransacaoComRecorrencia(usuarioId, 'despesa', d.valor, d.descricao, d.categoria || 'Outros', dataStr, 'pendente', recorrenciaId);
  }

  // Cartões → criar cartão + gastos detalhados ou fatura simples
  for (const c of estado.cartoes || []) {
    const cartaoId = await db.criarCartao(usuarioId, c.nome, c.limiteTotal, c.diaFechamento, c.diaVencimento);
    await salvarGastosCartao(usuarioId, c, cartaoId);
  }

  // Investimentos → criar caixinhas no banco
  for (const inv of estado.investimentos || []) {
    await db.criarCaixinha(usuarioId, inv.nome, inv.saldo, inv.meta, inv.tipo, inv.rendimento);
  }

  // Inicializar categorias principais do usuário (com percentuais padrão)
  await db.inicializarCategoriasPrincipais(usuarioId);

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
  const rfFixasFut  = (estado.receitasFixas || []).filter(ehFuturo);
  const dfFixasFut  = (estado.despesasFixas || []).filter(ehFuturo);

  const rfFixasPass = (estado.receitasFixas || []).filter(r => !ehFuturo(r));
  const dfFixasPass = (estado.despesasFixas || []).filter(d => !ehFuturo(d));

  // Cartões: fatura futura = diaVencimento ainda não passou; passada = já passou
  const cartoesFut  = (estado.cartoes || []).filter(c => c.valorFatura > 0 && (!c.diaVencimento || c.diaVencimento >= diaHoje));
  const cartoesPass = (estado.cartoes || []).filter(c => c.valorFatura > 0 && c.diaVencimento && c.diaVencimento < diaHoje);

  const soma = arr => arr.reduce((s, x) => s + x.valor, 0);
  const somaCartoes = arr => arr.reduce((s, c) => s + c.valorFatura, 0);

  const totalRecFixasFut   = soma(rfFixasFut);
  const totalDespFixasFut  = soma(dfFixasFut);
  const totalCartoesFut    = somaCartoes(cartoesFut);
  const totalRecFut  = totalRecFixasFut;
  const totalDespFut = totalDespFixasFut + totalCartoesFut;
  const previsao = estado.saldoInicial + totalRecFut - totalDespFut;

  const investimentos = estado.investimentos || [];
  const totalInvestido = investimentos.reduce((s, i) => s + i.saldo, 0);

  let msg = `📊 *FINANÇAS EM DIA — ${mesAtual.toUpperCase()}*\n\n`;
  msg += `💰 *Saldo atual:* ${fmt.formatarMoeda(estado.saldoInicial)}\n\n`;

  // Caixinhas — resumo compacto
  if (investimentos.length > 0) {
    msg += `🏦 *Investimentos:* ${fmt.formatarMoeda(totalInvestido)}`;
    msg += ` _(${investimentos.length} ${investimentos.length === 1 ? 'caixinha' : 'caixinhas'})_\n\n`;
  }

  // Receitas e despesas — apenas totais
  const totalReceitasGeral = (estado.receitasFixas || []).reduce((s, r) => s + r.valor, 0);
  const totalDespesasGeral = (estado.despesasFixas || []).reduce((s, d) => s + d.valor, 0);

  if (totalRecFixasFut > 0) {
    msg += `📈 *Receitas a receber:* +${fmt.formatarMoeda(totalRecFixasFut)}`;
    msg += rfFixasFut.length > 1 ? ` _(${rfFixasFut.length} itens)_` : '';
    msg += '\n';
  }

  if (totalDespFixasFut > 0) {
    msg += `📉 *Despesas a pagar:* -${fmt.formatarMoeda(totalDespFixasFut)}`;
    msg += dfFixasFut.length > 1 ? ` _(${dfFixasFut.length} itens)_` : '';
    msg += '\n';
  }

  if (totalCartoesFut > 0) {
    msg += `💳 *Faturas de cartão:* -${fmt.formatarMoeda(totalCartoesFut)}`;
    msg += cartoesFut.length > 1 ? ` _(${cartoesFut.length} cartões)_` : '';
    msg += '\n';
  }

  msg += '\n';

  // Orçamento proporcional
  const totalReceitas = totalReceitasGeral;
  const totalFixasReal = totalDespesasGeral;
  let catsPrincipais = await db.listarCategoriasPrincipais(usuarioId);
  if (catsPrincipais.length === 0) catsPrincipais = db.CATEGORIAS_PRINCIPAIS_PADRAO;
  const catFixas = catsPrincipais.find(c => c.nome === 'Despesas Fixas');
  const pctFixas = catFixas ? catFixas.percentual : 50;
  const limiteFixas = Math.round(totalReceitas * (pctFixas / 100));
  const alertaFixas = totalFixasReal > limiteFixas;

  const linhasOrcamento = catsPrincipais.map(c => ({
    label: c.nome === 'Despesas Fixas' ? 'Fixas' : c.nome,
    pct: c.percentual,
    valor: Math.round(totalReceitas * (c.percentual / 100)),
    real: c.nome === 'Despesas Fixas' ? totalFixasReal : null,
    check: c.nome === 'Despesas Fixas',
  }));

  if (totalReceitas > 0) {
    msg += `📊 *Orçamento sugerido:*\n`;
    for (const l of linhasOrcamento) {
      const barra = l.check && alertaFixas ? '⚠️' : '▸';
      msg += `${barra} *${l.label}* ${l.pct}% → ${fmt.formatarMoeda(l.valor)}`;
      if (l.check && alertaFixas) {
        msg += ` _(atual: ${fmt.formatarMoeda(l.real)})_`;
      }
      msg += '\n';
    }
    msg += '\n';
  }

  // Previsão final
  const emojiPrev = previsao >= 0 ? '✅' : '🚨';
  msg += `${emojiPrev} *Previsão até o último dia do mês (${ultimoDia}/${mmAtual}):* ${fmt.formatarMoeda(previsao)}`;
  if (previsao >= 0) {
    msg += ` 💪`;
  } else {
    msg += `\n_⚠️ Faltam ${fmt.formatarMoeda(Math.abs(previsao))} pra fechar no azul_`;
  }
  msg += '\n';

  msg += `\n_Pronto! Agora é só usar o Cronos no dia a dia_ 🚀\n`;
  msg += `_Peça *"resumo"* ou *"agenda"* quando quiser acompanhar_`;

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

  const categoriaMap = await categorizarExtrato(descUnicas, usuarioId);

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
  const categoriaMap = await categorizarExtrato(descUnicas, usuarioId);

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

// Garbage collector: limpa entradas expiradas de todos os Maps de estado
function limparMapsExpirados() {
  const agora = Date.now();
  let limpos = 0;
  const maps = [
    confirmacoesPendentes, transacaoPendente, excluirPendentes,
    removerCartaoPendentes, editarTxPendentes, editarRecPendentes,
    editarRecDiretoPendentes, editarCartaoPendentes, editarCaixinhaPendentes,
    editarLimitePendentes, editarLembretePendentes, transacoesMultiplasPendentes,
    assessorCompraPendenteMap, recorrenciaDiaPendente, recorrenciaValorPendente,
    lembretesPendentes, confirmacaoLembrete, pontoZeroEstados,
    analiseFinanceiraEstados, localizacaoUsuario, removerContatoPendente,
    onboardingEstados, cadastroPainelEstados,
  ];
  for (const m of maps) {
    for (const [key, val] of m.entries()) {
      if (val && val.expiraEm && agora > val.expiraEm) {
        m.delete(key);
        limpos++;
      }
    }
  }
  if (limpos > 0) {
    console.log(`[GC] ${limpos} entrada(s) expirada(s) removida(s) dos Maps de estado.`);
  }
}

module.exports = { handleMessage, handleImageMessage, handleCSVImport, handleLocationMessage, handleContatoCompartilhado, handleAnaliseFinanceiraCSV, obterAnaliseFinanceira, mensagemBoasVindas, mensagemConviteCompartilhado, registrarLembreteAtivo, setOnboardingState, mensagemApresentacao, mensagemPerguntaNome, limparMapsExpirados };
