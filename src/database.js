const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS transacoes (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('despesa', 'receita')),
      valor NUMERIC(12,2) NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT,
      data DATE NOT NULL DEFAULT CURRENT_DATE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transacoes_usuario
      ON transacoes(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_transacoes_data
      ON transacoes(data);
    CREATE INDEX IF NOT EXISTS idx_transacoes_tipo
      ON transacoes(tipo);
  `);

  const categoriasPadrao = [
    'Alimentação', 'Transporte', 'Moradia', 'Saúde',
    'Educação', 'Lazer', 'Vestuário', 'Salário',
    'Freelance', 'Investimentos', 'Outros'
  ];

  for (const cat of categoriasPadrao) {
    await pool.query(
      'INSERT INTO categorias (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING',
      [cat]
    );
  }
}

async function adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data) {
  const result = await pool.query(
    `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [usuarioId, tipo, valor, descricao, categoria || 'Outros', data || new Date().toISOString().split('T')[0]]
  );
  return { lastInsertRowid: result.rows[0].id };
}

async function listarTransacoes(usuarioId, tipo, limite) {
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data
     FROM transacoes
     WHERE usuario_id = $1 AND ($2::text IS NULL OR tipo = $2)
     ORDER BY data DESC, id DESC
     LIMIT $3`,
    [usuarioId, tipo, limite || 10]
  );
  return result.rows;
}

async function resumoMensal(usuarioId, mes, ano) {
  const agora = new Date();
  const m = mes || agora.getMonth() + 1;
  const a = ano || agora.getFullYear();
  const mesStr = String(m).padStart(2, '0');
  const inicioMes = `${a}-${mesStr}-01`;
  const fimMes = `${a}-${mesStr}-31`;

  const totaisResult = await pool.query(
    `SELECT
       tipo,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
     GROUP BY tipo`,
    [usuarioId, inicioMes, fimMes]
  );

  const catResult = await pool.query(
    `SELECT
       categoria,
       tipo,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
     GROUP BY categoria, tipo
     ORDER BY total DESC`,
    [usuarioId, inicioMes, fimMes]
  );

  return { mes: m, ano: a, totais: totaisResult.rows, porCategoria: catResult.rows };
}

async function resumoAnual(usuarioId, ano) {
  const a = ano || new Date().getFullYear();

  const result = await pool.query(
    `SELECT
       TO_CHAR(data, 'MM') as mes,
       tipo,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
     GROUP BY mes, tipo
     ORDER BY mes`,
    [usuarioId, `${a}-01-01`, `${a}-12-31`]
  );
  return { ano: a, meses: result.rows };
}

async function excluirTransacao(usuarioId, transacaoId) {
  const result = await pool.query(
    'DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2',
    [transacaoId, usuarioId]
  );
  return { changes: result.rowCount };
}

async function consultarTransacoes(usuarioId, filtros = {}) {
  const { tipo, categoria, dataInicio, dataFim, descricao, limite } = filtros;
  let query = `
    SELECT id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data
    FROM transacoes
    WHERE usuario_id = $1
  `;
  const params = [usuarioId];
  let idx = 2;

  if (tipo) {
    query += ` AND tipo = $${idx++}`;
    params.push(tipo);
  }
  if (categoria) {
    query += ` AND categoria ILIKE $${idx++}`;
    params.push(`%${categoria}%`);
  }
  if (dataInicio) {
    query += ` AND data >= $${idx++}`;
    params.push(dataInicio);
  }
  if (dataFim) {
    query += ` AND data <= $${idx++}`;
    params.push(dataFim);
  }
  if (descricao) {
    query += ` AND descricao ILIKE $${idx++}`;
    params.push(`%${descricao}%`);
  }

  query += ` ORDER BY data DESC, id DESC LIMIT $${idx}`;
  params.push(limite || 20);

  const result = await pool.query(query, params);
  return result.rows;
}

async function consultarTotalTransacoes(usuarioId, filtros = {}) {
  const { tipo, categoria, dataInicio, dataFim, descricao } = filtros;
  let query = `
    SELECT COALESCE(SUM(valor), 0)::float as total, COUNT(*)::int as quantidade
    FROM transacoes
    WHERE usuario_id = $1
  `;
  const params = [usuarioId];
  let idx = 2;

  if (tipo) {
    query += ` AND tipo = $${idx++}`;
    params.push(tipo);
  }
  if (categoria) {
    query += ` AND categoria ILIKE $${idx++}`;
    params.push(`%${categoria}%`);
  }
  if (dataInicio) {
    query += ` AND data >= $${idx++}`;
    params.push(dataInicio);
  }
  if (dataFim) {
    query += ` AND data <= $${idx++}`;
    params.push(dataFim);
  }
  if (descricao) {
    query += ` AND descricao ILIKE $${idx++}`;
    params.push(`%${descricao}%`);
  }

  const result = await pool.query(query, params);
  return result.rows[0];
}

async function listarCategorias() {
  const result = await pool.query('SELECT nome FROM categorias ORDER BY nome');
  return result.rows.map(r => r.nome);
}

module.exports = {
  pool,
  initTables,
  adicionarTransacao,
  listarTransacoes,
  resumoMensal,
  resumoAnual,
  excluirTransacao,
  listarCategorias,
  consultarTransacoes,
  consultarTotalTransacoes,
};
