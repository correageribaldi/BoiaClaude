const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', process.env.DB_NAME || 'financeiro.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS transacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('despesa', 'receita')),
      valor REAL NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT,
      data TEXT NOT NULL DEFAULT (date('now')),
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transacoes_usuario
      ON transacoes(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_transacoes_data
      ON transacoes(data);
    CREATE INDEX IF NOT EXISTS idx_transacoes_tipo
      ON transacoes(tipo);
  `);

  // Inserir categorias padrão
  const categoriasPadrao = [
    'Alimentação', 'Transporte', 'Moradia', 'Saúde',
    'Educação', 'Lazer', 'Vestuário', 'Salário',
    'Freelance', 'Investimentos', 'Outros'
  ];

  const insert = db.prepare('INSERT OR IGNORE INTO categorias (nome) VALUES (?)');
  for (const cat of categoriasPadrao) {
    insert.run(cat);
  }
}

function adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data) {
  const stmt = getDb().prepare(`
    INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(usuarioId, tipo, valor, descricao, categoria || 'Outros', data || new Date().toISOString().split('T')[0]);
}

function listarTransacoes(usuarioId, tipo, limite) {
  const stmt = getDb().prepare(`
    SELECT id, tipo, valor, descricao, categoria, data
    FROM transacoes
    WHERE usuario_id = ? AND (? IS NULL OR tipo = ?)
    ORDER BY data DESC, id DESC
    LIMIT ?
  `);
  return stmt.all(usuarioId, tipo, tipo, limite || 10);
}

function resumoMensal(usuarioId, mes, ano) {
  const agora = new Date();
  const m = mes || agora.getMonth() + 1;
  const a = ano || agora.getFullYear();
  const mesStr = String(m).padStart(2, '0');
  const inicioMes = `${a}-${mesStr}-01`;
  const fimMes = `${a}-${mesStr}-31`;

  const stmt = getDb().prepare(`
    SELECT
      tipo,
      SUM(valor) as total,
      COUNT(*) as quantidade
    FROM transacoes
    WHERE usuario_id = ?
      AND data >= ? AND data <= ?
    GROUP BY tipo
  `);
  const totais = stmt.all(usuarioId, inicioMes, fimMes);

  const stmtCat = getDb().prepare(`
    SELECT
      categoria,
      tipo,
      SUM(valor) as total,
      COUNT(*) as quantidade
    FROM transacoes
    WHERE usuario_id = ?
      AND data >= ? AND data <= ?
    GROUP BY categoria, tipo
    ORDER BY total DESC
  `);
  const porCategoria = stmtCat.all(usuarioId, inicioMes, fimMes);

  return { mes: m, ano: a, totais, porCategoria };
}

function resumoAnual(usuarioId, ano) {
  const a = ano || new Date().getFullYear();

  const stmt = getDb().prepare(`
    SELECT
      substr(data, 6, 2) as mes,
      tipo,
      SUM(valor) as total,
      COUNT(*) as quantidade
    FROM transacoes
    WHERE usuario_id = ?
      AND data >= ? AND data <= ?
    GROUP BY mes, tipo
    ORDER BY mes
  `);
  return { ano: a, meses: stmt.all(usuarioId, `${a}-01-01`, `${a}-12-31`) };
}

function excluirTransacao(usuarioId, transacaoId) {
  const stmt = getDb().prepare(`
    DELETE FROM transacoes WHERE id = ? AND usuario_id = ?
  `);
  return stmt.run(transacaoId, usuarioId);
}

function listarCategorias() {
  return getDb().prepare('SELECT nome FROM categorias ORDER BY nome').all().map(r => r.nome);
}

module.exports = {
  getDb,
  adicionarTransacao,
  listarTransacoes,
  resumoMensal,
  resumoAnual,
  excluirTransacao,
  listarCategorias,
};
