// Alerta consolidado pós-sincronização Pluggy.
//
// Regras cobertas aqui:
//  - uma sincronização gera UMA mensagem, listando só quem subiu de faixa;
//  - a unidade é o LIMITADOR: duas categorias do mesmo grupo tocadas pelo lote
//    rendem um aviso só;
//  - a mesma faixa não é avisada duas vezes (anti-repetição);
//  - subir de faixa avisa de novo;
//  - virada de janela reabre o aviso;
//  - WhatsApp fora do ar NÃO derruba a sincronização (cenário real: em
//    produção a sessão estava desconectada quando a feature foi escrita).

// ── Setup: env ANTES de carregar os módulos ──────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'c'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');
const notificador = require('../src/notificador');
const limites = require('../src/limites');

// Estado do banco simulado: limitadores com teto, gastos por janela e a faixa
// já avisada. registrarFaixaAlertada replica a semântica do UPDATE condicional
// do Postgres (só promove, nunca rebaixa).
//
// tetos: { nome: { id, categorias, semanal, gastoSemana, mensal, gastoMes } }
function mockBanco(t, tetos, faixasJaAvisadas = {}) {
  const avisadas = { ...faixasJaAvisadas };

  t.mock.method(db, 'listarConsumoLimitadores', async (_uid, opcoes = {}) => {
    const janelas = db.janelasDeControle(opcoes.dataRef || null);
    const montar = (limite, gastos, janela) => {
      if (!limite) return null;
      const percentual = Math.round((gastos / limite) * 100);
      return {
        limite, gastos, restante: limite - gastos, percentual,
        faixa: db.faixaDeAlerta(percentual), ...janelas[janela],
      };
    };
    return Object.entries(tetos).map(([nome, t2]) => ({
      id: t2.id,
      limitador: nome,
      categorias: t2.categorias,
      semana: montar(t2.semanal, t2.gastoSemana, 'semana'),
      mes: montar(t2.mensal, t2.gastoMes, 'mes'),
    }));
  });

  t.mock.method(db, 'registrarFaixaAlertada', async (_uid, limitadorId, janela, chave, faixa) => {
    if (!faixa) return false;
    const k = `${limitadorId}|${janela}|${chave}`;
    if ((avisadas[k] || 0) >= faixa) return false;
    avisadas[k] = faixa;
    return true;
  });

  return avisadas;
}

function capturarEnvios(t) {
  const enviados = [];
  t.mock.method(notificador, 'enviarWhatsapp', async (usuarioId, mensagem) => {
    enviados.push({ usuarioId, mensagem });
    return true;
  });
  return enviados;
}

const TETOS_PADRAO = () => ({
  // semana 86% / mês 45%
  Mercado: { id: 1, categorias: ['Supermercado', 'Compras'], semanal: 500, gastoSemana: 430, mensal: 2000, gastoMes: 900 },
  // semana 107%
  Combustível: { id: 2, categorias: ['Postos de gasolina'], semanal: 75, gastoSemana: 80, mensal: 0, gastoMes: 0 },
  // tranquilo
  Farmácia: { id: 3, categorias: ['Farmácia'], semanal: 200, gastoSemana: 40, mensal: 400, gastoMes: 90 },
});

test('uma sincronização gera UMA mensagem consolidada, só com quem subiu de faixa', async (t) => {
  mockBanco(t, TETOS_PADRAO());
  const enviados = capturarEnvios(t);

  const qtd = await limites.avisarLimitesPosSync(
    'u1@c.us', ['Supermercado', 'Postos de gasolina', 'Farmácia'], { dataRef: '2026-08-05' }
  );

  assert.equal(qtd, 2, 'Mercado (semana) e Combustível (semana); Farmácia fica de fora');
  assert.equal(enviados.length, 1, 'uma sincronização = uma mensagem, não uma por limitador');

  const msg = enviados[0].mensagem;
  assert.match(msg, /Combustível/);
  assert.match(msg, /Mercado/);
  assert.ok(!msg.includes('Farmácia'), 'limitador tranquilo não deve aparecer');
  // Pior primeiro: Combustível estourou (100), Mercado está em 80.
  assert.ok(msg.indexOf('Combustível') < msg.indexOf('Mercado'), 'estouro vem antes do aviso');
  assert.match(msg, /🚨 \*Limite estourado\*/, 'título reflete o pior caso do lote');
});

test('duas categorias do MESMO limitador no lote rendem um aviso só', async (t) => {
  mockBanco(t, TETOS_PADRAO());
  const enviados = capturarEnvios(t);

  // Supermercado e Compras estão as duas no limitador "Mercado".
  const qtd = await limites.avisarLimitesPosSync(
    'u1@c.us', ['Supermercado', 'Compras'], { dataRef: '2026-08-05' }
  );

  assert.equal(qtd, 1);
  assert.equal(enviados[0].mensagem.match(/Mercado/g).length, 1);
});

test('categoria tocada que não está em limitador nenhum não gera aviso', async (t) => {
  mockBanco(t, TETOS_PADRAO());
  const enviados = capturarEnvios(t);

  // O caso comum: 41 subcategorias, poucos limitadores.
  const qtd = await limites.avisarLimitesPosSync('u1@c.us', ['Apostas', 'Viagens'], { dataRef: '2026-08-05' });

  assert.equal(qtd, 0);
  assert.equal(enviados.length, 0);
});

test('anti-repetição: mesma faixa em novo sync não avisa; subir de faixa avisa', async (t) => {
  const tetos = {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 430, mensal: 0, gastoMes: 0 },
  };
  mockBanco(t, tetos);
  const enviados = capturarEnvios(t);

  // 1º sync: 86% → faixa 80, avisa.
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 1);

  // 2º sync no mesmo dia, gasto subiu mas continua na faixa 80 → silêncio.
  tetos.Mercado.gastoSemana = 470; // 94%
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 0);

  // 3º sync: passou dos 100% → faixa nova, avisa de novo.
  tetos.Mercado.gastoSemana = 520; // 104%
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 1);

  assert.equal(enviados.length, 2, 'dois avisos ao todo: 80% e 100%');
  assert.match(enviados[1].mensagem, /Estourou/);
});

test('anti-repetição: faixa nunca rebaixa dentro da mesma janela', async (t) => {
  const tetos = {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 520, mensal: 0, gastoMes: 0 },
  };
  mockBanco(t, tetos);
  capturarEnvios(t);

  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 1);

  // Estorno derruba o gasto para a faixa 60 — não é motivo para novo alarme.
  tetos.Mercado.gastoSemana = 320; // 64%
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 0);
});

test('anti-repetição: nova semana e novo mês reabrem o aviso', async (t) => {
  mockBanco(t, {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 430, mensal: 2000, gastoMes: 1700 },
  });
  capturarEnvios(t);

  // 2026-08-05 (quarta): semana 86% e mês 85% → dois avisos.
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 2);
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' }), 0);

  // 2026-08-10 (segunda seguinte): semana nova, mês igual → só a semana volta.
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-10' }), 1);

  // 2026-09-02: semana nova E mês novo → os dois voltam.
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-09-02' }), 2);
});

test('categorias repetidas no lote são avaliadas uma vez só', async (t) => {
  mockBanco(t, {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 430, mensal: 0, gastoMes: 0 },
  });
  const enviados = capturarEnvios(t);

  const qtd = await limites.avisarLimitesPosSync(
    'u1@c.us', ['Supermercado', 'Supermercado', 'Supermercado', null, undefined], { dataRef: '2026-08-05' }
  );

  assert.equal(qtd, 1);
  assert.equal(enviados[0].mensagem.match(/Mercado/g).length, 1);
});

test('lote sem limitador com teto não manda mensagem nenhuma', async (t) => {
  mockBanco(t, {});
  const enviados = capturarEnvios(t);

  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', ['Outros'], { dataRef: '2026-08-05' }), 0);
  assert.equal(await limites.avisarLimitesPosSync('u1@c.us', [], { dataRef: '2026-08-05' }), 0);
  assert.equal(enviados.length, 0);
});

// ── Bloco reativo (confirmação de lançamento) ────────────────────────────────

test('blocoLimitesDaTransacao: fala o nome do LIMITADOR, não o da subcategoria', async (t) => {
  t.mock.method(db, 'verificarLimitadorDaCategoria', async () => ({
    id: 1,
    limitador: 'Mercado',
    semana: { limite: 500, gastos: 430, restante: 70, percentual: 86, faixa: 80, chave: '2026-W32' },
    mes: null,
  }));
  const marcadas = [];
  t.mock.method(db, 'registrarFaixaAlertada', async (_uid, id, janela, chave, faixa) => {
    marcadas.push({ id, janela, chave, faixa });
    return true;
  });

  const msg = await limites.blocoLimitesDaTransacao('u1@c.us', 'Compras');

  assert.match(msg, /\*Mercado\* — esta semana/);
  assert.ok(!msg.includes('Compras'), 'a subcategoria da transação não é o que o usuário controla');
  // A marca d'água sobe já na confirmação: sem isso, uma sincronização logo
  // depois repetiria proativamente o estouro que ele acabou de ver.
  assert.deepEqual(marcadas, [{ id: 1, janela: 'semana', chave: '2026-W32', faixa: 80 }]);
});

test('blocoLimitesDaTransacao: categoria fora de limitador não anexa nada', async (t) => {
  t.mock.method(db, 'verificarLimitadorDaCategoria', async () => null);
  assert.equal(await limites.blocoLimitesDaTransacao('u1@c.us', 'Apostas'), '');
  assert.equal(await limites.blocoLimitesDaTransacao('u1@c.us', null), '');
});

// ── Isolamento de falha no envio ─────────────────────────────────────────────

test('WhatsApp desconectado: avisarLimitesPosSync não lança e reporta o estouro apurado', async (t) => {
  mockBanco(t, {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 520, mensal: 0, gastoMes: 0 },
  });
  // Sem cliente registrado, enviarWhatsapp devolve false (não lança).
  t.mock.method(notificador, 'whatsappDisponivel', () => false);

  const qtd = await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' });
  assert.equal(qtd, 1, 'apurou o estouro mesmo sem conseguir entregar');
});

test('erro de envio (sessão caiu no meio) é engolido — não sobe para o chamador', async (t) => {
  mockBanco(t, {
    Mercado: { id: 1, categorias: ['Supermercado'], semanal: 500, gastoSemana: 520, mensal: 0, gastoMes: 0 },
  });
  t.mock.method(notificador, 'enviarWhatsapp', async () => { throw new Error('Session closed'); });

  await assert.doesNotReject(
    () => limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' })
  );
});

test('falha ao CONSULTAR o teto também não derruba o chamador', async (t) => {
  t.mock.method(db, 'listarConsumoLimitadores', async () => { throw new Error('pool esgotado'); });
  capturarEnvios(t);

  const qtd = await limites.avisarLimitesPosSync('u1@c.us', ['Supermercado'], { dataRef: '2026-08-05' });
  assert.equal(qtd, 0);
});

test('enviarWhatsapp: cliente que lança vira false, nunca exceção', async (t) => {
  notificador.registrarWhatsappClient({
    sendMessage: async () => { throw new Error('Evaluation failed: WidgetError'); },
  });
  t.after(() => notificador.registrarWhatsappClient(null));

  assert.equal(await notificador.enviarWhatsapp('u1@c.us', 'oi'), false);
});

test('enviarWhatsapp: sem cliente registrado devolve false', async () => {
  notificador.registrarWhatsappClient(null);
  assert.equal(notificador.whatsappDisponivel(), false);
  assert.equal(await notificador.enviarWhatsapp('u1@c.us', 'oi'), false);
});

// ── Formatação ───────────────────────────────────────────────────────────────

test('formatarAvisoConsolidado: emoji por faixa e rótulo da janela', async () => {
  const msg = limites.formatarAvisoConsolidado([
    { limitador: 'Mercado', janela: 'semana', limite: 500, gastos: 520, restante: -20, percentual: 104, faixa: 100 },
    { limitador: 'Lazer', janela: 'mes', limite: 200, gastos: 130, restante: 70, percentual: 65, faixa: 60 },
  ]);

  assert.match(msg, /🚨 \*Mercado\* — esta semana/);
  assert.match(msg, /📊 \*Lazer\* — este mês/);
  assert.match(msg, /Estourou/);
  assert.match(msg, /Resta:/);
  assert.equal(limites.formatarAvisoConsolidado([]), '');
});

test('barraProgresso: 10 blocos, satura em 100% e não quebra com estouro grande', async () => {
  assert.equal(limites.barraProgresso(0), '░'.repeat(10));
  assert.equal(limites.barraProgresso(50), '█'.repeat(5) + '░'.repeat(5));
  assert.equal(limites.barraProgresso(100), '█'.repeat(10));
  assert.equal(limites.barraProgresso(340), '█'.repeat(10));
});
