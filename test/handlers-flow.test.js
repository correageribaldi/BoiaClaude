// ── Setup: env + mocks ANTES de carregar handlers ────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mocks delegadores para AI (handlers.js faz destructuring no require) ─────
// Variáveis mutáveis — redefinidas no beforeEach de cada teste
let mockInterpretarMensagem = async () => ({ acao: 'saudacao', resposta: 'Olá!' });
let mockExtrairNomeOnboarding = async (t) => t;
let mockExtrairValorMonetario = async () => null;
let mockExtrairHorario = async () => null;
let mockResponderAssistente = async () => 'Resposta do assistente';
let mockInterpretarConfirmacaoPagamento = async () => false;
let mockClassificarCategoriaBudget = async () => 'Essencial';
let mockGerarDiagnosticoFinanceiro = async () => 'Diagnóstico mock';
let mockAnalisarViabilidadeCompra = async () => 'Análise mock';
let mockDataHojeBRISO = () => '2026-03-16';
let mockAnalisarImagem = async () => null;
let mockInterpretarItemFinanceiro = async () => ({});
let mockCategorizarExtrato = async () => [];
let mockFormatarResultadosPesquisa = () => '';

const ai = require('../src/ai');
ai.interpretarMensagem = async (...args) => mockInterpretarMensagem(...args);
ai.extrairNomeOnboarding = async (...args) => mockExtrairNomeOnboarding(...args);
ai.extrairValorMonetario = async (...args) => mockExtrairValorMonetario(...args);
ai.extrairHorario = async (...args) => mockExtrairHorario(...args);
ai.responderAssistente = async (...args) => mockResponderAssistente(...args);
ai.interpretarConfirmacaoPagamento = async (...args) => mockInterpretarConfirmacaoPagamento(...args);
ai.classificarCategoriaBudget = async (...args) => mockClassificarCategoriaBudget(...args);
ai.gerarDiagnosticoFinanceiro = async (...args) => mockGerarDiagnosticoFinanceiro(...args);
ai.analisarViabilidadeCompra = async (...args) => mockAnalisarViabilidadeCompra(...args);
ai.dataHojeBRISO = (...args) => mockDataHojeBRISO(...args);
ai.analisarImagem = async (...args) => mockAnalisarImagem(...args);
ai.interpretarItemFinanceiro = async (...args) => mockInterpretarItemFinanceiro(...args);
ai.categorizarExtrato = async (...args) => mockCategorizarExtrato(...args);
ai.formatarResultadosPesquisa = (...args) => mockFormatarResultadosPesquisa(...args);

// Mock search (também faz destructuring)
const search = require('../src/search');
search.pesquisarWeb = async () => [];
search.pesquisarLocal = async () => [];

// Mock charts (usado como objeto)
const charts = require('../src/charts');
charts.gerarGraficoResumo = async () => Buffer.from('mock');
charts.gerarGraficoComparativo = async () => Buffer.from('mock');

// AGORA carregar handlers (vai pegar os wrappers já instalados)
const { handleMessage, setOnboardingState, limparMapsExpirados } = require('../src/handlers');

// db e pagamento: handlers usa como objeto (db.fn()), mock.method funciona
const db = require('../src/database');
const pagamento = require('../src/pagamento');

// ── Helpers ──────────────────────────────────────────────────────────────────

let userCounter = 0;
function novoUsuario() {
  userCounter++;
  return `5511${String(userCounter).padStart(9, '0')}@c.us`;
}

function extrairTexto(resp) {
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return resp.map(extrairTexto).join('\n');
  if (resp?.msg) return resp.msg;
  if (resp?.texto) return resp.texto;
  return String(resp);
}

function assertContem(resp, ...fragmentos) {
  const texto = extrairTexto(resp).toLowerCase();
  for (const f of fragmentos) {
    assert.ok(texto.includes(f.toLowerCase()), `Resposta deveria conter "${f}". Resposta: ${texto.slice(0, 200)}`);
  }
}

// ── Mock padrão do DB ────────────────────────────────────────────────────────

function aplicarMocksPadraoDB(t) {
  // Onboarding
  t.mock.method(db, 'salvarOnboardingEstadoDB', async () => {});
  t.mock.method(db, 'buscarOnboardingEstadoDB', async () => null);
  t.mock.method(db, 'atualizarNomeUsuario', async () => {});
  t.mock.method(db, 'buscarUsuario', async () => ({ nome: 'Teste', usuario_id: '0' }));
  t.mock.method(db, 'registrarUsuario', async () => {});

  // Feedback
  t.mock.method(db, 'buscarFeedbackPendente', async () => null);
  t.mock.method(db, 'registrarRespostaFeedback', async () => {});

  // Fluxo ativo
  t.mock.method(db, 'buscarFluxoAtivoDB', async () => null);
  t.mock.method(db, 'salvarFluxoAtivoDB', async () => {});
  t.mock.method(db, 'limparFluxoAtivoDB', async () => {});

  // Categorias
  t.mock.method(db, 'listarCategoriasParaIA', async () => []);
  t.mock.method(db, 'buscarBudgetCat', async () => null);
  t.mock.method(db, 'salvarBudgetCat', async () => {});
  t.mock.method(db, 'listarCategoriasPrincipais', async () => []);
  t.mock.method(db, 'inicializarCategoriasPrincipais', async () => {});
  t.mock.method(db, 'listarLimites', async () => []);
  t.mock.method(db, 'listarLimitesComSub', async () => []);
  t.mock.method(db, 'definirLimite', async () => {});
  t.mock.method(db, 'verificarLimite', async () => null);
  t.mock.method(db, 'garantirSubcategoria', async () => {});
  // Limitadores de gasto: o consumo é consultado em toda confirmação de
  // despesa, e sem limitador cadastrado o bloco de teto some da mensagem.
  t.mock.method(db, 'listarLimitadores', async () => []);
  t.mock.method(db, 'verificarLimitadorDaCategoria', async () => null);
  t.mock.method(db, 'listarConsumoLimitadores', async () => []);

  // Transacoes
  t.mock.method(db, 'adicionarTransacao', async () => ({ id: 1 }));
  t.mock.method(db, 'listarTransacoes', async () => []);
  t.mock.method(db, 'consultarTransacoes', async () => []);
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: 0, quantidade: 0 }));
  t.mock.method(db, 'buscarTransacoesPorDescricao', async () => []);

  // Saldos
  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 0, saldoPrevisao: 0, receitasPagas: 0, despesasPagas: 0,
    receitasPendentes: 0, despesasPendentes: 0, totalCaixinhas: 0,
  }));

  // Patrimônio e investimentos são conceitos separados do saldo (ver
  // db.calcularPatrimonio). Zerados por padrão para que a mensagem de saldo
  // continue sem o bloco de composição, que só aparece quando há reserva,
  // investimento ou fatura aberta.
  t.mock.method(db, 'calcularPatrimonio', async () => ({
    saldoContas: 0, reservas: 0, investimentos: 0, faturaCartao: 0, total: 0,
  }));
  t.mock.method(db, 'resumoInvestimentos', async () => ({
    total: 0, totalAplicado: 0, totalLucro: 0, quantidade: 0, porTipo: [], porEmissor: [],
  }));

  // Pendentes
  t.mock.method(db, 'listarPendentes', async () => []);

  // Resumo
  t.mock.method(db, 'resumoMensal', async () => ({ receitas: 0, despesas: 0, saldo: 0 }));

  // Recorrencias
  t.mock.method(db, 'listarRecorrencias', async () => []);
  t.mock.method(db, 'criarRecorrencia', async () => ({ id: 1 }));

  // Cartoes
  t.mock.method(db, 'listarCartoes', async () => []);
  t.mock.method(db, 'buscarCartoesPorNome', async () => []);

  // Caixinhas
  t.mock.method(db, 'listarCaixinhas', async () => []);

  // Lembretes
  t.mock.method(db, 'listarLembretesGerais', async () => []);
  t.mock.method(db, 'listarLembretesRecorrentes', async () => []);
  t.mock.method(db, 'listarRecorrentesAtivos', async () => []);
  t.mock.method(db, 'criarLembreteGeral', async () => ({ id: 1 }));

  // Salario
  t.mock.method(db, 'buscarSalarioUsuario', async () => null);

  // Contatos
  t.mock.method(db, 'listarContatosCompartilhados', async () => []);

  // Painel
  t.mock.method(db, 'buscarUsuarioPainelPorUserId', async () => null);

  // Assinatura
  t.mock.method(db, 'buscarAssinatura', async () => null);

  // Limpar dados
  t.mock.method(db, 'limparDadosUsuario', async () => {});

  // Cupons
  t.mock.method(db, 'buscarCupom', async () => null);
}

function aplicarMocksPadraoPagamento(t) {
  t.mock.method(pagamento, 'consultarPlano', async () => 'Plano mock');
  t.mock.method(pagamento, 'gerarLinkPlano', async () => 'Link mock');
  t.mock.method(pagamento, 'aplicarCupom', async () => ({ ok: false, erro: 'Mock' }));
}

function resetarMocksAI() {
  mockInterpretarMensagem = async () => ({ acao: 'saudacao', resposta: 'Olá!' });
  mockExtrairNomeOnboarding = async (t) => t;
  mockExtrairValorMonetario = async () => null;
  mockExtrairHorario = async () => null;
  mockResponderAssistente = async () => 'Resposta do assistente';
  mockInterpretarConfirmacaoPagamento = async () => false;
  mockClassificarCategoriaBudget = async () => 'Essencial';
  mockDataHojeBRISO = () => '2026-03-16';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING
// ═══════════════════════════════════════════════════════════════════════════════

test('Onboarding: aguardando_nome → nome valido → confirmando_nome', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'João';

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  const resp = await handleMessage(uid, 'Me chamo João', null);
  assertContem(resp, 'João', 'tudo bem');
});

test('Onboarding: aguardando_nome → AI retorna null → pede nome novamente', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => null;

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  const resp = await handleMessage(uid, 'xyz', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nome') || texto.includes('chamado'), `Esperava pedido de nome. Resp: ${texto.slice(0, 200)}`);
});

test('Onboarding: aguardando_nome → texto vazio → pede nome', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  const resp = await handleMessage(uid, '   ', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('chamado') || texto.includes('nome'), `Esperava pedido de nome. Resp: ${texto.slice(0, 200)}`);
});

test('Onboarding: confirmando_nome → "ok" → aguardando_inicio com opcoes', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'ok', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('organizar') || texto.includes('dia a dia'), `Esperava opcoes de inicio. Resp: ${texto.slice(0, 300)}`);
});

test('Onboarding: confirmando_nome → novo nome → atualiza nome', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Maria';

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'Maria', null);
  assertContem(resp, 'Maria');
});

test('Onboarding: aguardando_inicio → "2" (dia a dia) → onboarding completo', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, '2', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('gastei') || texto.includes('simples') || texto.includes('registr'), `Esperava instrucoes de uso. Resp: ${texto.slice(0, 300)}`);
});

test('Onboarding: aguardando_inicio → "1" (organizar) → inicia Financas em Dia', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, '1', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('disponível') || texto.includes('conta') || texto.includes('dia') || texto.includes('finan'), `Esperava inicio do Financas em Dia. Resp: ${texto.slice(0, 300)}`);
});

test('Onboarding: aguardando_inicio → texto nao reconhecido → re-prompt', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, 'nao sei', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('1') && texto.includes('2'), `Esperava opcoes numeradas. Resp: ${texto.slice(0, 300)}`);
});

test('Onboarding: trocando_nome → nome valido → confirma troca', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Carlos';

  const uid = novoUsuario();
  setOnboardingState(uid, 'trocando_nome');

  const resp = await handleMessage(uid, 'Carlos', null);
  assertContem(resp, 'Carlos');
});

test('Onboarding: deteccao "meu nome" durante aguardando_inicio → troca e volta', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Ana';

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, 'me chama de Ana', null);
  const texto = extrairTexto(resp).toLowerCase();
  // Deve trocar nome e retornar as opcoes de inicio
  assert.ok(texto.includes('ana'), `Esperava conter "Ana". Resp: ${texto.slice(0, 300)}`);
});

// ── Fluxo completo multi-turn ────────────────────────────────────────────────

test('Onboarding completo: nome → confirma → dia a dia', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  // Turn 1: envia nome
  mockExtrairNomeOnboarding = async () => 'Pedro';
  const r1 = await handleMessage(uid, 'Pedro', null);
  assertContem(r1, 'Pedro', 'tudo bem');

  // Turn 2: confirma nome
  const r2 = await handleMessage(uid, 'ok', null);
  const texto2 = extrairTexto(r2).toLowerCase();
  assert.ok(texto2.includes('organizar') || texto2.includes('dia a dia'), 'Esperava opcoes de inicio');

  // Turn 3: escolhe dia a dia
  const r3 = await handleMessage(uid, '2', null);
  const texto3 = extrairTexto(r3).toLowerCase();
  assert.ok(texto3.includes('gastei') || texto3.includes('simples') || texto3.includes('registr'), 'Esperava instrucoes');
});

test('Onboarding com correcao de nome: nome → rejeita → novo nome → confirma → dia a dia', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  // Turn 1: envia nome
  mockExtrairNomeOnboarding = async () => 'Joao';
  const r1 = await handleMessage(uid, 'Joao', null);
  assertContem(r1, 'Joao');

  // Turn 2: corrige o nome (estado confirmando_nome, envia outro nome)
  mockExtrairNomeOnboarding = async () => 'Pedro';
  const r2 = await handleMessage(uid, 'Pedro', null);
  assertContem(r2, 'Pedro');

  // Turn 3: confirma
  const r3 = await handleMessage(uid, 'sim', null);
  const texto3 = extrairTexto(r3).toLowerCase();
  assert.ok(texto3.includes('organizar') || texto3.includes('dia a dia'), 'Esperava opcoes');

  // Turn 4: escolhe dia a dia
  const r4 = await handleMessage(uid, 'dia a dia', null);
  const texto4 = extrairTexto(r4).toLowerCase();
  assert.ok(texto4.includes('gastei') || texto4.includes('simples') || texto4.includes('registr'), 'Esperava instrucoes');
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORA DO ONBOARDING — Comandos diretos
// ═══════════════════════════════════════════════════════════════════════════════

test('Comando: "ajuda" retorna menu de ajuda', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  // Sem onboarding (usuario ja existe)

  const resp = await handleMessage(uid, 'ajuda', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('ajuda') || texto.includes('menu') || texto.includes('comando') || texto.includes('despesa') || texto.includes('receita'), `Esperava menu. Resp: ${texto.slice(0, 300)}`);
});

test('Comando: "saldo" retorna saldo formatado', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  // Mock saldo com valores
  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 2500, saldoPrevisao: 2000, receitasPagas: 5000, despesasPagas: 2500,
    receitasPendentes: 0, despesasPendentes: 500, totalCaixinhas: 200,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  const texto = extrairTexto(resp);
  assert.ok(texto.includes('R$') || texto.includes('Saldo') || texto.includes('saldo'), `Esperava saldo. Resp: ${texto.slice(0, 300)}`);
});

test('Comando: "resumo" retorna resumo mensal', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'consultarTransacoes', async () => [
    { id: 1, tipo: 'despesa', data: '2026-03-10', valor: 100, descricao: 'Mercado', categoria: 'Alimentação', status: 'pago' },
  ]);
  t.mock.method(db, 'consultarTotalTransacoes', async (uid, filtros) => {
    if (filtros.tipo === 'receita') return { total: 5000, quantidade: 2 };
    return { total: 3000, quantidade: 5 };
  });
  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 2000, saldoPrevisao: 2000, receitasPagas: 5000, despesasPagas: 3000,
    receitasPendentes: 0, despesasPendentes: 0, totalCaixinhas: 0,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'resumo', null);
  const texto = extrairTexto(resp);
  assert.ok(texto.includes('Resumo') || texto.includes('resumo') || texto.includes('R$'), `Esperava resumo. Resp: ${texto.slice(0, 300)}`);
});

test('Comando: "pendentes" retorna lista de pendentes', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'pendentes', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('pendente') || texto.includes('nenhum') || texto.includes('pagar'), `Esperava lista de pendentes. Resp: ${texto.slice(0, 300)}`);
});

test('Comando: "despesa 100 Almoço" registra transacao direta', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'despesa 100 Almoço restaurante', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('registrad') || texto.includes('almoço') || texto.includes('100'), `Esperava confirmacao de registro. Resp: ${texto.slice(0, 300)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORA DO ONBOARDING — Mensagens interpretadas por IA
// ═══════════════════════════════════════════════════════════════════════════════

test('IA: transacao via linguagem natural', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: 50,
    descricao: 'Almoço',
    categoria: 'Alimentação',
    data: '2026-03-16',
    status: 'pago',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'gastei 50 no almoço', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('almoço') || texto.includes('registr') || texto.includes('50') || texto.includes('r$'), `Esperava registro. Resp: ${texto.slice(0, 300)}`);
});

test('IA: saudacao retorna mensagem de boas vindas', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'saudacao',
    resposta: 'Olá {{NOME}}! Como posso ajudar?',
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'oi', null);
  const texto = extrairTexto(resp).toLowerCase();
  // Sem transacoes, retorna boas vindas
  assert.ok(texto.includes('olá') || texto.includes('ola') || texto.includes('ajud') || texto.includes('bem-vindo') || texto.includes('boas vindas') || texto.includes('cronos'), `Esperava boas vindas. Resp: ${texto.slice(0, 300)}`);
});

test('IA: conversa casual retorna resposta da IA', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'conversa',
    resposta: 'Que legal! Posso te ajudar com suas finanças.',
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'como vai voce', null);
  const texto = extrairTexto(resp);
  assert.ok(texto.includes('Que legal') || texto.includes('finanças'), `Esperava conversa. Resp: ${texto.slice(0, 300)}`);
});

test('IA: resultado null com saudacao → retorna ajuda', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => null;

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'oi tudo bem', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('ajuda') || texto.includes('menu') || texto.includes('despesa') || texto.includes('posso'), `Esperava ajuda/menu. Resp: ${texto.slice(0, 300)}`);
});

test('IA: "resetar" limpa dados e reinicia onboarding', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'resetar', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('cronos') || texto.includes('chamar') || texto.includes('nome'), `Esperava mensagem de apresentacao. Resp: ${texto.slice(0, 300)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRIORIDADE DE ESTADOS
// ═══════════════════════════════════════════════════════════════════════════════

test('Prioridade: onboarding bloqueia comandos — "ajuda" tratado como nome', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Ajuda';

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  const resp = await handleMessage(uid, 'ajuda', null);
  // Deve ser tratado como nome, nao como comando
  assertContem(resp, 'Ajuda');
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('tudo bem') || texto.includes('chamar'), 'Deveria tratar como nome, nao comando');
});

test('Prioridade: feedback pendente bloqueia mensagens regulares', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'buscarFeedbackPendente', async () => ({ id: 1 }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'Gostei muito do bot!', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('feedback') || texto.includes('obrigado'), `Esperava agradecimento de feedback. Resp: ${texto.slice(0, 300)}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATO DE RESPOSTA
// ═══════════════════════════════════════════════════════════════════════════════

test('Formato: "ajuda" retorna objeto com semCitacao', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'ajuda', null);
  assert.ok(resp && typeof resp === 'object' && !Array.isArray(resp), 'Esperava objeto');
  assert.equal(resp.semCitacao, true, 'Esperava semCitacao: true');
});

test('Formato: confirmacao de nome retorna objeto com semCitacao', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Ana';

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  const resp = await handleMessage(uid, 'Ana', null);
  assert.ok(resp && typeof resp === 'object' && !Array.isArray(resp), 'Esperava objeto');
  assert.equal(resp.semCitacao, true, 'Esperava semCitacao: true');
});

test('Formato: escolha de inicio retorna array de mensagens', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'ok', null);
  assert.ok(Array.isArray(resp), 'Esperava array de mensagens');
  assert.ok(resp.length >= 2, 'Esperava pelo menos 2 mensagens');
});

test('Formato: "saldo" retorna string simples', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  assert.equal(typeof resp, 'string', 'Esperava string');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SALDO — testes detalhados
// ═══════════════════════════════════════════════════════════════════════════════

test('Saldo: exibe receitas, despesas e saldo atual', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 3500, saldoPrevisao: 2800, receitasPagas: 5000, despesasPagas: 1500,
    receitasPendentes: 500, despesasPendentes: 1200, totalCaixinhas: 0,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  assertContem(resp, 'Saldo Atual', 'R$');
  assert.ok(resp.includes('5.000') || resp.includes('5000'), 'Deve mostrar receitas');
  assert.ok(resp.includes('1.500') || resp.includes('1500'), 'Deve mostrar despesas');
});

test('Saldo: exibe patrimonio itemizado quando ha reserva, investimento ou fatura', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 2000, saldoPrevisao: 2000, receitasPagas: 3000, despesasPagas: 1000,
    receitasPendentes: 0, despesasPendentes: 0, totalCaixinhas: 5000,
  }));
  t.mock.method(db, 'calcularPatrimonio', async () => ({
    saldoContas: 2000, reservas: 5000, investimentos: 3000, faturaCartao: 500, total: 9500,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);

  // Reserva manual e investimento sincronizado aparecem em linhas SEPARADAS.
  // Caixinha de banco é lastreada em CDB, então podem ser o mesmo dinheiro —
  // somá-los num número só esconderia a sobreposição do usuário.
  assertContem(resp, 'Patrimônio', 'Reservas', 'Investimentos', 'Fatura do cartão');
});

test('Saldo: exibe pendencias quando existem', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 1000, saldoPrevisao: 500, receitasPagas: 2000, despesasPagas: 1000,
    receitasPendentes: 300, despesasPendentes: 800, totalCaixinhas: 0,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  assertContem(resp, 'Previsão', 'receber', 'pagar');
});

test('Saldo: sem pendencias mostra mensagem especifica', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: 1000, saldoPrevisao: 1000, receitasPagas: 1000, despesasPagas: 0,
    receitasPendentes: 0, despesasPendentes: 0, totalCaixinhas: 0,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  assertContem(resp, 'pendência');
});

test('Saldo: saldo negativo exibe indicador vermelho', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'calcularSaldos', async () => ({
    saldoAtual: -500, saldoPrevisao: -800, receitasPagas: 1000, despesasPagas: 1500,
    receitasPendentes: 0, despesasPendentes: 300, totalCaixinhas: 0,
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'saldo', null);
  assert.ok(resp.includes('🔴'), 'Saldo negativo deve ter indicador vermelho');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RECEITAS — testes detalhados
// ═══════════════════════════════════════════════════════════════════════════════

test('Receitas: "receitas" lista ultimas receitas', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarTransacoes', async () => [
    { id: 1, tipo: 'receita', data: '2026-03-01', valor: 5000, descricao: 'Salário', categoria: 'Renda', status: 'pago' },
    { id: 2, tipo: 'receita', data: '2026-03-10', valor: 800, descricao: 'Freelance', categoria: 'Renda Extra', status: 'pago' },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'receitas', null);
  assertContem(resp, 'Salário', 'Freelance', '#1', '#2');
});

test('Receitas: lista vazia retorna mensagem adequada', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarTransacoes', async () => []);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'receitas', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nenhum'), 'Esperava mensagem de lista vazia');
});

test('Receitas: registrar receita via IA', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'receita',
    valor: 3000,
    descricao: 'Salário março',
    categoria: 'Renda',
    data: '2026-03-05',
    status: 'pago',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'recebi 3000 de salário dia 5', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('receita') && texto.includes('registrad'), 'Deve confirmar registro de receita');
  assertContem(resp, 'Salário março', 'R$');
});

test('Receitas: receita pendente mostra lembrete', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'receita',
    valor: 1500,
    descricao: 'Pagamento cliente',
    categoria: 'Renda Extra',
    data: '2026-03-25',
    status: 'pendente',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'vou receber 1500 do cliente dia 25', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('receber') || texto.includes('lembr'), 'Deve mencionar lembrete para pendente');
});

// ═══════════════════════════════════════════════════════════════════════════════
// DESPESAS — testes detalhados
// ═══════════════════════════════════════════════════════════════════════════════

test('Despesas: "despesas" lista ultimas despesas', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarTransacoes', async () => [
    { id: 1, tipo: 'despesa', data: '2026-03-10', valor: 150, descricao: 'Mercado', categoria: 'Alimentação', status: 'pago' },
    { id: 2, tipo: 'despesa', data: '2026-03-12', valor: 80, descricao: 'Uber', categoria: 'Transporte', status: 'pago' },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'despesas', null);
  assertContem(resp, 'Mercado', 'Uber', '#1', '#2');
});

test('Despesas: despesa direta com valor e descricao', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'despesa 250 Conta de luz', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('registrad'), 'Deve confirmar registro');
  assertContem(resp, 'Conta de luz', '250');
});

test('Despesas: despesa via IA com categoria', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: 45.90,
    descricao: 'Gasolina',
    categoria: 'Transporte',
    data: '2026-03-16',
    status: 'pago',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'gastei 45,90 de gasolina', null);
  assertContem(resp, 'Gasolina', 'Transporte', 'R$');
});

test('Despesas: despesa pendente ("a pagar")', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: 1200,
    descricao: 'Aluguel',
    categoria: 'Moradia',
    data: '2026-03-20',
    status: 'pendente',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'pagar aluguel 1200 dia 20', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('pagar') || texto.includes('lembr') || texto.includes('pendente'), 'Deve indicar pendencia');
  assertContem(resp, 'Aluguel');
});

test('Despesas: despesa sem valor — pergunta valor', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: null,
    descricao: 'Farmácia',
    categoria: 'Saúde',
    data: '2026-03-16',
    status: 'pago',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'gastei na farmácia', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('valor') || texto.includes('quanto'), 'Deve perguntar o valor');
  assertContem(resp, 'Farmácia');
});

test('Despesas: despesa direta formato invalido', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'despesa abc teste', null);
  // "despesa abc" - abc is not a valid number, so it falls through to AI
  assert.ok(typeof resp === 'string' || typeof resp === 'object', 'Deve retornar resposta');
});

test('Despesas: "pendentes" lista contas a pagar', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarPendentes', async () => [
    { id: 1, tipo: 'despesa', data: '2026-03-20', valor: 1200, descricao: 'Aluguel', categoria: 'Moradia', status: 'pendente' },
    { id: 2, tipo: 'receita', data: '2026-03-25', valor: 500, descricao: 'Freelance', categoria: 'Renda', status: 'pendente' },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'pendentes', null);
  assertContem(resp, 'Aluguel', 'Freelance');
});

// ═══════════════════════════════════════════════════════════════════════════════
// CARTÕES — testes detalhados
// ═══════════════════════════════════════════════════════════════════════════════

test('Cartões: uso do cartao via IA — sem cartoes cadastrados', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  mockInterpretarMensagem = async () => ({
    acao: 'uso_cartao',
    cartao_nome: null,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'uso do cartão', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nenhum cartão') || texto.includes('cadastr'), 'Deve informar que nao tem cartoes');
});

test('Cartões: uso do cartao via IA — com cartoes', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCartoes', async () => [
    { id: 1, nome: 'Nubank', limite_total: 5000, dia_fechamento: 3, dia_vencimento: 10 },
  ]);
  t.mock.method(db, 'calcularUsoCartao', async () => ({ total: 1200, qtd: 8, inicioStr: '2026-02-03' }));
  t.mock.method(db, 'calcularCreditoComprometido', async () => 1500);

  mockInterpretarMensagem = async () => ({
    acao: 'uso_cartao',
    cartao_nome: null,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'uso do cartão', null);
  assertContem(resp, 'Nubank', 'Fatura', 'Limite');
});

test('Cartões: despesa no cartao identificado pela IA', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'buscarCartoesPorNome', async () => [
    { id: 1, nome: 'Nubank', limite_total: 5000, dia_fechamento: 3, dia_vencimento: 10 },
  ]);
  t.mock.method(db, 'listarCartoes', async () => [
    { id: 1, nome: 'Nubank', limite_total: 5000, dia_fechamento: 3, dia_vencimento: 10 },
  ]);

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: 200,
    descricao: 'Restaurante',
    categoria: 'Alimentação',
    data: '2026-03-16',
    status: 'pago',
    cartao_nome: 'Nubank',
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'gastei 200 no nubank restaurante', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('cartão') || texto.includes('registrad'), 'Deve registrar no cartao');
  assertContem(resp, 'Restaurante');
});

test('Cartões: despesa com cartao — sem cartao identificado pergunta qual', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCartoes', async () => [
    { id: 1, nome: 'Nubank', limite_total: 5000, dia_fechamento: 3, dia_vencimento: 10 },
    { id: 2, nome: 'Inter', limite_total: 3000, dia_fechamento: 15, dia_vencimento: 22 },
  ]);

  mockInterpretarMensagem = async () => ({
    acao: 'transacao',
    tipo: 'despesa',
    valor: 100,
    descricao: 'Mercado',
    categoria: 'Alimentação',
    data: '2026-03-16',
    status: 'pago',
    cartao_nome: null,
    parcelas: 1,
  });

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'gastei 100 no mercado', null);
  const texto = extrairTexto(resp).toLowerCase();
  // Deve perguntar se foi no cartao ou conta corrente
  assert.ok(texto.includes('nubank') || texto.includes('inter') || texto.includes('cartão') || texto.includes('conta'), 'Deve perguntar qual cartao');
});

test('Cartões: editar cartao — sem cartoes cadastrados', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'editar cartão', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nenhum') || texto.includes('cadastr'), 'Deve informar sem cartoes');
});

test('Cartões: editar cartao — com cartoes lista opcoes', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCartoes', async () => [
    { id: 1, nome: 'Nubank', limite_total: 5000, dia_fechamento: 3, dia_vencimento: 10 },
    { id: 2, nome: 'Inter', limite_total: 3000, dia_fechamento: 15, dia_vencimento: 22 },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'editar cartão', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nubank') || texto.includes('inter') || texto.includes('qual'), 'Deve listar cartoes');
});

// ═══════════════════════════════════════════════════════════════════════════════
// CAIXINHAS — testes detalhados
// ═══════════════════════════════════════════════════════════════════════════════

test('Caixinhas: "caixinhas" sem nenhuma cadastrada', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'caixinhas', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('não tem') || texto.includes('nenhum') || texto.includes('cadastrad'), 'Deve informar sem caixinhas');
});

test('Caixinhas: "caixinhas" com itens exibe lista e total', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCaixinhas', async () => [
    { id: 1, nome: 'Emergência', saldo: 5000, meta: 10000, tipo: 'Poupança', rendimento_mensal: 0.5 },
    { id: 2, nome: 'Viagem', saldo: 2000, meta: 8000, tipo: 'CDB', rendimento_mensal: 1.2 },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'caixinhas', null);
  assertContem(resp, 'Emergência', 'Viagem', 'Total reservado');
  assert.ok(resp.includes('7.000') || resp.includes('7000'), 'Total deve ser 7000');
});

test('Investimentos: "investimentos" consulta as posicoes do banco, nao as reservas manuais', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  // Regressão do bug que motivou o rename: antes, "investimentos" caía em
  // handleListarCaixinhas e respondia com as reservas manuais — ou seja, R$ 0
  // para quem tinha milhares aplicados no banco.
  t.mock.method(db, 'listarCaixinhas', async () => [
    { id: 1, nome: 'Poupanca Manual', saldo: 3000, meta: null, tipo: 'Tesouro', rendimento_mensal: null },
  ]);
  t.mock.method(db, 'resumoInvestimentos', async () => ({
    total: 8000, totalAplicado: 7000, totalLucro: 1000, quantidade: 2,
    porTipo: [{ tipo: 'FIXED_INCOME', total: 8000, quantidade: 2 }],
    porEmissor: [{ emissor: 'Banco Exemplo', total: 8000, quantidade: 2 }],
  }));

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'investimentos', null);

  assertContem(resp, 'investimentos', 'Banco Exemplo');
  assert.ok(!resp.includes('Poupanca Manual'), 'nao pode cair na lista de reservas manuais');
});

test('Reservas: "reservas" e "caixinhas" sao sinonimos (vocabulario antigo nao quebra)', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCaixinhas', async () => [
    { id: 1, nome: 'Emergencia', saldo: 3000, meta: null, tipo: null, rendimento_mensal: null },
  ]);

  const uid = novoUsuario();
  assertContem(await handleMessage(uid, 'reservas', null), 'Emergencia', 'Total reservado');
  assertContem(await handleMessage(uid, 'caixinhas', null), 'Emergencia', 'Total reservado');
});

test('Caixinhas: exibe meta quando definida', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCaixinhas', async () => [
    { id: 1, nome: 'Carro Novo', saldo: 15000, meta: 50000, tipo: 'CDB', rendimento_mensal: 1.0 },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'caixinhas', null);
  assertContem(resp, 'Carro Novo', 'Meta');
});

test('Caixinhas: exibe tipo e rendimento quando definidos', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'listarCaixinhas', async () => [
    { id: 1, nome: 'CDB Banco', saldo: 10000, meta: null, tipo: 'CDB', rendimento_mensal: 1.5 },
  ]);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'caixinhas', null);
  assertContem(resp, 'CDB', '1.5%');
});

test('Caixinhas: editar caixinha sem nenhuma cadastrada', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  t.mock.method(db, 'buscarCaixinhasPorNome', async () => []);

  const uid = novoUsuario();
  const resp = await handleMessage(uid, 'editar caixinha', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('nenhum') || texto.includes('não') || texto.includes('cadastr'), 'Deve informar sem caixinhas');
});

// ═══════════════════════════════════════════════════════════════════════════════
// ONBOARDING — testes adicionais
// ═══════════════════════════════════════════════════════════════════════════════

test('Onboarding: confirmacao aceita variantes — "beleza"', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'beleza', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('organizar') || texto.includes('dia a dia'), 'Deve aceitar "beleza" como confirmacao');
});

test('Onboarding: confirmacao aceita variantes — "show"', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'show', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('organizar') || texto.includes('dia a dia'), 'Deve aceitar "show" como confirmacao');
});

test('Onboarding: confirmacao aceita variantes — "perfeito"', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'confirmando_nome');

  const resp = await handleMessage(uid, 'perfeito', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('organizar') || texto.includes('dia a dia'), 'Deve aceitar "perfeito" como confirmacao');
});

test('Onboarding: aguardando_inicio aceita "organizar agora" por extenso', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, 'organizar agora', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('disponível') || texto.includes('conta') || texto.includes('finan'), 'Deve iniciar Financas em Dia');
});

test('Onboarding: aguardando_inicio aceita "dia a dia" por extenso', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_inicio');

  const resp = await handleMessage(uid, 'dia a dia', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('gastei') || texto.includes('simples') || texto.includes('registr'), 'Deve dar instrucoes de uso');
});

test('Onboarding: trocando_nome_from_inicio retorna as opcoes de inicio', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();
  mockExtrairNomeOnboarding = async () => 'Lucas';

  const uid = novoUsuario();
  setOnboardingState(uid, 'trocando_nome_from_inicio');

  const resp = await handleMessage(uid, 'Lucas', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('lucas'), 'Deve conter o novo nome');
  assert.ok(texto.includes('organizar') || texto.includes('dia a dia'), 'Deve retornar opcoes de inicio');
});

test('Onboarding: "meu nome" sem nome na mensagem pede nome', async (t) => {
  aplicarMocksPadraoDB(t);
  resetarMocksAI();

  const uid = novoUsuario();
  // Fora do onboarding — usuario normal

  const resp = await handleMessage(uid, 'quero trocar meu nome', null);
  const texto = extrairTexto(resp).toLowerCase();
  assert.ok(texto.includes('como') || texto.includes('chamar') || texto.includes('nome'), 'Deve pedir novo nome');
});

test('Onboarding completo: nome → confirma → organizar agora inicia ponto zero', async (t) => {
  aplicarMocksPadraoDB(t);
  aplicarMocksPadraoPagamento(t);
  resetarMocksAI();

  const uid = novoUsuario();
  setOnboardingState(uid, 'aguardando_nome');

  // Turn 1: nome
  mockExtrairNomeOnboarding = async () => 'Rafael';
  const r1 = await handleMessage(uid, 'Rafael', null);
  assertContem(r1, 'Rafael');

  // Turn 2: confirma
  const r2 = await handleMessage(uid, 'sim', null);
  assert.ok(Array.isArray(r2), 'Deve retornar array de opcoes');

  // Turn 3: organizar agora
  const r3 = await handleMessage(uid, 'organizar agora', null);
  const texto3 = extrairTexto(r3).toLowerCase();
  assert.ok(texto3.includes('disponível') || texto3.includes('conta') || texto3.includes('finan'), 'Deve iniciar ponto zero');
});
