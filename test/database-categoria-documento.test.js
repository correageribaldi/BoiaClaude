// Aprendizado de categoria pelo DOCUMENTO da contraparte (CPF/CNPJ hasheado).
// A chave textual erra quando o mesmo prestador aparece com descrições
// diferentes; o documento não muda. Por isso o documento tem prioridade.
//
// Nenhum documento real aparece aqui: os testes trabalham direto com hashes
// sintéticos, e os que passam por src/contraparte.js usam documentos de
// formato válido mas inventados.

// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'c'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── registrarCategoriaAprendidaDocumento ────────────────────────────────────

test('registrarCategoriaAprendidaDocumento: grava o hash recebido, em tabela própria', async (t) => {
  mockResolverIdentidade(t);
  let sql = null;
  let params = null;
  t.mock.method(db.pool, 'query', async (s, p) => { sql = s; params = p; return { rows: [] }; });

  const r = await db.registrarCategoriaAprendidaDocumento('user1@c.us', HASH_A, 'despesa', 'Saúde');

  assert.equal(r, HASH_A);
  assert.match(sql, /INSERT INTO categoria_aprendida_documento/);
  assert.match(sql, /ON CONFLICT \(usuario_id, documento_hash, tipo\)/);
  assert.deepEqual(params, ['user1@c.us', HASH_A, 'despesa', 'Saúde']);
});

test('registrarCategoriaAprendidaDocumento: sem hash (transação sem paymentData) não toca no banco', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  assert.equal(await db.registrarCategoriaAprendidaDocumento('user1@c.us', null, 'despesa', 'Saúde'), null);
  assert.equal(await db.registrarCategoriaAprendidaDocumento('user1@c.us', HASH_A, 'despesa', null), null);
  assert.equal(chamouQuery, false);
});

test('buscarCategoriaAprendidaDocumento: consulta por hash + tipo', async (t) => {
  mockResolverIdentidade(t);
  let params = null;
  t.mock.method(db.pool, 'query', async (sql, p) => { params = p; return { rows: [{ categoria: 'Saúde' }] }; });

  const categoria = await db.buscarCategoriaAprendidaDocumento('user1@c.us', HASH_A, 'receita');

  assert.equal(categoria, 'Saúde');
  assert.deepEqual(params, ['user1@c.us', HASH_A, 'receita']);
});

// ── Ordem de resolução: documento > texto > taxonomia > genérico ────────────

test('resolverCategoriaPluggy: documento vence a chave textual quando os dois têm aprendizado', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida_documento')) return { rows: [{ categoria: 'Consultas médicas' }] };
    if (sql.includes('FROM categoria_aprendida')) return { rows: [{ categoria: 'Outros gastos' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Healthcare', 'despesa', 'Variáveis', 'PIX ENVIADO|CLINICA FICTICIA', HASH_A
  );

  assert.equal(categoria, 'Consultas médicas');
});

test('resolverCategoriaPluggy: sem aprendizado por documento, cai para a chave textual', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida_documento')) return { rows: [] };
    if (sql.includes('FROM categoria_aprendida')) return { rows: [{ categoria: 'Restaurantes' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Food and drinks', 'despesa', 'Variáveis', 'Compra no débito|LANCHONETE FICTICIA', HASH_A
  );

  assert.equal(categoria, 'Restaurantes');
});

test('resolverCategoriaPluggy: sem nenhum aprendizado, segue para a taxonomia da Pluggy', async (t) => {
  mockResolverIdentidade(t);
  const consultadas = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    consultadas.push(sql);
    if (sql.includes('FROM categoria_aprendida_documento')) return { rows: [] };
    if (sql.includes('FROM categoria_aprendida')) return { rows: [] };
    if (sql.includes('FROM limites_categoria')) return { rows: [{ categoria: 'Mercado' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy(
    'user1@c.us', 'Mercado', 'despesa', 'Variáveis', 'Compra no débito|MERCADO FICTICIO', HASH_A
  );

  assert.equal(categoria, 'Mercado');
  assert.ok(consultadas.some(s => s.includes('FROM categoria_aprendida_documento')), 'documento é consultado primeiro');
});

test('resolverCategoriaPluggy: transação sem documento nem descrição nem categoria não toca no banco', async (t) => {
  mockResolverIdentidade(t);
  let chamouQuery = false;
  t.mock.method(db.pool, 'query', async () => { chamouQuery = true; return { rows: [] }; });

  assert.equal(await db.resolverCategoriaPluggy('user1@c.us', null, 'despesa', null, null, null), 'Outros');
  assert.equal(chamouQuery, false);
});

test('resolverCategoriaPluggy: só com documento (sem categoria da Pluggy) o aprendizado ainda vale', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM categoria_aprendida_documento')) return { rows: [{ categoria: 'Aluguel' }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  const categoria = await db.resolverCategoriaPluggy('user1@c.us', null, 'despesa', null, null, HASH_B);

  assert.equal(categoria, 'Aluguel');
});

// ── Gravação do aprendizado quando o usuário corrige a categoria ────────────

test('atualizarTransacao: correção de categoria grava aprendizado por texto E por documento', async (t) => {
  mockResolverIdentidade(t);
  const aprendizados = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    if (sql.includes('UPDATE transacoes')) {
      return { rows: [{
        id: 5, tipo: 'despesa', valor: 120, descricao: 'PIX ENVIADO|CLINICA FICTICIA',
        categoria: 'Consultas médicas', data: '2026-08-01', status: 'pago',
        cartao_id: null, conta_id: 3, contraparte_hash: HASH_A,
      }] };
    }
    if (sql.includes('INSERT INTO categoria_aprendida_documento')) { aprendizados.push({ tipo: 'documento', params }); return { rows: [] }; }
    if (sql.includes('INSERT INTO categoria_aprendida')) { aprendizados.push({ tipo: 'texto', params }); return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  const atualizada = await db.atualizarTransacao('user1@c.us', 5, 'categoria', 'Consultas médicas');

  assert.deepEqual(aprendizados.map(a => a.tipo).sort(), ['documento', 'texto']);
  const porDocumento = aprendizados.find(a => a.tipo === 'documento');
  assert.deepEqual(porDocumento.params, ['user1@c.us', HASH_A, 'despesa', 'Consultas médicas']);
  assert.equal(atualizada.contraparte_hash, undefined, 'o hash é detalhe interno, não volta na resposta da API');
});

test('atualizarTransacao: transação sem documento aprende só pelo texto', async (t) => {
  mockResolverIdentidade(t);
  const aprendizados = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('UPDATE transacoes')) {
      return { rows: [{
        id: 6, tipo: 'despesa', valor: 80, descricao: 'LOJA FICTICIA 2/3',
        categoria: 'Compras', data: '2026-08-01', status: 'pago',
        cartao_id: 42, conta_id: null, contraparte_hash: null,
      }] };
    }
    if (sql.includes('INSERT INTO categoria_aprendida_documento')) { aprendizados.push('documento'); return { rows: [] }; }
    if (sql.includes('INSERT INTO categoria_aprendida')) { aprendizados.push('texto'); return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.atualizarTransacao('user1@c.us', 6, 'categoria', 'Compras');

  assert.deepEqual(aprendizados, ['texto']);
});

test('atualizarTransacao: edição de outro campo não gera aprendizado nenhum', async (t) => {
  mockResolverIdentidade(t);
  const inserts = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('UPDATE transacoes')) {
      return { rows: [{ id: 7, tipo: 'despesa', valor: 90, descricao: 'X', categoria: 'Y', data: '2026-08-01', status: 'pago', cartao_id: null, conta_id: 3, contraparte_hash: HASH_A }] };
    }
    if (sql.includes('INSERT INTO')) { inserts.push(sql); return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.atualizarTransacao('user1@c.us', 7, 'valor', 90);

  assert.deepEqual(inserts, []);
});

// ── Persistência do hash na sincronização ──────────────────────────────────

test('upsertTransacaoPluggy: grava contraparte_hash no INSERT', async (t) => {
  mockResolverIdentidade(t);
  const queries = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [] };
    if (sql.includes('INSERT INTO transacoes')) return { rows: [{ id: 90 }] };
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-doc', tipo: 'despesa', valor: 55, descricao: 'PIX ENVIADO|FORNECEDOR FICTICIO',
    categoria: 'Serviços', data: '2026-08-03', status: 'pago', contaId: 3,
    contraparteHash: HASH_B,
  });

  const insert = queries.find(q => q.sql.includes('INSERT INTO transacoes'));
  assert.match(insert.sql, /contraparte_hash/);
  assert.equal(insert.params[insert.params.length - 1], HASH_B);
});

test('upsertTransacaoPluggy: re-sync sem documento não apaga o hash já gravado (COALESCE)', async (t) => {
  mockResolverIdentidade(t);
  let updateSql = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [{ id: 7, categoria_manual: false }] };
    if (sql.includes('UPDATE transacoes')) { updateSql = sql; return { rows: [] }; }
    throw new Error(`Query inesperada: ${sql}`);
  });

  await db.upsertTransacaoPluggy('user1@c.us', {
    pluggyTransactionId: 'tx-doc', tipo: 'despesa', valor: 55, descricao: 'X',
    categoria: 'Serviços', data: '2026-08-03', status: 'pago',
  });

  assert.match(updateSql, /contraparte_hash = COALESCE/);
});
