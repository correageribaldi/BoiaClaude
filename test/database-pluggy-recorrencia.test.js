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
    valor: 1850,
    descricao: DESCRICAO,
    frequencia: 'mensal',
    dia_mes: 5,
    dia_semana: null,
    dia_inicial: 1,
    dia_limite: 10,
    data_inicio: '2026-01-05',
    data_fim: null,
    ...extra,
  };
}

function transacaoPluggy(extra = {}) {
  return {
    pluggyTransactionId: 'tx-sintetica-1',
    tipo: 'receita',
    valor: 1500,
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
    recorrencias = [], linhas = [], consolidados = [],
    erroAoBuscarRecorrencias = false, insertVinculadoFalha = false,
  } = opcoes;
  const chamadas = [];
  let proximoId = 1000;

  const doMes = (recorrenciaId, dataISO) => linhas.filter((l) => l.recorrencia_id === recorrenciaId
    && String(l.data).slice(0, 7) === String(dataISO).slice(0, 7));

  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });

    if (sql.includes('FROM transacoes WHERE pluggy_transaction_id')) {
      return { rows: opcoes.existente ? [opcoes.existente] : [] };
    }

    if (sql.includes('FROM recorrencias_consolidacoes')) {
      return { rows: consolidados.includes(`${params[0]}|${params[1]}`) ? [{ '?column?': 1 }] : [] };
    }

    if (sql.includes('FROM recorrencias')) {
      if (erroAoBuscarRecorrencias) throw new Error('relation "recorrencias" does not exist');
      return { rows: recorrencias };
    }

    // Somas do mês de VÁRIAS regras de uma vez (desempate por faixa). Precisa
    // vir antes do estado do balde: as duas queries compartilham o FILTER, e
    // esta se distingue pelo GROUP BY / lista de ids.
    if (sql.includes('GROUP BY recorrencia_id')) {
      const [, ids, dataISO] = params;
      return {
        rows: ids.map((id) => ({
          recorrencia_id: id,
          soma_real: doMes(id, dataISO).filter((l) => !l.projetada).reduce((s, l) => s + l.valor, 0),
        })),
      };
    }

    // Estado do balde: soma do que é real, ids do que é projeção.
    if (sql.includes('FILTER (WHERE projetada = FALSE)')) {
      const mes = doMes(params[1], params[2]);
      const reais = mes.filter((l) => !l.projetada);
      return {
        rows: [{
          soma_real: reais.reduce((s, l) => s + l.valor, 0),
          qtd_real: reais.length,
          projecoes: mes.filter((l) => l.projetada).map((l) => l.id),
        }],
      };
    }

    if (sql.includes('DELETE FROM transacoes')) {
      const [ids, , recorrenciaId] = params;
      const alvo = linhas.filter((l) => ids.includes(l.id)
        && l.recorrencia_id === recorrenciaId
        && l.projetada === true);
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
        valor: params[2],
        pluggy_transaction_id: params[9],
        recorrencia_id: recorrenciaId,
        data: params[5],
        projetada: false,
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

test('vincula a transação real da Pluggy à recorrência quando origem, tipo e janela batem', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '2026-09-08' }));

  assert.equal(resultado.novo, true);
  assert.equal(resultado.recorrenciaId, 42);
  assert.equal(insertDe(chamadas).params[10], 42, 'recorrencia_id é o $11 do INSERT');
  assert.equal(deleteDe(chamadas), undefined, 'não havia projeção para absorver');
});

test('valor menor que o previsto vincula — é a primeira parcela do balde', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 1500 }));

  assert.equal(resultado.recorrenciaId, 42);
  assert.equal(insertDe(chamadas).params[10], 42);
});

test('data fora da janela NÃO vincula', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ dia_inicial: 1, dia_limite: 10 })] });

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

// ── Faixa de valor: o desempate da ambiguidade ──────────────────────────────
//
// Especificação do dono: "se o vínculo funcionar por espaço de dias e valor,
// exemplo entre 1500 a 2500, resolve o problema inclusive se o valor não entrar
// de uma vez só". A faixa é o eixo que faltava para o sistema parar de desistir
// quando duas regras da mesma contraparte casam com o mesmo lançamento.

test('faixa desempata duas regras da mesma origem e mesma janela', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, {
    recorrencias: [
      regra({ id: 60, valor: 1850, valor_min: 1500, valor_max: 2500 }),
      regra({ id: 61, valor: 400, valor_min: 300, valor_max: 500 }),
    ],
  });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 1500 }));

  assert.equal(resultado.recorrenciaId, 60, 'R$ 1.500 não cabe na regra de 300–500');
  assert.equal(insertDe(chamadas).params[10], 60);
});

test('faixa desempata olhando o que JÁ entrou no mês de cada candidata', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  // A regra 60 já recebeu R$ 2.400 dos R$ 2.500 do teto: os R$ 300 que chegam
  // não cabem mais nela e pertencem à outra.
  const cheia = { id: 920, status: 'pago', valor: 2400, pluggy_transaction_id: 'tx-antes', recorrencia_id: 60, data: '2026-09-02', projetada: false };
  const { chamadas } = mockBanco(t, {
    recorrencias: [
      regra({ id: 60, valor: 1850, valor_min: 1500, valor_max: 2500 }),
      regra({ id: 61, valor: 300, valor_min: 100, valor_max: 3000 }),
    ],
    linhas: [cheia],
  });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-9', valor: 300, data: '2026-09-06',
  }));

  assert.equal(resultado.recorrenciaId, 61);
  assert.equal(insertDe(chamadas).params[10], 61);
});

test('ambiguidade sem faixa em nenhuma das regras continua sem vincular', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ id: 70 }), regra({ id: 71, dia_mes: 7 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
  assert.equal(logs.warn.length, 1);
});

test('faixa: lançamento que sozinho estoura o teto não vincula (vira avulso visível)', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor_min: 1500, valor_max: 2500 })] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 9000 }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
});

test('faixa mantém o balde aberto depois do previsto — a comissão seguinte ainda entra', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  // Sem faixa, R$ 1.850 fechariam o mês e os R$ 300 seguintes virariam avulso.
  const previstoCheio = { id: 921, status: 'pago', valor: 1850, pluggy_transaction_id: 'tx-antes', recorrencia_id: 42, data: '2026-09-03', projetada: false };
  const { chamadas } = mockBanco(t, {
    recorrencias: [regra({ valor: 1850, valor_min: 1500, valor_max: 2500 })],
    linhas: [previstoCheio],
  });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-10', valor: 300, data: '2026-09-08',
  }));

  assert.equal(resultado.recorrenciaId, 42);
  assert.equal(insertDe(chamadas).params[10], 42);
});

test('regra SEM faixa continua fechando o balde no previsto (nada mudou para as antigas)', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const previstoCheio = { id: 922, status: 'pago', valor: 1850, pluggy_transaction_id: 'tx-antes', recorrencia_id: 42, data: '2026-09-03', projetada: false };
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })], linhas: [previstoCheio] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-11', valor: 300, data: '2026-09-08',
  }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
});

test('faixa: uma candidata só não paga a query extra de somas do mês', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor_min: 1500, valor_max: 2500 })] });

  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 1500 }));

  assert.equal(
    chamadas.filter((c) => c.sql.includes('GROUP BY recorrencia_id')).length, 0,
    'o desempate só custa query quando há mais de uma candidata'
  );
});

// ── Absorção da projeção (rede de proteção obrigatória) ──────────────────────

test('cenário completo: projeção já materializada é ABSORVIDA pelo lançamento real e sobra 1 lançamento', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);

  // Estado antes: o usuário abriu o painel em setembro e a projeção da regra 42
  // virou uma transação pendente marcada como projetada.
  const projetada = { id: 900, status: 'pendente', valor: 1850, pluggy_transaction_id: null, recorrencia_id: 42, data: '2026-09-05', projetada: true };
  const { chamadas, linhas } = mockBanco(t, { recorrencias: [regra()], linhas: [projetada] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ data: '2026-09-05', valor: 1850 }));

  assert.equal(resultado.recorrenciaId, 42);

  const del = deleteDe(chamadas);
  assert.deepEqual(del.params[0], [900]);
  assert.match(del.sql, /projetada = TRUE/);

  assert.equal(linhas.length, 1, 'o mês termina com UM lançamento, não dois');
  assert.equal(linhas[0].pluggy_transaction_id, 'tx-sintetica-1', 'o que sobrou é o lançamento real');
  assert.equal(linhas[0].recorrencia_id, 42, 'e ele carrega o vínculo, que é o que trava a próxima materialização');
  assert.ok(logs.log.some((l) => /absorvida/.test(l)));
});

test('a projeção é absorvida uma vez só — a segunda entrada apenas acumula', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const projetada = { id: 900, status: 'pendente', valor: 1850, pluggy_transaction_id: null, recorrencia_id: 42, data: '2026-09-05', projetada: true };
  const { linhas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })], linhas: [projetada] });

  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 1500, data: '2026-09-05' }));
  await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ pluggyTransactionId: 'tx-sintetica-2', valor: 350, data: '2026-09-08' }));

  assert.equal(linhas.length, 2);
  assert.ok(linhas.every((l) => l.recorrencia_id === 42 && !l.projetada));
});

// ── Acumulação: o caso R$ 1.500 + R$ 350 ────────────────────────────────────

test('duas entradas no mesmo mês acumulam na mesma recorrência (1.500 + 350 = 1.850)', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const { linhas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })] });

  const primeira = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 1500, data: '2026-09-05' }));
  const segunda = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-2', valor: 350, data: '2026-09-08',
  }));

  assert.equal(primeira.recorrenciaId, 42);
  assert.equal(segunda.recorrenciaId, 42, 'a segunda entrada NÃO pode virar avulsa');
  assert.equal(linhas.length, 2);
  assert.equal(linhas.reduce((s, l) => s + l.valor, 0), 1850);
});

test('entrada que chega com o balde já no valor previsto vira avulso', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const cheio = { id: 910, status: 'pago', valor: 1850, pluggy_transaction_id: 'tx-anterior', recorrencia_id: 42, data: '2026-09-03', projetada: false };
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })], linhas: [cheio] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-3', valor: 500, data: '2026-09-09',
  }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
  assert.ok(logs.log.some((l) => /balde .* já fechado/.test(l)));
});

test('entrada depois do dia limite vira avulso mesmo com o previsto não alcançado', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const parcial = { id: 911, status: 'pago', valor: 1500, pluggy_transaction_id: 'tx-anterior', recorrencia_id: 42, data: '2026-09-05', projetada: false };
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 1850, dia_inicial: 1, dia_limite: 10 })], linhas: [parcial] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-sintetica-4', valor: 350, data: '2026-09-25',
  }));

  assert.equal(resultado.recorrenciaId, null, 'fora da janela não entra no balde');
  assert.equal(insertDe(chamadas).params[10], null);
});

test('mês consolidado pelo usuário não recebe mais entradas', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, {
    recorrencias: [regra({ valor: 1850 })],
    consolidados: ['42|2026-09'],
  });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({ valor: 100, data: '2026-09-06' }));

  assert.equal(resultado.recorrenciaId, null);
  assert.equal(insertDe(chamadas).params[10], null);
  assert.ok(logs.log.some((l) => /consolidado=true/.test(l)));
});

test('balde de outro mês não interfere: setembro cheio não fecha outubro', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  const setembro = { id: 912, status: 'pago', valor: 1850, pluggy_transaction_id: 'tx-set', recorrencia_id: 42, data: '2026-09-05', projetada: false };
  const { chamadas } = mockBanco(t, { recorrencias: [regra({ valor: 1850 })], linhas: [setembro] });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy({
    pluggyTransactionId: 'tx-out', valor: 1850, data: '2026-10-05',
  }));

  assert.equal(resultado.recorrenciaId, 42);
  assert.equal(insertDe(chamadas).params[10], 42);
});

// ── Robustez: nada aqui pode quebrar o laço de sincronização ─────────────────

test('trava antiga ainda de pé no banco (migração falhou) não quebra o sync: regrava sem vínculo', async (t) => {
  mockResolverIdentidade(t);
  const logs = silenciarLogs(t);
  const { chamadas } = mockBanco(t, { recorrencias: [regra()], insertVinculadoFalha: true });

  const resultado = await db.upsertTransacaoPluggy(USUARIO, transacaoPluggy());

  assert.equal(resultado.novo, true, 'a transação da Pluggy entra de qualquer jeito');
  assert.equal(resultado.recorrenciaId, null);
  const inserts = chamadas.filter((c) => c.sql.includes('INSERT INTO transacoes'));
  assert.equal(inserts.length, 2, 'tenta vinculado, cai para não vinculado');
  assert.equal(inserts[1].params[10], null);
  assert.ok(logs.error.some((l) => /trava antiga ainda ativa/.test(l)));
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

// ── Consequência do vínculo: o que "desativar recorrência" pode apagar ──────

test('desativarRecorrencia apaga só o que o sistema projetou, nunca a pendente vinda da Pluggy', async (t) => {
  mockResolverIdentidade(t);
  silenciarLogs(t);
  // Com o vínculo automático, uma compra de cartão ainda não fechada (status
  // pendente na Pluggy) passa a carregar recorrencia_id. Desativar a regra
  // significa "pare de projetar", não "apague o que já aconteceu no extrato" —
  // e o sync incremental não traria o lançamento de volta.
  const chamadas = [];
  t.mock.method(db.pool, 'query', async (sql, params) => {
    chamadas.push({ sql, params });
    return { rows: [], rowCount: 0 };
  });

  await db.desativarRecorrencia(USUARIO, 42);

  const del = chamadas.find((c) => c.sql.includes('DELETE FROM transacoes'));
  assert.match(del.sql, /status = 'pendente'/);
  assert.match(del.sql, /pluggy_transaction_id IS NULL/);
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
