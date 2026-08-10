// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

// Regressão do bug: agente respondia "Total de Despesas Pagas: R$ 2.016,34"
// quando o total real do mês era R$ 12.143,21 (35 despesas pagas), porque a
// IA escolheu consultar_transacoes (lista paginada, limite default 20) e
// somou manualmente só os itens recebidos na página.
//
// Correção: consultar_transacoes agora retorna, junto da página, o agregado
// REAL do período inteiro (totalGeral/quantidadeTotal) e sinaliza truncamento,
// para que a IA nunca precise (e nunca tenha motivo para) somar a lista.

const db = require('../src/database');
const agente = require('../src/agente-financeiro');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

function gerarPagina(qtd) {
  return Array.from({ length: qtd }, (_, i) => ({
    numero_usuario: i + 1,
    tipo: 'despesa',
    valor: 100,
    descricao: `Item ${i + 1}`,
    categoria: 'Geral',
    data: '2026-08-05',
    status: 'pago',
  }));
}

test('consultar_transacoes: limite default é 20 quando args.limite não é informado', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = [];
  t.mock.method(db, 'consultarTransacoes', async (usuarioId, filtros) => {
    chamadas.push(filtros);
    return gerarPagina(20);
  });
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: 2000, quantidade: 20 }));

  await agente.executeTool('userLimite@c.us', 'consultar_transacoes', { tipo: 'despesa' });

  assert.equal(chamadas[0].limite, 20);
});

test('consultar_transacoes: sinaliza truncamento e retorna totalGeral real do período (não soma da página)', async (t) => {
  mockResolverIdentidade(t);
  // Página limitada a 20 itens de R$ 100 (soma da página = 2.000)
  t.mock.method(db, 'consultarTransacoes', async () => gerarPagina(20));
  // Mas o período tem 35 despesas somando R$ 12.143,21 (valor real confirmado via resumoMensal)
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: 12143.21, quantidade: 35 }));

  const result = await agente.executeTool('user1@c.us', 'consultar_transacoes', {
    tipo: 'despesa', dataInicio: '2026-08-01', dataFim: '2026-08-31',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.length, 20);
  assert.equal(result.exibindo, 20);
  assert.equal(result.quantidadeTotal, 35);
  assert.equal(result.truncado, true);
  // O total agregado é o do PERÍODO INTEIRO, não a soma da página (que seria 2000)
  assert.equal(result.totalGeral, 12143.21);
  assert.notEqual(result.totalGeral, 2016.34);
  assert.ok(result.aviso.toLowerCase().includes('nunca'));
});

test('consultar_transacoes: sem truncamento quando a lista cobre todo o período', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'consultarTransacoes', async () => gerarPagina(5));
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: 500, quantidade: 5 }));

  const result = await agente.executeTool('user2@c.us', 'consultar_transacoes', { tipo: 'despesa' });

  assert.equal(result.truncado, false);
  assert.equal(result.totalGeral, 500);
  assert.equal(result.quantidadeTotal, 5);
});

test('consultar_transacoes: lista vazia retorna totalGeral 0 e truncado false', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db, 'consultarTransacoes', async () => []);
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: 0, quantidade: 0 }));

  const result = await agente.executeTool('user3@c.us', 'consultar_transacoes', {});

  assert.equal(result.data.length, 0);
  assert.equal(result.totalGeral, 0);
  assert.equal(result.truncado, false);
});

test('consultar_transacoes: totalGeral bate com o total de resumo_mensal para o mesmo período', async (t) => {
  mockResolverIdentidade(t);
  const TOTAL_REAL_DO_MES = 12143.21;
  const QUANTIDADE_REAL = 35;

  t.mock.method(db, 'consultarTransacoes', async () => gerarPagina(20));
  t.mock.method(db, 'consultarTotalTransacoes', async () => ({ total: TOTAL_REAL_DO_MES, quantidade: QUANTIDADE_REAL }));
  t.mock.method(db, 'resumoMensal', async () => ({
    totais: [{ tipo: 'despesa', status: 'pago', total: TOTAL_REAL_DO_MES, quantidade: QUANTIDADE_REAL }],
  }));

  const resultLista = await agente.executeTool('user4@c.us', 'consultar_transacoes', {
    tipo: 'despesa', dataInicio: '2026-08-01', dataFim: '2026-08-31',
  });
  const resultResumo = await agente.executeTool('user4@c.us', 'resumo_mensal', { mes: 8, ano: 2026 });

  const totalDoResumo = resultResumo.data.totais.find(x => x.tipo === 'despesa' && x.status === 'pago').total;

  assert.equal(resultLista.totalGeral, totalDoResumo);
  assert.equal(resultLista.quantidadeTotal, QUANTIDADE_REAL);
});
