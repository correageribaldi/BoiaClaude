// Bug de produção (re-sync Pluggy, Marco 1, confirmado com dados reais): a
// categoria "Compras" vinda da Pluggy batia por ILIKE em DUAS subcategorias
// do usuário ao mesmo tempo — "Compras" e "Compras online" — e a regra de
// ambiguidade (>1 resultado do fuzzy) devolvia o genérico "Outros", mesmo
// havendo uma correspondência EXATA óbvia. 5 transações que estavam
// corretamente em "Compras" foram rebaixadas para "Outros" numa
// re-sincronização por causa disso.
//
// resolverCategoriaPluggyPorTaxonomia (src/database.js) agora tenta um match
// EXATO (case/acento-insensível) contra as subcategorias do usuário ANTES do
// fuzzy — ver src/database.js:4435.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'x'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// (a) Caso exato que quebrou em produção.
test('(a) categoria "Compras" com o usuário tendo "Compras" e "Compras online" resolve para "Compras", não cai em "Outros"', async (t) => {
  mockResolverIdentidade(t);
  let tentouCriar = false;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) {
      // Mesmo mock serve pra query de candidatas (match exato) e pra fuzzy —
      // no banco real ambas trariam essas duas linhas.
      return { rows: [{ categoria: 'Compras' }, { categoria: 'Compras online' }] };
    }
    if (sql.includes('INSERT INTO limites_categoria') || sql.includes('INSERT INTO categorias_principais')) {
      tentouCriar = true;
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Compras', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Compras');
  assert.equal(tentouCriar, false, 'match exato resolve sem criar nada');
});

// (b) Match exato insensível a acento/caixa.
test('(b) match exato ignora diferença de acento e caixa ("Farmacia" da Pluggy vs "Farmácia" cadastrada)', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) {
      return { rows: [{ categoria: 'Farmácia' }] };
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Farmacia', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Farmácia', 'devolve a grafia já cadastrada pelo usuário, não a vinda da Pluggy');
});

test('(b) match exato tambem funciona so por caixa, sem diferenca de acento ("SUPERMERCADO" vs "Supermercado")', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM limites_categoria')) {
      return { rows: [{ categoria: 'Supermercado' }] };
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'SUPERMERCADO', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Supermercado');
});

// (c) Sem match exato, fuzzy com 1 resultado -> comportamento atual mantido.
test('(c) sem match exato e fuzzy com 1 resultado mantém o comportamento atual', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('ILIKE')) return { rows: [{ categoria: 'Alimentação' }] }; // fuzzy: 1 match
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Alimentação' }] }; // candidatas, sem exato p/ "Aliment"
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Aliment', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Alimentação');
});

// (d) Sem match exato, fuzzy ambíguo (>1) -> segue pro fluxo de sempre
// (auto-criação quando há categoriaPrincipalDestino, senão fallback).
test('(d) sem match exato e fuzzy ambíguo (>1) segue para o fallback genérico como hoje', async (t) => {
  mockResolverIdentidade(t);
  let tentouCriar = false;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('ILIKE')) return { rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }] };
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }] };
    if (sql.includes('INSERT INTO limites_categoria') || sql.includes('INSERT INTO categorias_principais')) {
      tentouCriar = true;
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'mercado', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Outros');
  assert.equal(tentouCriar, false);
});

test('(d) sem match exato e fuzzy ambíguo (>1), sem categoriaPrincipalDestino, cai no genérico igual', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('ILIKE')) return { rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }] };
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }] };
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'mercado', 'receita', null);

  assert.equal(categoria, 'Outras Receitas');
});

// (e) Aprendizado por estabelecimento continua vencendo tudo, inclusive o
// match exato novo.
test('(e) aprendizado por estabelecimento tem prioridade sobre o match exato de categoria', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];

  t.mock.method(db.pool, 'query', async (sql) => {
    sqls.push(sql);
    if (sql.includes('FROM categoria_aprendida')) return { rows: [{ categoria: 'Padaria' }] };
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Compras' }] };
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Compras', 'despesa', 'Variáveis', 'Compra no débito|PADARIA DO BAIRRO'
  );

  assert.equal(categoria, 'Padaria');
  assert.equal(
    sqls.some((sql) => sql.includes('FROM limites_categoria')),
    false,
    'aprendizado resolve sem sequer consultar a taxonomia (nem o novo passo de match exato)'
  );
});
