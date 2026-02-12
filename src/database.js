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

  // Migração: adicionar coluna status (compatível com banco existente)
  await pool.query(`
    ALTER TABLE transacoes
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pago'
      CHECK(status IN ('pendente', 'pago'));

    CREATE INDEX IF NOT EXISTS idx_transacoes_status
      ON transacoes(status);
  `);

  // Tabela para controlar lembretes enviados (evitar duplicatas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lembretes_enviados (
      id SERIAL PRIMARY KEY,
      transacao_id INTEGER NOT NULL REFERENCES transacoes(id) ON DELETE CASCADE,
      usuario_id TEXT NOT NULL,
      rodada INTEGER NOT NULL CHECK(rodada IN (1, 2, 3)),
      data_envio DATE NOT NULL DEFAULT CURRENT_DATE,
      enviado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(transacao_id, rodada, data_envio)
    );

    CREATE INDEX IF NOT EXISTS idx_lembretes_data
      ON lembretes_enviados(data_envio);
    CREATE INDEX IF NOT EXISTS idx_lembretes_transacao
      ON lembretes_enviados(transacao_id);
  `);

  // Tabela para lembretes gerais (não financeiros)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lembretes_gerais (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      dispara_em TIMESTAMP NOT NULL,
      enviado BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lembretes_gerais_disparo
      ON lembretes_gerais(dispara_em, enviado);
  `);

  // Tabela para lembretes recorrentes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lembretes_recorrentes (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      horario TIME NOT NULL,
      frequencia TEXT NOT NULL CHECK(frequencia IN ('diario', 'semanal', 'mensal')),
      dia_semana INTEGER CHECK(dia_semana >= 0 AND dia_semana <= 6),
      dia_mes INTEGER CHECK(dia_mes >= 1 AND dia_mes <= 31),
      data_fim DATE,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      ultimo_envio DATE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lembretes_recorrentes_ativo
      ON lembretes_recorrentes(ativo, horario);
  `);

  // Tabela de usuários (controle de primeiro contato e nome)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      primeiro_contato TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_usuarios_usuario_id
      ON usuarios(usuario_id);
  `);

  // Tabela de limites de gastos por categoria
  await pool.query(`
    CREATE TABLE IF NOT EXISTS limites_categoria (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      categoria TEXT NOT NULL,
      valor_limite NUMERIC(12,2) NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(usuario_id, categoria)
    );

    CREATE INDEX IF NOT EXISTS idx_limites_usuario
      ON limites_categoria(usuario_id, ativo);
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

async function adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data, status) {
  const result = await pool.query(
    `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [usuarioId, tipo, valor, descricao, categoria || 'Outros', data || new Date().toISOString().split('T')[0], status || 'pago']
  );
  return { lastInsertRowid: result.rows[0].id };
}

async function listarTransacoes(usuarioId, tipo, limite) {
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
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

  // Calcular o último dia do mês corretamente
  const ultimoDia = new Date(a, m, 0).getDate();
  const mesStr = String(m).padStart(2, '0');
  const inicioMes = `${a}-${mesStr}-01`;
  const fimMes = `${a}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

  const totaisResult = await pool.query(
    `SELECT
       tipo,
       status,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
     GROUP BY tipo, status`,
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
  const { tipo, categoria, dataInicio, dataFim, descricao, status, limite } = filtros;
  let query = `
    SELECT id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
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
  if (status) {
    query += ` AND status = $${idx++}`;
    params.push(status);
  }

  query += ` ORDER BY data DESC, id DESC LIMIT $${idx}`;
  params.push(limite || 20);

  const result = await pool.query(query, params);
  return result.rows;
}

async function consultarTotalTransacoes(usuarioId, filtros = {}) {
  const { tipo, categoria, dataInicio, dataFim, descricao, status } = filtros;
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
  if (status) {
    query += ` AND status = $${idx++}`;
    params.push(status);
  }

  const result = await pool.query(query, params);
  return result.rows[0];
}

async function liquidarTransacao(usuarioId, transacaoId) {
  const result = await pool.query(
    `UPDATE transacoes SET status = 'pago'
     WHERE id = $1 AND usuario_id = $2 AND status = 'pendente'
     RETURNING id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data`,
    [transacaoId, usuarioId]
  );
  return result.rows[0] || null;
}

async function listarPendentes(usuarioId, tipo) {
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
     FROM transacoes
     WHERE usuario_id = $1 AND status = 'pendente' AND ($2::text IS NULL OR tipo = $2)
     ORDER BY data ASC, id ASC`,
    [usuarioId, tipo || null]
  );
  return result.rows;
}

async function calcularSaldos(usuarioId) {
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pago' THEN valor ELSE 0 END), 0)::float as receitas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' THEN valor ELSE 0 END), 0)::float as despesas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pendente' THEN valor ELSE 0 END), 0)::float as receitas_pendentes,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pendente' THEN valor ELSE 0 END), 0)::float as despesas_pendentes,
       COALESCE(SUM(CASE WHEN tipo = 'receita' THEN valor ELSE 0 END), 0)::float as receitas_total,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' THEN valor ELSE 0 END), 0)::float as despesas_total
     FROM transacoes
     WHERE usuario_id = $1`,
    [usuarioId]
  );
  const r = result.rows[0];
  return {
    saldoAtual: r.receitas_pagas - r.despesas_pagas,
    saldoPrevisao: r.receitas_total - r.despesas_total,
    receitasPagas: r.receitas_pagas,
    despesasPagas: r.despesas_pagas,
    receitasPendentes: r.receitas_pendentes,
    despesasPendentes: r.despesas_pendentes,
  };
}

// Buscar transações pendentes que vencem hoje ou já venceram (para lembretes)
async function buscarPendentesParaLembrete(rodada) {
  const result = await pool.query(
    `SELECT t.id, t.usuario_id, t.tipo, t.valor::float, t.descricao, t.categoria,
            TO_CHAR(t.data, 'YYYY-MM-DD') as data
     FROM transacoes t
     WHERE t.status = 'pendente'
       AND t.data <= CURRENT_DATE
       AND NOT EXISTS (
         SELECT 1 FROM lembretes_enviados le
         WHERE le.transacao_id = t.id
           AND le.rodada = $1
           AND le.data_envio = CURRENT_DATE
       )
     ORDER BY t.usuario_id, t.data ASC`,
    [rodada]
  );
  return result.rows;
}

// Registrar que um lembrete foi enviado
async function registrarLembreteEnviado(transacaoId, usuarioId, rodada) {
  await pool.query(
    `INSERT INTO lembretes_enviados (transacao_id, usuario_id, rodada, data_envio)
     VALUES ($1, $2, $3, CURRENT_DATE)
     ON CONFLICT (transacao_id, rodada, data_envio) DO NOTHING`,
    [transacaoId, usuarioId, rodada]
  );
}

// Verificar se a transação já foi paga (para parar lembretes futuros)
async function transacaoAindaPendente(transacaoId) {
  const result = await pool.query(
    `SELECT status FROM transacoes WHERE id = $1`,
    [transacaoId]
  );
  return result.rows[0]?.status === 'pendente';
}

// Criar lembrete geral
async function criarLembreteGeral(usuarioId, mensagem, disparaEm) {
  const result = await pool.query(
    `INSERT INTO lembretes_gerais (usuario_id, mensagem, dispara_em)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [usuarioId, mensagem, disparaEm]
  );
  return result.rows[0].id;
}

// Buscar lembretes que já devem ser disparados
async function buscarLembretesParaDisparar() {
  const result = await pool.query(
    `UPDATE lembretes_gerais
     SET enviado = TRUE
     WHERE enviado = FALSE AND dispara_em <= NOW()
     RETURNING id, usuario_id, mensagem`
  );
  return result.rows;
}

// Listar lembretes pendentes de um usuário
async function listarLembretesGerais(usuarioId) {
  const result = await pool.query(
    `SELECT id, mensagem, TO_CHAR(dispara_em, 'DD/MM HH24:MI') as horario
     FROM lembretes_gerais
     WHERE usuario_id = $1 AND enviado = FALSE AND dispara_em > NOW()
     ORDER BY dispara_em ASC`,
    [usuarioId]
  );
  return result.rows;
}

// Cancelar lembrete
async function cancelarLembreteGeral(usuarioId, lembreteId) {
  const result = await pool.query(
    `DELETE FROM lembretes_gerais
     WHERE id = $1 AND usuario_id = $2 AND enviado = FALSE
     RETURNING id, mensagem`,
    [lembreteId, usuarioId]
  );
  return result.rows[0] || null;
}

// Criar lembrete recorrente
async function criarLembreteRecorrente(usuarioId, mensagem, horario, frequencia, diaSemana, diaMes, dataFim) {
  const result = await pool.query(
    `INSERT INTO lembretes_recorrentes (usuario_id, mensagem, horario, frequencia, dia_semana, dia_mes, data_fim)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [usuarioId, mensagem, horario, frequencia, diaSemana, diaMes, dataFim]
  );
  return result.rows[0].id;
}

// Buscar lembretes recorrentes que devem disparar agora
async function buscarRecorrentesParaDisparar() {
  const result = await pool.query(
    `SELECT id, usuario_id, mensagem, frequencia, dia_semana, dia_mes,
            TO_CHAR(horario, 'HH24:MI') as horario
     FROM lembretes_recorrentes
     WHERE ativo = TRUE
       AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)
       AND (ultimo_envio IS NULL OR ultimo_envio < CURRENT_DATE)
       AND horario <= LOCALTIME
       AND (
         (frequencia = 'diario')
         OR (frequencia = 'semanal' AND dia_semana = EXTRACT(DOW FROM CURRENT_DATE)::int)
         OR (frequencia = 'mensal' AND dia_mes = EXTRACT(DAY FROM CURRENT_DATE)::int)
       )`
  );
  return result.rows;
}

// Marcar recorrente como enviado hoje
async function marcarRecorrenteEnviado(lembreteId) {
  await pool.query(
    `UPDATE lembretes_recorrentes SET ultimo_envio = CURRENT_DATE WHERE id = $1`,
    [lembreteId]
  );
}

// Desativar recorrentes expirados
async function desativarRecorrentesExpirados() {
  await pool.query(
    `UPDATE lembretes_recorrentes SET ativo = FALSE WHERE data_fim < CURRENT_DATE AND ativo = TRUE`
  );
}

// Listar lembretes recorrentes ativos de um usuário
async function listarLembretesRecorrentes(usuarioId) {
  const result = await pool.query(
    `SELECT id, mensagem, TO_CHAR(horario, 'HH24:MI') as horario, frequencia,
            dia_semana, dia_mes, TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim
     FROM lembretes_recorrentes
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY horario ASC`,
    [usuarioId]
  );
  return result.rows;
}

// Cancelar lembrete recorrente
async function cancelarLembreteRecorrente(usuarioId, lembreteId) {
  const result = await pool.query(
    `UPDATE lembretes_recorrentes SET ativo = FALSE
     WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE
     RETURNING id, mensagem, frequencia`,
    [lembreteId, usuarioId]
  );
  return result.rows[0] || null;
}

// Verificar se é o primeiro contato do usuário
async function verificarUsuarioNovo(usuarioId) {
  const result = await pool.query(
    'SELECT id FROM usuarios WHERE usuario_id = $1',
    [usuarioId]
  );
  return result.rows.length === 0;
}

// Registrar novo usuário
async function registrarUsuario(usuarioId, nome) {
  await pool.query(
    `INSERT INTO usuarios (usuario_id, nome)
     VALUES ($1, $2)
     ON CONFLICT (usuario_id) DO UPDATE SET nome = $2`,
    [usuarioId, nome]
  );
}

// Buscar dados do usuário
async function buscarUsuario(usuarioId) {
  const result = await pool.query(
    'SELECT usuario_id, nome, primeiro_contato FROM usuarios WHERE usuario_id = $1',
    [usuarioId]
  );
  return result.rows[0] || null;
}

async function listarCategorias() {
  const result = await pool.query('SELECT nome FROM categorias ORDER BY nome');
  return result.rows.map(r => r.nome);
}

// Limpar todos os dados de um usuário (para testes)
async function limparDadosUsuario(usuarioId) {
  await pool.query('DELETE FROM transacoes WHERE usuario_id = $1', [usuarioId]);
  await pool.query('DELETE FROM lembretes_enviados WHERE usuario_id = $1', [usuarioId]);
  await pool.query('DELETE FROM lembretes_gerais WHERE usuario_id = $1', [usuarioId]);
  await pool.query('DELETE FROM lembretes_recorrentes WHERE usuario_id = $1', [usuarioId]);
  await pool.query('DELETE FROM limites_categoria WHERE usuario_id = $1', [usuarioId]);
  await pool.query('DELETE FROM usuarios WHERE usuario_id = $1', [usuarioId]);
  return true;
}

// Definir limite de gastos para uma categoria
async function definirLimite(usuarioId, categoria, valorLimite) {
  const result = await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, categoria)
     DO UPDATE SET valor_limite = $3, ativo = TRUE
     RETURNING id`,
    [usuarioId, categoria, valorLimite]
  );
  return result.rows[0].id;
}

// Listar limites ativos do usuário
async function listarLimites(usuarioId) {
  const result = await pool.query(
    `SELECT categoria, valor_limite::float
     FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY categoria`,
    [usuarioId]
  );
  return result.rows;
}

// Remover limite de uma categoria
async function removerLimite(usuarioId, categoria) {
  const result = await pool.query(
    `UPDATE limites_categoria SET ativo = FALSE
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE
     RETURNING id`,
    [usuarioId, categoria]
  );
  return result.rows[0] || null;
}

// Verificar limite e gastos de uma categoria no mês atual
async function verificarLimite(usuarioId, categoria) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;

  // Calcular o último dia do mês corretamente
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const mesStr = String(mes).padStart(2, '0');
  const inicioMes = `${ano}-${mesStr}-01`;
  const fimMes = `${ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

  // Buscar limite
  const limiteResult = await pool.query(
    `SELECT valor_limite::float FROM limites_categoria
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE`,
    [usuarioId, categoria]
  );

  if (limiteResult.rows.length === 0) return null;

  const limite = limiteResult.rows[0].valor_limite;

  // Calcular gastos do mês
  const gastosResult = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes
     WHERE usuario_id = $1
       AND categoria = $2
       AND tipo = 'despesa'
       AND data >= $3 AND data <= $4`,
    [usuarioId, categoria, inicioMes, fimMes]
  );

  const gastos = gastosResult.rows[0].total;
  const restante = limite - gastos;
  const percentual = limite > 0 ? (gastos / limite) * 100 : 0;

  return {
    categoria,
    limite,
    gastos,
    restante,
    percentual: Math.round(percentual)
  };
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
  liquidarTransacao,
  listarPendentes,
  calcularSaldos,
  buscarPendentesParaLembrete,
  registrarLembreteEnviado,
  transacaoAindaPendente,
  criarLembreteGeral,
  buscarLembretesParaDisparar,
  listarLembretesGerais,
  cancelarLembreteGeral,
  criarLembreteRecorrente,
  buscarRecorrentesParaDisparar,
  marcarRecorrenteEnviado,
  desativarRecorrentesExpirados,
  listarLembretesRecorrentes,
  cancelarLembreteRecorrente,
  verificarUsuarioNovo,
  registrarUsuario,
  buscarUsuario,
  definirLimite,
  listarLimites,
  removerLimite,
  verificarLimite,
  limparDadosUsuario,
};
