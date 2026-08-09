// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('resumoMensal: exclusão de cartão é simétrica entre receita e despesa (bug de produção corrigido)', async (t) => {
  mockResolverIdentidade(t);
  const sqlsPrincipais = [];

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('GROUP BY tipo, status') || sql.includes('GROUP BY categoria, tipo')) {
      sqlsPrincipais.push(sql);
      return { rows: [] };
    }
    return { rows: [] }; // atrasadasResult, listarRecorrencias — irrelevantes para este teste
  });

  await db.resumoMensal('user1@c.us', 8, 2026);

  assert.equal(sqlsPrincipais.length, 2, 'totaisResult e catResult devem ter rodado');
  for (const sql of sqlsPrincipais) {
    // Bug de produção: "(cartao_id IS NULL OR tipo = 'receita')" deixava
    // QUALQUER receita passar, mesmo com cartao_id preenchido (ex: receita
    // pendente sincronizada no cartão pela Pluggy) — inflava o widget
    // "Receitas" do dashboard. Mesma exceção de fatura já usada em calcularSaldos.
    assert.ok(
      sql.includes("cartao_id IS NULL OR descricao ILIKE 'Fatura %'"),
      'deve excluir cartão simetricamente, com a mesma exceção de fatura de calcularSaldos'
    );
    assert.ok(
      !sql.includes("tipo = 'receita'"),
      'não deve mais ter a saída especial que deixava receita de cartão passar sempre'
    );
  }
});

test('resumoMensal: retorna os totais vindos do banco sem reprocessar valores (sanity check estrutural)', async (t) => {
  mockResolverIdentidade(t);

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('GROUP BY tipo, status')) {
      // Cenário sintético (não os números reais do Federico): receita paga
      // 11520.38 (já filtrada sem cartão pela query real) + receita pendente
      // 0 nesta amostra.
      return { rows: [{ tipo: 'receita', status: 'pago', total: 11520.38, quantidade: 5 }] };
    }
    return { rows: [] };
  });

  const resumo = await db.resumoMensal('user1@c.us', 8, 2026);
  const linhaReceita = resumo.totais.find((t2) => t2.tipo === 'receita' && t2.status === 'pago');

  assert.ok(linhaReceita, 'linha de receita paga deveria estar presente');
  assert.equal(linhaReceita.total, 11520.38);
});
