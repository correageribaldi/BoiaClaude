// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'k'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Decisão do Federico (substitui a anterior "nunca criar subcategoria nova a
// partir do nome da Pluggy"): sem match nas subcategorias do usuário, cria
// uma nova, vinculada à categoria principal certa — em vez de cair sempre no
// genérico "Outros"/"Outras Receitas".

// ── garantirCategoriaPrincipal ──────────────────────────────────────────────────

test('garantirCategoriaPrincipal: já existe (ativa) não faz nada', async (t) => {
  let fezInsert = false;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [{ id: 5 }] };
    if (sql.includes('INSERT INTO categorias_principais')) { fezInsert = true; }
    return { rows: [] };
  });

  await db.garantirCategoriaPrincipal('user1@c.us', 'Variáveis', 'despesa');
  assert.equal(fezInsert, false);
});

test('garantirCategoriaPrincipal: não existe, cria com percentual/ordem padrão de CATEGORIAS_PRINCIPAIS_PADRAO', async (t) => {
  let paramsInsert = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [] };
    if (sql.includes('INSERT INTO categorias_principais')) { paramsInsert = params; return { rows: [] }; }
    return { rows: [] };
  });

  await db.garantirCategoriaPrincipal('user1@c.us', 'Investimentos', 'despesa');

  // CATEGORIAS_PRINCIPAIS_PADRAO: Investimentos = { percentual: 15, ordem: 4 }
  assert.deepEqual(paramsInsert, ['user1@c.us', 'Investimentos', 15, 4, 'despesa']);
});

test('garantirCategoriaPrincipal: "Receitas" usa tipo="receita" explícito (não o default "despesa" do schema)', async (t) => {
  let paramsInsert = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [] };
    if (sql.includes('INSERT INTO categorias_principais')) { paramsInsert = params; return { rows: [] }; }
    return { rows: [] };
  });

  await db.garantirCategoriaPrincipal('user1@c.us', 'Receitas', 'receita');

  assert.equal(paramsInsert[4], 'receita');
  assert.equal(paramsInsert[1], 'Receitas');
});

test('garantirCategoriaPrincipal: nome fora da lista padrão usa percentual 0 / ordem 99 (não quebra)', async (t) => {
  let paramsInsert = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [] };
    if (sql.includes('INSERT INTO categorias_principais')) { paramsInsert = params; return { rows: [] }; }
    return { rows: [] };
  });

  await db.garantirCategoriaPrincipal('user1@c.us', 'Categoria Nome Estranho', 'despesa');
  assert.deepEqual(paramsInsert, ['user1@c.us', 'Categoria Nome Estranho', 0, 99, 'despesa']);
});

// ── resolverCategoriaPluggy — auto-criação de subcategoria ──────────────────────

test('resolverCategoriaPluggy: sem match e com categoriaPrincipalDestino cria subcategoria vinculada (grupo Variáveis)', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];

  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT categoria FROM limites_categoria')) return { rows: [] }; // sem match
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [{ id: 1 }] }; // já existe
    if (sql.includes('SELECT valor_limite::float FROM limites_categoria')) return { rows: [{ valor_limite: 500 }] };
    if (sql.includes('SELECT COALESCE(SUM(valor_limite)')) return { rows: [{ total: 100 }] };
    if (sql.includes('INSERT INTO limites_categoria')) return { rows: [] };
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Supermercado', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Supermercado', 'deve retornar o nome traduzido da Pluggy, recém-criado como subcategoria');

  const insertSubcategoria = queries.find((q) => q.sql.includes('INSERT INTO limites_categoria'));
  assert.ok(insertSubcategoria, 'deveria ter criado a subcategoria');
  assert.equal(insertSubcategoria.params[1], 'Supermercado');
  assert.equal(insertSubcategoria.params[3], 'Variáveis');
});

test('resolverCategoriaPluggy: sem match e SEM categoriaPrincipalDestino (transferência) NÃO cria subcategoria, cai no genérico', async (t) => {
  mockResolverIdentidade(t);
  let tentouCriar = false;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SELECT categoria FROM limites_categoria')) return { rows: [] }; // sem match
    if (sql.includes('INSERT INTO limites_categoria') || sql.includes('INSERT INTO categorias_principais')) {
      tentouCriar = true;
    }
    return { rows: [] };
  });

  // categoriaPrincipalDestino null (ou omitido) -- simula grupo 04/05 (transferência)
  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Transferências', 'despesa', null);

  assert.equal(categoria, 'Outros', 'transferência cai no genérico, não cria subcategoria de "gasto"');
  assert.equal(tentouCriar, false);
});

test('resolverCategoriaPluggy: categoria já existente no usuário é reutilizada, não duplica', async (t) => {
  mockResolverIdentidade(t);
  let tentouCriar = false;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SELECT categoria FROM limites_categoria')) {
      return { rows: [{ categoria: 'Supermercado' }] }; // 1 match único
    }
    if (sql.includes('INSERT INTO limites_categoria') || sql.includes('INSERT INTO categorias_principais')) {
      tentouCriar = true;
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Supermercado', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Supermercado');
  assert.equal(tentouCriar, false, 'não deveria criar nada quando já existe 1 match único');
});

test('resolverCategoriaPluggy: categoryId desconhecido (sem tradução, sem categoriaPrincipalDestino) cai no genérico', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  // Mesmo comportamento de antes desta mudança: sem categoria (null) cai
  // direto no fallback, sem sequer consultar o banco.
  const categoria = await db.resolverCategoriaPluggy('user1@c.us', null, 'receita');
  assert.equal(categoria, 'Outras Receitas');
});

test('resolverCategoriaPluggy: auto-criação em grupo "Investimentos" (segundo grupo, cobertura adicional)', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];

  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT categoria FROM limites_categoria')) return { rows: [] };
    if (sql.includes('SELECT id FROM categorias_principais')) return { rows: [] }; // não existe -- precisa criar
    if (sql.includes('INSERT INTO categorias_principais')) return { rows: [] };
    if (sql.includes('SELECT valor_limite::float FROM limites_categoria')) return { rows: [] };
    if (sql.includes('SELECT COALESCE(SUM(valor_limite)')) return { rows: [{ total: 0 }] };
    if (sql.includes('INSERT INTO limites_categoria')) return { rows: [] };
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'Ações e fundos', 'despesa', 'Investimentos');

  assert.equal(categoria, 'Ações e fundos');
  const insertPrincipal = queries.find((q) => q.sql.includes('INSERT INTO categorias_principais'));
  assert.ok(insertPrincipal, 'categoria principal "Investimentos" deveria ter sido criada (não existia para o usuário)');
  assert.equal(insertPrincipal.params[1], 'Investimentos');
});

test('resolverCategoriaPluggy: múltiplos matches fuzzy SEM nenhum match exato (ambíguo) ainda cai no fallback genérico, mesmo com categoriaPrincipalDestino', async (t) => {
  mockResolverIdentidade(t);
  let tentouCriar = false;

  // Nenhuma das duas contém exatamente "mercado" quando normalizada — "Mercado
  // Livre" e "Hipermercado" batem no ILIKE '%mercado%', mas nenhuma é ===
  // "mercado". Genuinamente ambíguo, diferente do caso "Compras"/"Compras
  // online" (esse resolve por match exato, ver database-categoria-match-exato).
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SELECT categoria FROM limites_categoria')) {
      return { rows: [{ categoria: 'Mercado Livre' }, { categoria: 'Hipermercado' }] };
    }
    if (sql.includes('INSERT INTO limites_categoria') || sql.includes('INSERT INTO categorias_principais')) {
      tentouCriar = true;
    }
    return { rows: [] };
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', 'mercado', 'despesa', 'Variáveis');

  assert.equal(categoria, 'Outros');
  assert.equal(tentouCriar, false, 'ambiguidade não deveria criar subcategoria nova');
});
