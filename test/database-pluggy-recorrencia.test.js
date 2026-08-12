// ── Setup: env ANTES de carregar database ────────────────────────────────────
//
// Sem DATABASE_URL de propósito: nenhum teste deste arquivo abre conexão —
// db.pool.query é mockado em todos eles, e o Pool só disca quando alguém
// consulta de verdade.
process.env.PLUGGY_ENCRYPTION_KEY = 'g'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

// Bug de produção que originou estes testes: upsertTransacaoPluggy gravava a
// transação importada sem recorrencia_id. A materialização de projeções não
// enxergava o lançamento real (ela procura por recorrencia_id), materializava
// um projetado por cima, e o mesmo dinheiro entrava duas vezes no saldo. O
// índice único idx_transacoes_recorrencia_mes não protege contra isso: é
// parcial (WHERE recorrencia_id IS NOT NULL) e a linha da Pluggy passava por
// baixo dele com NULL.
//
// Todos os dados aqui são SINTÉTICOS.

const USUARIO = 'user1@c.us';
const DESCRICAO = 'Transferência Recebida|Fulano De Tal';

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

function silenciarLogs(t) {
  const logs = { log: [], warn: [], error: [] };
  t.mock.method(console, 'log', (msg) => logs.log.push(String(msg)));
  t.mock.method(console, 'warn', (msg) => logs.warn.push(String(msg)));
  t.mock.method(console, 'error', (msg) => logs.error.push(String(msg)));
  return logs;
}

function regra(extra = {}) {
  return {
    id: 42,
    tipo: 'receita',
    valor: 4321,
    descricao: DESCRICAO,
    frequencia: 'mensal',
    dia_mes: 5,
    dia_semana: null,
    data_inicio: '2026-01-05',
    data_fim: null,
    ...extra,
  };
}

function transacaoPluggy(extra = {}) {
  return {
    pluggyTransactionId: 'tx-sintetica-1',
    tipo: 'receita',
    valor: 4321,
    descricao: DESCRICAO,
    categoria: 'Outras Receitas',
    data: '2026-09-05',
    status: 'pago',
    contaId: 3,
    ...extra,
  };
}

// Banco de mentira com só o que este fluxo toca. INSERT e DELETE mexem DE
// VERDADE em `linhas`, para os testes poderem afirmar "sobrou 1 lançamento" em
// vez de só inspecionar SQL.
function mockBanco(t, opcoes = {}) {
  const {
    recorrencias = [], linhas = [],
    erroAoBuscarRecorrencias = false, insertVinculadoFalha = false,
  } = opcoes;
  const chamadas = [];
  let proximoId = 1000;

  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });

    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) {
      return { rows: opcoes.existente ? [opcoes.existente] : [] };
    }

    if (sql.includes('FROM recorrencias')) {
      if (erroAoBuscarRecorrencias) throw new Error('relation "recorrencias" does not exist');
      return { rows: recorrencias };
    }

    if (sql.includes('SELECT id, status, pluggy_transaction_id')) {
      return { rows: linhas.filter((l) => l.recorrencia_id === params[1]) };
    }

    if (sql.includes('DELETE FROM transacoes')) {
      const [ids, , recorrenciaId] = params;
      const alvo = linhas.filter((l) => ids.includes(l.id)
        && l.recorrencia_id === recorrenciaId
        && l.status === 'pendente'
        && l.pluggy_transaction_id === null);
      for (const linha of alvo) linhas.splice(linhas.indexOf(linha), 1);
      return { rowCount: alvo.length };
    }

    if (sql.includes('INSERT INTO transacoes')) {
      const recorrenciaId = params[10];
      if (insertVinculadoFalha && recorrenciaId !== null) {
        const err = new Error('duplicate key value violates unique constraint "idx_transacoes_recorrencia_mes"');
        err.code = '23505';
        throw err;
      }
      const id = proximoId++;
      linhas.push({
        id,
        status: params[6],
        pluggy_transaction_id: params[9],
        recorrencia_id: recorrenciaId,
        data: params[5],
      });
      return { rows: [{ id }] };
    }

    if (sql.includes('UPDATE transacoes')) return { rows: [] };

    throw new Error(`Query inesperada: ${sql}`);
  });

  return { chamadas, linhas };
}

const insertDe = (chamadas) => chamadas.find((c) => c.sql.includes('INSERT INTO transacoes'));
const deleteDe = (chamadas) => chamadas.find((c) => c.sql.includes('DELETE FROM transacoes'));
const buscaRecorrenciasDe = (chamadas) => chamadas.find((c) => c.sql.includes('FROM recorrencias'));

// ── Casamento e vínculo ──────────────────────────────────────────────────────

test('vincula a transação real da Pluggy à recorrência quando descrição, valor exato e janela batem', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '2026-09-08' }));

  assert.equal(resultado.novo, true);
  assert.equal(resultado.recorrenciaId, 42);
  assert.equal(insertDe(chamadas).params[10], 42, 'recorrencia_id é o $11 do INSERT');
  assert.equal(deleteDe(chamadas), undefined, 'não havia projeção para absorver');
});

test('duas recorrências com a MESMA descrição e valores diferentes: cada transação vincula na sua', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);

  const regras = [regra({ id: 50, valor: 4321 }), regra({ id: 51, valor: 987.65 })];

  const primeiro = mockBanco(t, { recorrencias: regras });
  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 4321 }));
  assert.equal(insertDe(primeiro.chamadas).params[10], 50);

  t.mock.restoreAll();
  mockResolverIdentidade(t);
  silenciarLogs(t);

  const segundo = mockBanco(t, { recorrencias: regras });
  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ pluggyTransactionId: 'tx-sintetica-2', valor: 987.65 }));
  assert.equal(insertDe(segundo.chamadas).params[10], 51);
});

test('valor diferente NÃO vincula, mesmo que a query devolva a regra', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  // A query já filtra por valor; a conferência em JS é a segunda camada, e é
  // ela que está sob teste aqui.
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 4321 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 4321.01 }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
});

test('data fora da janela NÃO vincula', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ dia_mes: 5 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '2026-09-20' }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
});

test('ambiguidade (duas regras casam igual) NÃO vincula a nenhuma e loga para diagnóstico', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ id: 60 }), regra({ id: 61, dia_mes: 7 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.recorrenciaId, null, 'vincular a uma das duas seria sorteio');
  assert.equal(insertDe(chamadas).params[10], null);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /60, 61/);
  assert.doesNotMatch(logs.warn[0], /Fulano/, 'log não carrega nome de contraparte');
});

// ── Absorção da projeção (rede de proteção obrigatória) ──────────────────────

test('cenário completo: projeção já materializada é ABSORVIDA pelo lançamento real e sobra 1 lançamento', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);

  // Estado antes: o usuário abriu o painel em setembro e a projeção da regra 42
  // virou uma transação pendente, sem origem na Pluggy.
  const projetada = { id: 900, status: 'pendente', pluggy_transaction_id: null, recorrencia_id: 42, data: '2026-09-05' };
  const { chamadas, linhas } = mockBanco(t, { recorrencias: [regra()], linhas: [projetada] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '2026-09-05' }));

  assert.equal(resultado.recorrenciaId, 42);

  const del = deleteDe(chamadas);
  assert.deepEqual(del.params[0], [900]);
  assert.match(del.sql, /status = 'pendente'/);
  assert.match(del.sql, /pluggy_transaction_id IS NULL/);

  assert.equal(linhas.length, 1, 'o mês termina com UM lançamento, não dois');
  assert.equal(linhas[0].pluggy_transaction_id, 'tx-sintetica-1', 'o que sobrou é o lançamento real');
  assert.equal(linhas[0].recorrencia_id, 42, 'e ele carrega o vínculo, que é o que trava a próxima materialização');
  assert.ok(logs.log.some((l) => /absorvida/.test(l)));
});

test('mês ocupado por lançamento que NÃO é projeção: não absorve nada e não vincula', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);

  // Lançamento que o usuário já marcou como pago à mão — dado dele, não é
  // nosso para apagar.
  const manual = { id: 901, status: 'pago', pluggy_transaction_id: null, recorrencia_id: 42, data: '2026-09-05' };
  const { chamadas, linhas } = mockBanco(t, { recorrencias: [regra()], linhas: [manual] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(deleteDe(chamadas), undefined, 'nada é apagado');
  assert.equal(insertDe(chamadas).params[10], null);
  assert.equal(linhas.length, 2, 'duplicata visível é preferível a apagar dado do usuário');
  assert.ok(logs.warn.some((l) => /não é projeção/.test(l)));
});

// ── Robustez: nada aqui pode quebrar o laço de sincronização ─────────────────

test('violação do índice único no INSERT vinculado não quebra o sync: regrava sem vínculo', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()], insertVinculadoFalha: true });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.novo, true, 'a transação da Pluggy entra de qualquer jeito');
  assert.equal(resultado.recorrenciaId, null);
  const inserts = chamadas.filter((c) => c.sql.includes('INSERT INTO transacoes'));
  assert.equal(inserts.length, 2, 'tenta vinculado, cai para não vinculado');
  assert.equal(inserts[1].params[10], null);
  assert.ok(logs.error.some((l) => /mês já ocupado/.test(l)));
});

test('erro de banco ao avaliar o vínculo degrada para o comportamento antigo (grava sem vínculo)', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()], erroAoBuscarRecorrencias: true });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.novo, true);
  assert.equal(insertDe(chamadas).params[10], null);
  assert.ok(logs.error.some((l) => /vínculo de recorrência/.test(l)));
});

test('erro que não é violação de unicidade continua propagando (não engole falha de banco)', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) return { rows: [] };
    if (sql.includes('FROM recorrencias')) return { rows: [] };
    if (sql.includes('INSERT INTO transacoes')) throw new Error('connection terminated');
    throw new Error(`Query inesperada: ${sql}`);
  });

  await assert.rejects(
    () => db.upsertTransacaoPluggy(USUARIO, transacaoPluggy()),
    /connection terminated/
  );
});

// ── Quando o vínculo NÃO é avaliado ──────────────────────────────────────────

test('transação já existente (UPDATE) não reavalia vínculo — não fica indo e voltando a cada re-sync', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, {
    recorrencias: [regra()],
    existente: { id: 7, categoria_manual: false },
  });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.novo, false);
  assert.equal(buscaRecorrenciasDe(chamadas), undefined);
});

test('data ausente ou inválida nem consulta recorrências (corta antes do banco)', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()] });

  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '' }));

  assert.equal(buscaRecorrenciasDe(chamadas), undefined);
  assert.equal(insertDe(chamadas).params[10], null);
});

test('descrição sem chave de estabelecimento nem consulta recorrências', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()] });

  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ descricao: 'Compra no débito|' }));

  assert.equal(buscaRecorrenciasDe(chamadas), undefined);
  assert.equal(insertDe(chamadas).params[10], null);
});
