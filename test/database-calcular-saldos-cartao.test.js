// ── Setup: env ANTES de carregar database ────────────────────────────────────
process.env.DATABASE_URL = 'postgres://mock:mock@localhost:5432/mock';
process.env.PLUGGY_ENCRYPTION_KEY = 'i'.repeat(64); // fixture de teste — NÃO é segredo real

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/database');

function mockResolverIdentidade(t) {
  t.mock.method(db, 'resolverUsuarioPrincipal', async (usuarioId) => usuarioId);
}

test('calcularSaldos: exclusão de transação de cartão é simétrica entre receita e despesa (pago e pendente)', async (t) => {
  mockResolverIdentidade(t);
  let sqlPrincipal = null;

  t.mock.method(db.pool, 'query', async (sql) => {
    if (sql.includes('receitas_pagas')) {
      sqlPrincipal = sql;
      return { rows: [{ receitas_pagas: 100, despesas_pagas: 40, receitas_pendentes: 0, despesas_pendentes: 0 }] };
    }
    // caixinhas e saldo_inicial de contas usam "as total" e leem rows[0].total
    // direto (sem COALESCE em JS) — precisa de uma linha, não array vazio.
    if (sql.includes('as total')) return { rows: [{ total: 0 }] };
    return { rows: [] }; // cartões, existência de fatura — irrelevantes para este teste
  });

  await db.calcularSaldos('user1@c.us');

  // Bug de produção: só a CASE de despesa tinha "(cartao_id IS NULL OR
  // descricao ILIKE 'Fatura %')" — receita com cartao_id preenchido (ex:
  // estorno sincronizado no cartão) inflava o total sem a despesa
  // correspondente sair. As 4 CASEs (receita/despesa × pago/pendente) devem
  // ter a mesma exclusão agora.
  const ocorrencias = (sqlPrincipal.match(/cartao_id IS NULL OR descricao ILIKE 'Fatura %'/g) || []).length;
  assert.equal(ocorrencias, 4, 'receita e despesa, pagas e pendentes, devem excluir cartão igualmente');
});
