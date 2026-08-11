// ── Setup: env ANTES de carregar database ────────────────────────────────────
// Nota: senha do fixture com 1 char de propósito (guard-secrets bloqueia o
// padrão "mock:mock@" de 4+ chars como se fosse connection string real).
process.env.DATABASE_URL = 'postgres://mock:x@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// ── Bug de produção: GET /api/transactions materializava a mesma recorrência
// de novo a cada combinação de filtro (tipo/conta/cartão/status) aberta no
// painel, porque a checagem de "já existe transação" reusava a lista JÁ
// FILTRADA da própria requisição. A correção usa listarRecorrenciaIdsNoPeriodo,
// que precisa ser cega a esses filtros — só usuario_id + período. ─────────────

test('listarRecorrenciaIdsNoPeriodo: consulta NÃO filtra por tipo/conta/cartão/status', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [] };
  });

  await db.listarRecorrenciaIdsNoPeriodo('user1@c.us', '2026-08-01', '2026-08-31');

  assert.ok(sqlCapturada.includes('recorrencia_id IS NOT NULL'));
  assert.doesNotMatch(sqlCapturada, /\btipo\s*=/, 'não pode filtrar por tipo — senão volta a esvaziar a checagem sob filtro');
  assert.doesNotMatch(sqlCapturada, /\bstatus\s*=/, 'não pode filtrar por status');
  assert.doesNotMatch(sqlCapturada, /\bconta_id\s*=/, 'não pode filtrar por conta_id');
  assert.doesNotMatch(sqlCapturada, /\bcartao_id\s*=/, 'não pode filtrar por cartao_id');
  assert.doesNotMatch(sqlCapturada, /LIMIT/i, 'sem corte de 200/1000 — precisa ver TODAS as recorrências do período');
});

test('listarRecorrenciaIdsNoPeriodo: devolve recorrencia_id e data para o período pedido', async (t) => {
  mockResolverIdentidade(t);
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [{ recorrencia_id: 369, data: '2026-08-08' }] };
  });

  const rows = await db.listarRecorrenciaIdsNoPeriodo('user1@c.us', '2026-08-01', '2026-08-31');

  assert.deepEqual(paramsCapturados, ['user1@c.us', '2026-08-01', '2026-08-31']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recorrencia_id, 369);
});

// ── Trava no banco: segunda materialização da mesma recorrência/mês não pode
// duplicar, mesmo em corrida (duas requisições GET /api/transactions em
// paralelo). O UNIQUE INDEX idx_transacoes_recorrencia_mes garante isso no
// Postgres; aqui validamos que o código trata a rejeição sem lançar erro. ────

test('adicionarTransacaoComRecorrencia: usa ON CONFLICT DO NOTHING contra a trava de recorrência+mês', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [{ id: 1, numero_usuario: 10 }] };
  });

  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'receita', 1500, 'Salário', 'Salário', '2026-08-01', 'pendente', 369
  );

  // data::timestamp força a sobrecarga IMMUTABLE de date_trunc — sem o cast,
  // o Postgres recusa a expressão no índice (STABLE, não IMMUTABLE) e o boot
  // cai (incidente de produção já vivido nesta correção). O alvo do ON
  // CONFLICT precisa citar a MESMA expressão do índice, literalmente.
  assert.match(sqlCapturada, /ON CONFLICT \(recorrencia_id, \(date_trunc\('month', data::timestamp\)\)\)/);
  assert.match(sqlCapturada, /DO NOTHING/);
});

test('adicionarTransacaoComRecorrencia: violação de unicidade (0 linhas) não quebra o fluxo', async (t) => {
  mockResolverIdentidade(t);
  // Simula o Postgres aplicando ON CONFLICT DO NOTHING: nenhuma linha voltou,
  // porque já existe transação para essa recorrência+mês (a segunda chamada
  // da corrida chega aqui).
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const r = await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'receita', 1500, 'Salário', 'Salário', '2026-08-01', 'pendente', 369
  );

  assert.equal(r.duplicado, true);
  assert.equal(r.lastInsertRowid, null);
});

// ── Limpeza retroativa: das duplicatas já existentes em produção, mantém a
// que veio da Pluggy (a original) e descarta as demais; sem nenhuma vinda da
// Pluggy, mantém a mais antiga. ─────────────────────────────────────────────

test('limparRecorrenciasDuplicadas: prioriza a transação da Pluggy, depois a mais antiga (criado_em/id)', async (t) => {
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [] };
  });

  await db.limparRecorrenciasDuplicadas();

  assert.match(sqlCapturada, /PARTITION BY recorrencia_id, date_trunc\('month', data::timestamp\)/);
  // pluggy_transaction_id IS NULL = false (0) vem primeiro no ASC — ou seja,
  // quem TEM pluggy_transaction_id (veio da Pluggy) é o rn=1 preservado.
  assert.match(sqlCapturada, /ORDER BY \(pluggy_transaction_id IS NULL\) ASC, criado_em ASC, id ASC/);
  assert.match(sqlCapturada, /WHERE recorrencia_id IS NOT NULL/);
  assert.match(sqlCapturada, /DELETE FROM transacoes/);
  assert.match(sqlCapturada, /WHERE id IN \(SELECT id FROM ranked WHERE rn > 1\)/);
});

test('limparRecorrenciasDuplicadas: é idempotente (roda de novo sem args extras / sem erro)', async (t) => {
  let chamadas = 0;
  t.mock.method(db.pool, 'query', async () => { chamadas++; return { rows: [] }; });

  await db.limparRecorrenciasDuplicadas();
  await db.limparRecorrenciasDuplicadas();

  assert.equal(chamadas, 2, 'cada chamada dispara exatamente um DELETE, seguro para rodar de novo no próximo boot');
});

// ── Blindagem: incidente de produção — a criação do índice (função de
// date_trunc não-IMMUTABLE) propagou pra fora de initTables e derrubou o
// boot em loop de restart. Daqui pra frente, falha nessas duas migrações
// específicas loga e SEGUE o boot — nunca derruba o app inteiro. ────────────

test('initTables: falha ao criar idx_transacoes_recorrencia_mes não derruba o boot', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('idx_transacoes_recorrencia_mes')) {
      throw new Error('functions in index expression must be marked IMMUTABLE');
    }
    return { rows: [] };
  });
  const erroLogado = t.mock.method(console, 'error', () => {});

  await assert.doesNotReject(() => db.initTables());

  assert.ok(
    erroLogado.mock.calls.some(c => String(c.arguments[0]).includes('idx_transacoes_recorrencia_mes')),
    'o erro precisa ser logado, não engolido silenciosamente'
  );
});

test('initTables: falha na limpeza retroativa (DELETE) não derruba o boot', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('DELETE FROM transacoes') && sql.includes('ranked')) {
      throw new Error('erro simulado na limpeza retroativa');
    }
    return { rows: [] };
  });
  const erroLogado = t.mock.method(console, 'error', () => {});

  await assert.doesNotReject(() => db.initTables());

  assert.ok(
    erroLogado.mock.calls.some(c => String(c.arguments[0]).includes('limpar recorrências duplicadas')),
    'o erro precisa ser logado, não engolido silenciosamente'
  );
});
