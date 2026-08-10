// Criação de limitador pelo WhatsApp.
//
// "limitar gastos com mercado em 500 por semana" tem que continuar funcionando
// em linguagem natural. A diferença do modelo antigo: o valor não basta — é
// preciso saber QUAIS subcategorias entram no grupo. Os três caminhos testados
// aqui, do menos ao mais trabalhoso para o usuário:
//
//   1. limitador já existe → só atualiza o teto, preservando o grupo;
//   2. nome conhecido (sugestão pronta ou subcategoria homônima) → propõe e
//      pede um "sim";
//   3. nada bate → lista numerada e o usuário responde os números.

// ── Setup: env ANTES de carregar módulos ─────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.OPENAI_API_KEY = 'sk-mock';
process.env.BRAVE_SEARCH_API_KEY = 'mock';
process.env.SERPER_API_KEY = 'mock';

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const handlers = require('../src/handlers');

// As 41 subcategorias reais são desse feitio: taxonomia da Pluggy, que não
// coincide com o vocabulário do usuário ("Mercado" não existe como categoria).
const SUBCATEGORIAS = [
  'Supermercado',
  'Compras',
  'Alimentos e bebidas',
  'Postos de gasolina',
  'Restaurantes, bares e lanchonetes',
  'Delivery de alimentos',
  'Serviços digitais',
  'Farmácia',
  'Apostas',
];

function mockBase(t, { limitadores = [] } = {}) {
  const salvos = [];
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
  t.mock.method(db, 'listarSubcategoriasPorTipo', async () => SUBCATEGORIAS);
  t.mock.method(db, 'listarLimitadores', async () => limitadores);
  t.mock.method(db, 'buscarLimitadorPorNome', async (_uid, nome) => {
    const alvo = (nome || '').trim().toLowerCase();
    return limitadores.find((l) => l.nome.toLowerCase() === alvo) || null;
  });
  t.mock.method(db, 'salvarLimitador', async (_uid, dados) => {
    salvos.push(dados);
    return {
      ok: true,
      id: dados.id || 99,
      nome: dados.nome,
      valor_semanal: dados.valor_semanal ?? null,
      valor_mensal: dados.valor_mensal ?? null,
      categorias: dados.categorias,
    };
  });
  return salvos;
}

// ── (1) Limitador já existe ──────────────────────────────────────────────────

test('limitador existente: atualiza só o teto da janela pedida, preservando grupo e o outro teto', async (t) => {
  const salvos = mockBase(t, {
    limitadores: [{
      id: 7, nome: 'Mercado', valor_semanal: 400, valor_mensal: 1800,
      categorias: ['Supermercado', 'Compras'],
    }],
  });

  const msg = await handlers.handleDefinirLimite('u1@c.us', {
    categoria: 'mercado', valor: 500, periodo: 'semana',
  });

  assert.equal(salvos.length, 1);
  assert.deepEqual(salvos[0].categorias, ['Supermercado', 'Compras'], 'não pode reinventar o grupo');
  assert.equal(salvos[0].valor_semanal, 500);
  assert.equal(salvos[0].valor_mensal, 1800, 'o teto da outra janela fica intacto');
  assert.equal(salvos[0].id, 7, 'atualiza, não cria um segundo "Mercado"');
  assert.match(msg, /Mercado/);
});

test('limitador existente sem periodo: mexe no teto MENSAL', async (t) => {
  const salvos = mockBase(t, {
    limitadores: [{ id: 7, nome: 'Mercado', valor_semanal: 400, valor_mensal: null, categorias: ['Supermercado'] }],
  });

  await handlers.handleDefinirLimite('u1@c.us', { categoria: 'Mercado', valor: 2000 });

  assert.equal(salvos[0].valor_mensal, 2000);
  assert.equal(salvos[0].valor_semanal, 400);
});

// ── (2) Nome conhecido: propõe o agrupamento ─────────────────────────────────

test('nome com sugestão pronta: propõe o grupo e só grava depois do "sim"', async (t) => {
  const salvos = mockBase(t);

  const pergunta = await handlers.handleDefinirLimite('u2@c.us', {
    categoria: 'Mercado', valor: 500, periodo: 'semana',
  });

  assert.match(pergunta, /Supermercado/);
  assert.match(pergunta, /Alimentos e bebidas/);
  assert.equal(salvos.length, 0, 'sugestão não grava sozinha');

  const pendente = handlers.obterEditarLimitePendente('u2@c.us');
  const confirmacao = await handlers.handleEditarLimitePendente('u2@c.us', 'sim', pendente);

  assert.equal(salvos.length, 1);
  assert.deepEqual(salvos[0].categorias, ['Supermercado', 'Alimentos e bebidas']);
  assert.equal(salvos[0].valor_semanal, 500);
  assert.match(confirmacao, /Mercado/);
});

test('sugestão só propõe categorias que o usuário REALMENTE tem', async (t) => {
  mockBase(t);
  t.mock.method(db, 'listarSubcategoriasPorTipo', async () => ['Supermercado', 'Apostas']);

  const pergunta = await handlers.handleDefinirLimite('u3@c.us', { categoria: 'mercado', valor: 500 });

  assert.match(pergunta, /Supermercado/);
  assert.ok(
    !pergunta.includes('Alimentos e bebidas'),
    'propor categoria inexistente criaria um grupo que nunca soma nada'
  );
});

test('nome igual a uma subcategoria existente vira grupo de um item', async (t) => {
  const salvos = mockBase(t);

  await handlers.handleDefinirLimite('u4@c.us', { categoria: 'Apostas', valor: 100 });
  const pendente = handlers.obterEditarLimitePendente('u4@c.us');
  await handlers.handleEditarLimitePendente('u4@c.us', 'sim', pendente);

  assert.deepEqual(salvos[0].categorias, ['Apostas']);
});

test('"escolher" na proposta abre a lista numerada em vez de gravar', async (t) => {
  const salvos = mockBase(t);

  await handlers.handleDefinirLimite('u5@c.us', { categoria: 'Mercado', valor: 500 });
  const lista = await handlers.handleEditarLimitePendente(
    'u5@c.us', 'escolher', handlers.obterEditarLimitePendente('u5@c.us')
  );

  assert.match(lista, /1\. Supermercado/);
  assert.match(lista, /9\. Apostas/);
  assert.equal(salvos.length, 0);

  const ok = await handlers.handleEditarLimitePendente(
    'u5@c.us', '1, 2', handlers.obterEditarLimitePendente('u5@c.us')
  );
  assert.deepEqual(salvos[0].categorias, ['Supermercado', 'Compras']);
  assert.match(ok, /Mercado/);
});

// ── (3) Nome novo: lista numerada ────────────────────────────────────────────

test('nome desconhecido: pergunta quais categorias, sem gravar nada antes', async (t) => {
  const salvos = mockBase(t);

  const pergunta = await handlers.handleDefinirLimite('u6@c.us', {
    categoria: 'Rolê', valor: 300, periodo: 'semana',
  });

  assert.match(pergunta, /Rolê/);
  assert.match(pergunta, /números/);
  assert.equal(salvos.length, 0);

  const resposta = await handlers.handleEditarLimitePendente(
    'u6@c.us', '5, 6', handlers.obterEditarLimitePendente('u6@c.us')
  );

  assert.deepEqual(salvos[0].categorias, ['Restaurantes, bares e lanchonetes', 'Delivery de alimentos']);
  assert.equal(salvos[0].valor_semanal, 300);
  assert.match(resposta, /Rolê/);
});

test('números fora da lista não gravam um grupo diferente do pedido', async (t) => {
  const salvos = mockBase(t);

  await handlers.handleDefinirLimite('u7@c.us', { categoria: 'Rolê', valor: 300 });
  const erro = await handlers.handleEditarLimitePendente(
    'u7@c.us', '2, 47', handlers.obterEditarLimitePendente('u7@c.us')
  );

  assert.match(erro, /números/);
  assert.equal(salvos.length, 0, 'índice inválido derruba a resposta inteira, não é ignorado em silêncio');
  assert.ok(handlers.obterEditarLimitePendente('u7@c.us'), 'o fluxo continua aberto para nova tentativa');
});

test('números repetidos entram uma vez só', async (t) => {
  const salvos = mockBase(t);

  await handlers.handleDefinirLimite('u8@c.us', { categoria: 'Rolê', valor: 300 });
  await handlers.handleEditarLimitePendente(
    'u8@c.us', '5, 5, 6', handlers.obterEditarLimitePendente('u8@c.us')
  );

  assert.deepEqual(salvos[0].categorias, ['Restaurantes, bares e lanchonetes', 'Delivery de alimentos']);
});

test('"cancelar" encerra o fluxo sem gravar', async (t) => {
  const salvos = mockBase(t);

  await handlers.handleDefinirLimite('u9@c.us', { categoria: 'Rolê', valor: 300 });
  const msg = await handlers.handleEditarLimitePendente(
    'u9@c.us', 'cancelar', handlers.obterEditarLimitePendente('u9@c.us')
  );

  assert.match(msg, /Cancelado/);
  assert.equal(salvos.length, 0);
  assert.equal(handlers.obterEditarLimitePendente('u9@c.us'), null);
});

// ── Validações e erros ───────────────────────────────────────────────────────

test('valor ausente ou zerado nem abre fluxo', async (t) => {
  mockBase(t);
  assert.match(await handlers.handleDefinirLimite('u10@c.us', { categoria: 'Mercado', valor: 0 }), /❌/);
  assert.match(await handlers.handleDefinirLimite('u10@c.us', { categoria: null, valor: 500 }), /❌/);
  assert.equal(handlers.obterEditarLimitePendente('u10@c.us'), null);
});

test('categoria já usada por outro limitador: erro diz onde ela está', async (t) => {
  mockBase(t);
  t.mock.method(db, 'salvarLimitador', async () => ({
    ok: false,
    erro: 'categoria_em_uso',
    conflitos: [{ categoria: 'Supermercado', limitador: 'Mercado' }],
  }));

  await handlers.handleDefinirLimite('u11@c.us', { categoria: 'Essenciais', valor: 900 });
  const erro = await handlers.handleEditarLimitePendente(
    'u11@c.us', '1', handlers.obterEditarLimitePendente('u11@c.us')
  );

  assert.match(erro, /Supermercado/);
  assert.match(erro, /Mercado/);
});

// ── Listagem e remoção ───────────────────────────────────────────────────────

test('handleListarLimites: mostra consumo por limitador, com as categorias do grupo', async (t) => {
  mockBase(t);
  t.mock.method(db, 'listarConsumoLimitadores', async () => [{
    id: 7,
    limitador: 'Mercado',
    categorias: ['Supermercado', 'Compras'],
    semana: { limite: 500, gastos: 430, restante: 70, percentual: 86, faixa: 80 },
    mes: null,
  }]);

  const msg = await handlers.handleListarLimites('u12@c.us');

  assert.match(msg, /Mercado/);
  assert.match(msg, /Supermercado, Compras/);
  assert.match(msg, /86%/);
});

test('handleListarLimites: sem limitador nenhum, ensina a criar o primeiro', async (t) => {
  mockBase(t);
  t.mock.method(db, 'listarConsumoLimitadores', async () => []);

  const msg = await handlers.handleListarLimites('u13@c.us');
  assert.match(msg, /limitar gastos com mercado/i);
});

test('handleRemoverLimite: acha pelo nome e solta as categorias', async (t) => {
  mockBase(t, {
    limitadores: [{ id: 7, nome: 'Mercado', valor_semanal: 500, valor_mensal: null, categorias: ['Supermercado'] }],
  });
  let excluido = null;
  t.mock.method(db, 'excluirLimitador', async (_uid, id) => { excluido = id; return 'Mercado'; });

  const msg = await handlers.handleRemoverLimite('u14@c.us', { categoria: 'mercado' });

  assert.equal(excluido, 7);
  assert.match(msg, /Mercado/);
  assert.match(msg, /livres/);
});

test('handleRemoverLimite: nome que não existe não remove nada', async (t) => {
  mockBase(t);
  let chamou = false;
  t.mock.method(db, 'excluirLimitador', async () => { chamou = true; return null; });

  const msg = await handlers.handleRemoverLimite('u15@c.us', { categoria: 'Viagem' });

  assert.match(msg, /❌/);
  assert.equal(chamou, false);
});
