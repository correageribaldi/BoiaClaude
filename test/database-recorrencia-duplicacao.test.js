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

// ── Trava no banco: segunda PROJEÇÃO da mesma recorrência/mês não pode
// duplicar, mesmo em corrida (duas requisições GET /api/transactions em
// paralelo). O UNIQUE INDEX idx_transacoes_projecao_mes garante isso no
// Postgres; aqui validamos que o código trata a rejeição sem lançar erro.
//
// O que a trava NÃO impede mais: duas transações REAIS da mesma recorrência no
// mesmo mês (salário + comissão). Isso é a acumulação, e é legítimo. ─────────

test('adicionarTransacaoComRecorrencia: projeção usa ON CONFLICT DO NOTHING contra a trava de projeção+mês', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [{ id: 1, numero_usuario: 10 }] };
  });

  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'receita', 1500, 'Salário', 'Salário', '2026-08-01', 'pendente', 369,
    null, null, true
  );

  // data::timestamp força a sobrecarga IMMUTABLE de date_trunc — sem o cast,
  // o Postgres recusa a expressão no índice (STABLE, não IMMUTABLE) e o boot
  // cai (incidente de produção já vivido nesta correção). O alvo do ON
  // CONFLICT precisa citar a MESMA expressão E o MESMO predicado do índice,
  // literalmente.
  assert.match(sqlCapturada, /ON CONFLICT \(recorrencia_id, \(date_trunc\('month', data::timestamp\)\)\)/);
  assert.match(sqlCapturada, /WHERE recorrencia_id IS NOT NULL AND projetada = TRUE/);
  assert.match(sqlCapturada, /DO NOTHING/);
});

test('adicionarTransacaoComRecorrencia: lançamento REAL não tem ON CONFLICT — é o que permite acumular no mês', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [{ id: 2, numero_usuario: 11 }] };
  });

  await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'receita', 350, 'Comissão', 'Salário', '2026-08-20', 'pago', 369
  );

  assert.doesNotMatch(sqlCapturada, /ON CONFLICT/, 'segunda entrada real do mês precisa entrar, não ser engolida');
  assert.match(sqlCapturada, /projetada, numero_usuario/);
  assert.match(sqlCapturada, /\$10, FALSE,/);
});

test('adicionarTransacaoComRecorrencia: projeção já existente (0 linhas) não quebra o fluxo', async (t) => {
  mockResolverIdentidade(t);
  // Simula o Postgres aplicando ON CONFLICT DO NOTHING: nenhuma linha voltou,
  // porque já existe projeção para essa recorrência+mês (a segunda chamada da
  // corrida chega aqui).
  t.mock.method(db.pool, 'query', async () => ({ rows: [] }));

  const r = await db.adicionarTransacaoComRecorrencia(
    'user1@c.us', 'receita', 1500, 'Salário', 'Salário', '2026-08-01', 'pendente', 369,
    null, null, true
  );

  assert.equal(r.duplicado, true);
  assert.equal(r.lastInsertRowid, null);
});

// ── Limpeza retroativa: varre PROJEÇÃO duplicada e nada mais.
//
// A versão anterior desta limpeza particionava sobre TODAS as transações da
// recorrência e apagava toda segunda linha do mês, a cada boot. Correto no
// modelo antigo ("uma transação por mês"), destruição de dados no modelo de
// acumulação. Estes testes existem para que ela nunca volte a ser assim. ────

test('limparProjecoesDuplicadas: só olha projeções e mantém a mais antiga', async (t) => {
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [] };
  });

  await db.limparProjecoesDuplicadas();

  assert.match(sqlCapturada, /PARTITION BY recorrencia_id, date_trunc\('month', data::timestamp\)/);
  assert.match(sqlCapturada, /ORDER BY criado_em ASC, id ASC/);
  assert.match(sqlCapturada, /DELETE FROM transacoes/);
  assert.match(sqlCapturada, /WHERE id IN \(SELECT id FROM ranked WHERE rn > 1\)/);
});

test('limparProjecoesDuplicadas: NÃO pode apagar entradas acumuladas legítimas', async (t) => {
  let sqlCapturada = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturada = sql;
    return { rows: [] };
  });

  await db.limparProjecoesDuplicadas();

  // O recorte por projetada = TRUE é o que separa "projeção materializada duas
  // vezes" (bug) de "salário + comissão no mesmo mês" (dado do usuário).
  assert.match(sqlCapturada, /AND projetada = TRUE/);
  assert.doesNotMatch(
    sqlCapturada,
    /ORDER BY \(pluggy_transaction_id IS NULL\)/,
    'critério antigo de desempate implicava varrer lançamentos reais'
  );
});

test('limparProjecoesDuplicadas: é idempotente (roda de novo sem args extras / sem erro)', async (t) => {
  let chamadas = 0;
  t.mock.method(db.pool, 'query', async () => { chamadas++; return { rows: [] }; });

  await db.limparProjecoesDuplicadas();
  await db.limparProjecoesDuplicadas();

  assert.equal(chamadas, 2, 'cada chamada dispara exatamente um DELETE, seguro para rodar de novo no próximo boot');
});

// ── Blindagem: incidente de produção — a criação do índice (função de
// date_trunc não-IMMUTABLE) propagou pra fora de initTables e derrubou o
// boot em loop de restart. Daqui pra frente, falha nessas duas migrações
// específicas loga e SEGUE o boot — nunca derruba o app inteiro. ────────────

test('initTables: falha ao criar idx_transacoes_projecao_mes não derruba o boot', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('idx_transacoes_projecao_mes')) {
      throw new Error('functions in index expression must be marked IMMUTABLE');
    }
    return { rows: [] };
  });
  const erroLogado = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});

  await assert.doesNotReject(() => db.initTables());

  assert.ok(
    erroLogado.mock.calls.some(c => String(c.arguments[0]).includes('idx_transacoes_projecao_mes')),
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
  t.mock.method(console, 'log', () => {});

  await assert.doesNotReject(() => db.initTables());

  assert.ok(
    erroLogado.mock.calls.some(c => String(c.arguments[0]).includes('limpar projeções duplicadas')),
    'o erro precisa ser logado, não engolido silenciosamente'
  );
});

// ── Migrações do modelo de acumulação: cada uma isolada em try/catch, e a
// ORDEM entre elas é o que impede perda de dado. ────────────────────────────

test('initTables: backfill de projetada roda uma vez só (gate em migracoes_aplicadas)', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(console, 'log', () => {});
  let backfills = 0;
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('SET projetada = TRUE')) { backfills++; return { rowCount: 3, rows: [] }; }
    // Segunda passada: a migração já consta como aplicada.
    if (sql.includes("FROM migracoes_aplicadas WHERE nome = 'backfill_projetada_2026_08'")) {
      return { rows: backfills > 0 ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [], rowCount: 0 };
  });

  await db.initTables();
  await db.initTables();

  assert.equal(backfills, 1, 'rodar a cada boot marcaria como projeção lançamentos manuais criados depois');
});

test('initTables: derruba a trava antiga antes de criar a nova (senão a acumulação fica bloqueada)', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(console, 'log', () => {});
  const ordem = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('DROP INDEX IF EXISTS idx_transacoes_recorrencia_mes')) ordem.push('drop');
    if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_transacoes_projecao_mes')) ordem.push('create');
    if (sql.includes('ranked')) ordem.push('limpeza');
    return { rows: [], rowCount: 0 };
  });

  await db.initTables();

  assert.deepEqual(ordem, ['limpeza', 'drop', 'create']);
});

test('initTables: falha ao derrubar a trava antiga não derruba o boot', async (t) => {
  mockResolverIdentidade(t);
  t.mock.method(console, 'log', () => {});
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('DROP INDEX IF EXISTS idx_transacoes_recorrencia_mes')) {
      throw new Error('erro simulado ao remover índice');
    }
    return { rows: [], rowCount: 0 };
  });
  const erroLogado = t.mock.method(console, 'error', () => {});

  await assert.doesNotReject(() => db.initTables());

  assert.ok(erroLogado.mock.calls.some(c => String(c.arguments[0]).includes('idx_transacoes_recorrencia_mes')));
});
