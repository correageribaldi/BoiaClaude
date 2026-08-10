// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

// Bug de produção: compra no cartão de crédito (data = data da compra,
// status = 'pendente' até faturar) estava sendo tratada como "vencida" assim
// que a data passava. Conceitualmente uma compra de cartão nunca atrasa —
// quem vence é a FATURA. Mesma exclusão simétrica já usada em calcularSaldos
// e nos totais de resumoMensal: "(cartao_id IS NULL OR descricao ILIKE 'Fatura %')".

test('resumoMensal: atrasadasResult exclui compra de cartão, mas mantém fatura vencida', async (t) => {
  mockResolverIdentidade(t);
  let sqlAtrasadas = null;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('GROUP BY tipo') && sql.includes("status = 'pendente'") && sql.includes('data < CURRENT_DATE')) {
      sqlAtrasadas = sql;
      return { rows: [] };
    }
    return { rows: [] }; // totaisResult, catResult, listarRecorrencias
  });

  await db.resumoMensal('user1@c.us', 8, 2026);

  assert.ok(sqlAtrasadas, 'query de atrasadas deveria ter rodado');
  assert.ok(
    sqlAtrasadas.includes("cartao_id IS NULL OR descricao ILIKE 'Fatura %'"),
    'atrasadasResult deve excluir compra de cartão, preservando fatura vencida (mesma exceção de calcularSaldos)'
  );
});

test('resumoMensal: despesa comum (sem cartão) vencida continua contando como atrasada', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('GROUP BY tipo') && sql.includes("status = 'pendente'") && sql.includes('data < CURRENT_DATE')) {
      // Simula o filtro real do Postgres: despesa comum (cartao_id NULL) passa,
      // compra de cartão (cartao_id preenchido, sem ser "Fatura ...") não passa.
      return { rows: [{ tipo: 'despesa', quantidade: 1, total: 150.0 }] };
    }
    return { rows: [] };
  });

  const resumo = await db.resumoMensal('user1@c.us', 8, 2026);
  const atrasadaDespesa = resumo.atrasadas.find((a) => a.tipo === 'despesa');

  assert.ok(atrasadaDespesa, 'despesa comum vencida deve aparecer em atrasadas');
  assert.equal(atrasadaDespesa.quantidade, 1);
  assert.equal(atrasadaDespesa.total, 150.0);
});

test('buscarPendentesParaLembrete: não busca compra de cartão vencida, só despesa/receita comum e fatura', async (t) => {
  let sqlCapturado = null;

  t.mock.method(db.pool, 'query', async (sql) => {
    sqlCapturado = sql;
    return { rows: [] };
  });

  await db.buscarPendentesParaLembrete(1);

  assert.ok(sqlCapturado, 'query deveria ter rodado');
  assert.ok(
    sqlCapturado.includes("t.cartao_id IS NULL OR t.descricao ILIKE 'Fatura %'"),
    'lembrete automático de WhatsApp não pode disparar para compra de cartão pendente — só para fatura/despesa comum vencida'
  );
});
