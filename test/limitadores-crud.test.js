// CRUD de limitadores: validação de payload, a regra "uma categoria, um
// limitador" e o que acontece com as categorias quando o limitador é excluído.
//
// salvarLimitador roda em transação (pool.connect), então aqui o mock é do
// client, não do pool.query — é o único jeito de verificar que um erro no meio
// da gravação faz ROLLBACK em vez de deixar o limitador com nome novo e
// categorias antigas.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'd'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// conflitos: linhas devolvidas pela checagem de categoria já usada.
// respostas: função opcional que intercepta as queries DENTRO da transação.
function mockTransacao(t, { conflitos = [], respostaClient = null } = {}) {
  const foraDaTransacao = [];
  const naTransacao = [];

  t.mock.method(db.pool, 'query', async (sql, params) => {
    foraDaTransacao.push({ sql, params });
    if (sql.includes('FROM limitador_categorias')) return { rows: conflitos };
    return { rows: [], rowCount: 0 };
  });

  t.mock.method(db.pool, 'connect', async () => ({
    query: async (sql, params) => {
      naTransacao.push({ sql, params });
      if (respostaClient) {
        const r = await respostaClient(sql, params);
        if (r) return r;
      }
      if (sql.startsWith('INSERT INTO limitadores')) return { rows: [{ id: 42 }], rowCount: 1 };
      if (sql.startsWith('UPDATE limitadores')) return { rows: [{ id: Number(params[1]) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  }));

  return { foraDaTransacao, naTransacao };
}

// ── Validação de payload ─────────────────────────────────────────────────────

test('salvarLimitador: recusa nome vazio, grupo vazio e teto zerado', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t);

  assert.equal(
    (await db.salvarLimitador('u1@c.us', { nome: '  ', categorias: ['Supermercado'], valor_semanal: 500 })).erro,
    'nome_obrigatorio'
  );
  assert.equal(
    (await db.salvarLimitador('u1@c.us', { nome: 'Mercado', categorias: [], valor_semanal: 500 })).erro,
    'sem_categorias'
  );
  // Limitador sem nenhum teto não controla nada — só ocuparia as categorias,
  // impedindo que entrassem num limitador de verdade.
  assert.equal(
    (await db.salvarLimitador('u1@c.us', { nome: 'Mercado', categorias: ['Supermercado'], valor_semanal: 0, valor_mensal: null })).erro,
    'sem_teto'
  );
  assert.equal(naTransacao.length, 0, 'payload inválido não abre transação');
});

test('salvarLimitador: teto ausente, 0, vazio ou negativo viram NULL (não controlo essa janela)', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t);

  await db.salvarLimitador('u1@c.us', {
    nome: 'Mercado', categorias: ['Supermercado'], valor_semanal: 500, valor_mensal: -30,
  });

  const insert = naTransacao.find((c) => c.sql.startsWith('INSERT INTO limitadores'));
  assert.equal(insert.params[2], 500);
  assert.equal(insert.params[3], null, 'valor negativo não vira teto negativo — vira ausência de teto');
});

test('salvarLimitador: categorias repetidas no payload entram uma vez só', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t);

  const r = await db.salvarLimitador('u1@c.us', {
    nome: 'Mercado',
    categorias: ['Supermercado', ' Supermercado ', 'Compras', ''],
    valor_semanal: 500,
  });

  assert.deepEqual(r.categorias, ['Supermercado', 'Compras']);
  const insertCats = naTransacao.find((c) => c.sql.includes('INSERT INTO limitador_categorias'));
  assert.deepEqual(insertCats.params[2], ['Supermercado', 'Compras']);
});

// ── Uma categoria, um limitador ──────────────────────────────────────────────

test('salvarLimitador: categoria já usada por OUTRO limitador é recusada, dizendo onde está', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t, {
    conflitos: [{ categoria: 'Supermercado', limitador: 'Mercado' }],
  });

  const r = await db.salvarLimitador('u1@c.us', {
    nome: 'Essenciais', categorias: ['Supermercado'], valor_mensal: 900,
  });

  assert.equal(r.ok, false);
  assert.equal(r.erro, 'categoria_em_uso');
  assert.deepEqual(r.conflitos, [{ categoria: 'Supermercado', limitador: 'Mercado' }]);
  assert.equal(naTransacao.length, 0, 'conflito é detectado antes de abrir a transação');
});

test('salvarLimitador: editar o PRÓPRIO limitador não conflita com ele mesmo', async (t) => {
  mockResolverIdentidade(t);
  const { foraDaTransacao } = mockTransacao(t);

  await db.salvarLimitador('u1@c.us', {
    id: 7, nome: 'Mercado', categorias: ['Supermercado'], valor_semanal: 500,
  });

  const checagem = foraDaTransacao.find((c) => c.sql.includes('FROM limitador_categorias'));
  assert.match(checagem.sql, /\$3::int IS NULL OR lc\.limitador_id <> \$3/);
  assert.equal(checagem.params[2], 7, 'o próprio id é excluído da busca por conflito');
});

test('salvarLimitador: nome duplicado (violação do índice único) vira erro tratado', async (t) => {
  mockResolverIdentidade(t);
  mockTransacao(t, {
    respostaClient: async (sql) => {
      if (sql.startsWith('INSERT INTO limitadores')) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      return null;
    },
  });

  const r = await db.salvarLimitador('u1@c.us', {
    nome: 'Mercado', categorias: ['Supermercado'], valor_semanal: 500,
  });
  assert.deepEqual(r, { ok: false, erro: 'nome_duplicado' });
});

// ── Transação ────────────────────────────────────────────────────────────────

test('salvarLimitador: substitui o grupo inteiro dentro de uma transação', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t);

  await db.salvarLimitador('u1@c.us', {
    id: 7, nome: 'Mercado', categorias: ['Supermercado', 'Compras'], valor_semanal: 500, valor_mensal: 2000,
  });

  const sqls = naTransacao.map((c) => c.sql);
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT');
  // DELETE + INSERT, e não diff item a item: "o que está na tela é o que fica
  // gravado" é mais fácil de garantir do que reconciliar duas listas.
  assert.ok(sqls.some((s) => s.startsWith('DELETE FROM limitador_categorias')));
  assert.ok(sqls.some((s) => s.includes('INSERT INTO limitador_categorias')));
});

test('salvarLimitador: erro no meio da gravação faz ROLLBACK', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t, {
    respostaClient: async (sql) => {
      if (sql.includes('INSERT INTO limitador_categorias')) throw new Error('deadlock detected');
      return null;
    },
  });

  await assert.rejects(
    () => db.salvarLimitador('u1@c.us', { nome: 'Mercado', categorias: ['Supermercado'], valor_semanal: 500 }),
    /deadlock detected/
  );
  assert.ok(
    naTransacao.some((c) => c.sql === 'ROLLBACK'),
    'sem rollback o limitador ficaria com o nome novo e o grupo vazio'
  );
});

test('salvarLimitador: id inexistente não cria limitador novo por engano', async (t) => {
  mockResolverIdentidade(t);
  const { naTransacao } = mockTransacao(t, {
    respostaClient: async (sql) => (sql.startsWith('UPDATE limitadores') ? { rows: [], rowCount: 0 } : null),
  });

  const r = await db.salvarLimitador('u1@c.us', {
    id: 999, nome: 'Fantasma', categorias: ['Supermercado'], valor_mensal: 100,
  });

  assert.deepEqual(r, { ok: false, erro: 'nao_encontrado' });
  assert.ok(naTransacao.some((c) => c.sql === 'ROLLBACK'));
});

// ── Exclusão ─────────────────────────────────────────────────────────────────

test('excluirLimitador: desativa e SOLTA as categorias do grupo', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });
    if (sql.includes('UPDATE limitadores')) return { rows: [{ nome: 'Mercado' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  assert.equal(await db.excluirLimitador('u1@c.us', 7), 'Mercado');

  // Sem o DELETE, as categorias continuariam presas ao índice único e o usuário
  // não conseguiria usá-las em outro limitador: um limitador excluído seguiria
  // mandando no sistema.
  assert.ok(chamadas.some((c) => c.sql.startsWith('DELETE FROM limitador_categorias')));
});

test('excluirLimitador: limitador de outro usuário não é removido nem solta categorias', async (t) => {
  mockResolverIdentidade(t);
  const chamadas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });

  assert.equal(await db.excluirLimitador('u1@c.us', 7), null);
  assert.ok(
    !chamadas.some((c) => c.sql.startsWith('DELETE FROM limitador_categorias')),
    'nada é deletado quando o UPDATE não achou linha do usuário'
  );
});

// ── Busca por nome ───────────────────────────────────────────────────────────

test('buscarLimitadorPorNome: ignora caixa e acento ("mercado" acha "Mercado")', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limitadores')) {
      return {
        rows: [
          { id: 7, nome: 'Mercado', valor_semanal: 500, valor_mensal: null },
          { id: 3, nome: 'Combustível', valor_semanal: 75, valor_mensal: null },
        ],
      };
    }
    return { rows: [{ limitador_id: 7, categoria: 'Supermercado' }] };
  });

  assert.equal((await db.buscarLimitadorPorNome('u1@c.us', 'mercado')).id, 7);
  // Sem acento na consulta ainda tem que achar "Combustível": é como o usuário
  // digita no WhatsApp.
  assert.equal((await db.buscarLimitadorPorNome('u1@c.us', 'COMBUSTIVEL')).id, 3);
  assert.equal(await db.buscarLimitadorPorNome('u1@c.us', 'Viagem'), null);
  assert.equal(await db.buscarLimitadorPorNome('u1@c.us', ''), null);
});

test('listarLimitadores: agrupa as categorias sem virar N+1', async (t) => {
  mockResolverIdentidade(t);
  let queries = 0;
  t.mock.method(db.pool, 'query', async (sql) => {
    queries++;
    if (sql.includes('FROM limitadores')) {
      return { rows: [{ id: 7, nome: 'Mercado', valor_semanal: 500, valor_mensal: null }] };
    }
    return {
      rows: [
        { limitador_id: 7, categoria: 'Supermercado' },
        { limitador_id: 7, categoria: 'Compras' },
      ],
    };
  });

  const lista = await db.listarLimitadores('u1@c.us');

  assert.equal(queries, 2, 'duas queries no total, não uma por limitador');
  assert.deepEqual(lista[0].categorias, ['Supermercado', 'Compras']);
});
