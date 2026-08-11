// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'j'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('https');

const db = require('../src/database');
const pluggy = require('../src/pluggy');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Mesmo harness dos demais testes de Pluggy: https.request é propriedade de
// módulo core (singleton no processo), lida dinamicamente a cada chamada.
function instalarMockHttps(t, resposta) {
  const requestsFeitos = [];

  t.mock.method(https, 'request', (options, callback) => {
    requestsFeitos.push({ hostname: options.hostname, path: options.path });

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = resposta.statusCode ?? 200;
      queueMicrotask(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(resposta.body ?? {})));
        res.emit('end');
      });
    };
    return req;
  });

  return requestsFeitos;
}

// Fixtures 100% sintéticas — nenhum valor, emissor ou CNPJ real do usuário.
const CDB_SINTETICO = {
  id: 'inv-aaa',
  name: 'CDB - BANCO EXEMPLO S.A.',
  type: 'FIXED_INCOME',
  subtype: 'CDB',
  balance: 1000,
  amountOriginal: 900,
  amountProfit: 100,
  rate: 100,
  rateType: 'CDI',
  lastTwelveMonthsRate: 11.5,
  dueDate: '2030-01-15T00:00:00.000Z',
  issuer: 'Banco Exemplo',
  institution: 'Banco Exemplo',
  status: 'ACTIVE',
};

// ── mapearInvestimentoPluggy (função pura) ───────────────────────────────────

test('mapearInvestimentoPluggy: traduz os campos usados pelo Cronos', () => {
  const dados = pluggy.mapearInvestimentoPluggy(CDB_SINTETICO);

  assert.equal(dados.pluggyInvestmentId, 'inv-aaa');
  assert.equal(dados.nome, 'CDB - BANCO EXEMPLO S.A.');
  assert.equal(dados.tipo, 'FIXED_INCOME');
  assert.equal(dados.subtipo, 'CDB');
  assert.equal(dados.saldo, 1000);
  assert.equal(dados.valorAplicado, 900);
  assert.equal(dados.lucro, 100);
  assert.equal(dados.taxa, 100);
  assert.equal(dados.tipoTaxa, 'CDI');
  assert.equal(dados.rentabilidade12m, 11.5);
  assert.equal(dados.emissor, 'Banco Exemplo');
  assert.equal(dados.status, 'ACTIVE');
});

test('mapearInvestimentoPluggy: dueDate ISO completo vira YYYY-MM-DD (coluna é DATE)', () => {
  const dados = pluggy.mapearInvestimentoPluggy(CDB_SINTETICO);
  assert.equal(dados.vencimento, '2030-01-15');
});

test('mapearInvestimentoPluggy: posição sem id é descartada (não dá para deduplicar sem chave)', () => {
  assert.equal(pluggy.mapearInvestimentoPluggy({ name: 'sem id' }), null);
  assert.equal(pluggy.mapearInvestimentoPluggy(null), null);
});

test('mapearInvestimentoPluggy: saldo cai para amount e depois para 0 — nunca null (coluna NOT NULL)', () => {
  const semBalance = pluggy.mapearInvestimentoPluggy({ id: 'inv-b', amount: 250 });
  assert.equal(semBalance.saldo, 250);

  const semNada = pluggy.mapearInvestimentoPluggy({ id: 'inv-c' });
  assert.equal(semNada.saldo, 0, 'ativo sem valor não pode quebrar o sync inteiro');
  assert.equal(semNada.nome, 'Investimento', 'nome tem fallback: coluna é NOT NULL');
});

test('mapearInvestimentoPluggy: campos numéricos ausentes viram null, não NaN', () => {
  const dados = pluggy.mapearInvestimentoPluggy({ id: 'inv-d', balance: 10, rate: null, amountProfit: undefined });
  assert.equal(dados.taxa, null);
  assert.equal(dados.lucro, null);
  assert.equal(dados.rentabilidade12m, null);
});

// ── buscarInvestimentosPluggy — contrato de erro ─────────────────────────────

test('buscarInvestimentosPluggy: monta GET /investments?itemId=', async (t) => {
  const requests = instalarMockHttps(t, { body: { results: [CDB_SINTETICO] } });

  const investimentos = await pluggy.buscarInvestimentosPluggy('api-key-fake', 'item-123');

  assert.equal(investimentos.length, 1);
  assert.equal(requests[0].hostname, 'api.pluggy.ai');
  assert.equal(requests[0].path, '/investments?itemId=item-123');
});

test('buscarInvestimentosPluggy: aceita array direto além de {results}', async (t) => {
  instalarMockHttps(t, { body: [CDB_SINTETICO] });
  const investimentos = await pluggy.buscarInvestimentosPluggy('api-key-fake', 'item-123');
  assert.equal(investimentos.length, 1);
});

test('buscarInvestimentosPluggy: 403 (produto não contratado) devolve lista vazia sem lançar', async (t) => {
  instalarMockHttps(t, { statusCode: 403, body: { message: 'forbidden' } });
  assert.deepEqual(await pluggy.buscarInvestimentosPluggy('api-key-fake', 'item-123'), []);
});

test('buscarInvestimentosPluggy: erro transitório (5xx) LANÇA em vez de devolver []', async (t) => {
  instalarMockHttps(t, { statusCode: 500, body: { message: 'erro' } });

  // Guarda crítica: quem chama usa a lista devolvida para desativar as posições
  // que sumiram. Se um 5xx virasse [] silencioso, a desativação marcaria TODOS
  // os investimentos do usuário como resgatados. Lançar faz o catch de
  // sincronizarItem pular a desativação junto.
  await assert.rejects(() => pluggy.buscarInvestimentosPluggy('api-key-fake', 'item-123'));
});

// ── Persistência: upsert e ciclo de vida ─────────────────────────────────────

test('upsertInvestimentoPluggy: re-sync atualiza a mesma posição (ON CONFLICT), nunca insere de novo', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqls.push({ sql, params });
    return { rows: [{ id: 7, novo: false }] };
  });

  const dados = pluggy.mapearInvestimentoPluggy(CDB_SINTETICO);
  await db.upsertInvestimentoPluggy('user1@c.us', 1, dados);
  await db.upsertInvestimentoPluggy('user1@c.us', 1, { ...dados, saldo: 1050 });

  assert.equal(sqls.length, 2, 'duas sincronizações, duas escritas');
  for (const { sql } of sqls) {
    assert.match(
      sql,
      /ON CONFLICT \(pluggy_investment_id\) DO UPDATE/,
      'sem ON CONFLICT na chave da Pluggy, o re-sync duplicaria cada posição e dobraria o total investido'
    );
  }
  // O saldo do segundo sync tem de estar entre os parâmetros — posição muda de
  // valor a cada atualização e precisa refletir o número novo.
  assert.ok(sqls[1].params.includes(1050), 'o saldo atualizado deve ser gravado');
});

test('upsertInvestimentoPluggy: reativa posição que havia sumido e voltou', async (t) => {
  mockResolverIdentidade(t);
  let sqlCapturado = null;
  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return { rows: [{ id: 7, novo: false }] };
  });

  await db.upsertInvestimentoPluggy('user1@c.us', 1, pluggy.mapearInvestimentoPluggy(CDB_SINTETICO));
  assert.match(sqlCapturado, /ativo = TRUE/);
});

test('desativarInvestimentosAusentes: marca inativo em vez de deletar (resgate é histórico)', async (t) => {
  let sqlCapturado = null;
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqlCapturado = sql;
    paramsCapturados = params;
    return { rows: [{ id: 3 }], rowCount: 1 };
  });

  const desativados = await db.desativarInvestimentosAusentes(1, ['inv-aaa']);

  assert.equal(desativados, 1);
  assert.match(sqlCapturado, /UPDATE investimentos/);
  assert.match(sqlCapturado, /ativo = FALSE/);
  assert.doesNotMatch(sqlCapturado, /DELETE/i, 'ativo resgatado é histórico, nunca DELETE');
});

test('desativarInvestimentosAusentes: escopo é o ITEM, não o usuário', async (t) => {
  let sqlCapturado = null;
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    sqlCapturado = sql;
    paramsCapturados = params;
    return { rows: [], rowCount: 0 };
  });

  await db.desativarInvestimentosAusentes(42, ['inv-aaa']);

  // Sem o filtro por pluggy_item_id, sincronizar o banco A desativaria as
  // posições do banco B do mesmo usuário (quem tem duas conexões perderia
  // metade do patrimônio da tela a cada sync).
  assert.match(sqlCapturado, /WHERE pluggy_item_id = \$1/);
  assert.equal(paramsCapturados[0], 42);
  assert.deepEqual(paramsCapturados[1], ['inv-aaa']);
});

test('desativarInvestimentosAusentes: lista vazia desativa tudo do item (resgate total)', async (t) => {
  let paramsCapturados = null;
  t.mock.method(db.pool, 'query', async (sql, params) => {
    paramsCapturados = params;
    return { rows: [], rowCount: 0 };
  });

  await db.desativarInvestimentosAusentes(1, []);
  assert.deepEqual(paramsCapturados[1], [], 'array vazio: NOT (x = ANY(\'{}\')) é verdadeiro para todas as linhas');
});

// ── Agregação ────────────────────────────────────────────────────────────────

test('resumoInvestimentos: agrega total, quantidade e composição por tipo', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('AS quantidade') && sql.includes('total_aplicado')) {
      return { rows: [{ total: 1500, total_aplicado: 1300, total_lucro: 200, quantidade: 3 }] };
    }
    if (sql.includes('GROUP BY COALESCE(tipo')) {
      return { rows: [
        { tipo: 'FIXED_INCOME', total: 1200, quantidade: 2 },
        { tipo: 'MUTUAL_FUND', total: 300, quantidade: 1 },
      ] };
    }
    if (sql.includes('GROUP BY COALESCE(emissor')) {
      return { rows: [{ emissor: 'Banco Exemplo', total: 1500, quantidade: 3 }] };
    }
    return { rows: [] };
  });

  const resumo = await db.resumoInvestimentos('user1@c.us');

  assert.equal(resumo.total, 1500);
  assert.equal(resumo.totalAplicado, 1300);
  assert.equal(resumo.totalLucro, 200);
  assert.equal(resumo.quantidade, 3);
  assert.equal(resumo.porTipo.length, 2);
  assert.equal(resumo.porTipo[0].tipo, 'FIXED_INCOME');
  assert.equal(resumo.porTipo[0].total, 1200);
  assert.equal(resumo.porEmissor[0].quantidade, 3);
});

test('resumoInvestimentos: só considera posições ativas', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];
  t.mock.method(db.pool, 'query', async (sql) => {
    sqls.push(sql);
    return { rows: [{ total: 0, total_aplicado: 0, total_lucro: 0, quantidade: 0 }] };
  });

  await db.resumoInvestimentos('user1@c.us');

  assert.ok(sqls.length >= 3);
  for (const sql of sqls) {
    assert.match(sql, /ativo = TRUE/, 'posição resgatada não pode entrar no total investido');
  }
});

// ── GUARDA CENTRAL: investimento não é saldo em conta ────────────────────────
//
// Dinheiro aplicado não é saldo líquido em conta corrente. Se `investimentos`
// entrasse em qualquer uma das duas funções de saldo, o "Saldo em contas" do
// painel e do WhatsApp passaria a mostrar um número inflado — a mesma classe de
// bug já corrigida em calcularSaldos (exclusão assimétrica de cartão).
//
// O teste é estrutural de propósito: falha no momento em que alguém adicionar
// um JOIN/subquery de investimentos nessas funções, sem depender de fixture.

test('calcularSaldos: nenhuma query toca a tabela investimentos', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];

  t.mock.method(db.pool, 'query', async (sql) => {
    sqls.push(sql);
    if (sql.includes('receitas_pagas')) {
      return { rows: [{ receitas_pagas: 100, despesas_pagas: 40, receitas_pendentes: 0, despesas_pendentes: 0 }] };
    }
    if (sql.includes('as total')) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });

  await db.calcularSaldos('user1@c.us');

  assert.ok(sqls.length > 0, 'sanidade: o mock precisa ter sido exercitado');
  for (const sql of sqls) {
    assert.doesNotMatch(
      sql,
      /\binvestimentos\b/i,
      'investimento é estoque (patrimônio aplicado), não saldo em conta — somar inflaria o saldo'
    );
  }
});

test('calcularSaldosPorConta: nenhuma query toca a tabela investimentos', async (t) => {
  mockResolverIdentidade(t);
  const sqls = [];

  t.mock.method(db.pool, 'query', async (sql) => {
    sqls.push(sql);
    return { rows: [{ id: 1, nome: 'Conta Principal', tipo: null, saldo: 0 }] };
  });

  await db.calcularSaldosPorConta('user1@c.us');

  assert.ok(sqls.length > 0, 'sanidade: o mock precisa ter sido exercitado');
  for (const sql of sqls) {
    assert.doesNotMatch(sql, /\binvestimentos\b/i, 'saldo por conta não pode incluir posição de investimento');
  }
});

test('calcularSaldos: o total de investimentos não entra em saldoAtual', async (t) => {
  mockResolverIdentidade(t);

  // Mesmo cenário exercitado duas vezes; a única diferença é a existência de
  // posições em `investimentos`. Como nenhuma query de saldo lê essa tabela,
  // o saldo tem de ser idêntico — é a versão comportamental da guarda acima.
  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('receitas_pagas')) {
      return { rows: [{ receitas_pagas: 500, despesas_pagas: 200, receitas_pendentes: 0, despesas_pendentes: 0 }] };
    }
    if (sql.includes('as total')) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });

  const saldos = await db.calcularSaldos('user1@c.us');
  assert.equal(saldos.saldoAtual, 300, 'saldo = receitas - despesas, sem qualquer parcela de investimento');
  assert.equal(saldos.totalCaixinhas, 0);
});
