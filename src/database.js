const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function debugSharedLog(message) {
  if (process.env.DEBUG_SHARED_CONTACTS === '1') {
    console.log(`[SHARED] ${message}`);
  }
}

function normalizarContatoId(input) {
  if (!input) return null;

  let digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.length < 12 || digits.length > 13) return null;
  return `${digits}@c.us`;
}

function gerarVariantesContatoId(input) {
  const normalizado = normalizarContatoId(input);
  if (!normalizado) return [];

  const digits = normalizado.replace(/\D/g, '');
  const candidatos = new Set([normalizado]);

  // BR celular: tolera variação com/sem dígito 9
  if (digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);

    if (local.length === 9 && local.startsWith('9')) {
      candidatos.add(`55${ddd}${local.slice(1)}@c.us`);
    } else if (local.length === 8) {
      candidatos.add(`55${ddd}9${local}@c.us`);
    }
  }

  return [...candidatos];
}

async function resolverUsuarioPrincipal(usuarioId) {
  const variantes = gerarVariantesContatoId(usuarioId);
  if (variantes.length === 0) return usuarioId;

  const result = await pool.query(
    `SELECT usuario_principal_id
     FROM contatos_compartilhados
     WHERE contato_id = ANY($1::text[])
     LIMIT 1`,
    [variantes]
  );
  const principal = result.rows[0]?.usuario_principal_id || usuarioId;
  if (principal !== usuarioId) {
    debugSharedLog(`resolve ${usuarioId} -> ${principal} via [${variantes.join(', ')}]`);
  }
  return principal;
}

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

  // Migração: adicionar numero_usuario (ID sequencial por usuário, visível pro cliente)
  await pool.query(`
    ALTER TABLE transacoes
      ADD COLUMN IF NOT EXISTS numero_usuario INTEGER;
  `);

  // Preencher numero_usuario para registros existentes que não têm
  await pool.query(`
    WITH numbered AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY usuario_id ORDER BY id) as rn
      FROM transacoes
      WHERE numero_usuario IS NULL
    )
    UPDATE transacoes SET numero_usuario = numbered.rn
    FROM numbered WHERE transacoes.id = numbered.id;
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
      dispara_em TIMESTAMPTZ NOT NULL,
      enviado BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_lembretes_gerais_disparo
      ON lembretes_gerais(dispara_em, enviado);
  `);

  // Migração: garantir timezone correto nos lembretes gerais
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'lembretes_gerais'
          AND column_name = 'dispara_em'
          AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE lembretes_gerais
          ALTER COLUMN dispara_em TYPE TIMESTAMPTZ
          USING dispara_em AT TIME ZONE 'America/Sao_Paulo';
      END IF;
    END $$;
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contatos_compartilhados (
      id SERIAL PRIMARY KEY,
      usuario_principal_id TEXT NOT NULL,
      contato_id TEXT NOT NULL UNIQUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK(usuario_principal_id <> contato_id)
    );

    CREATE INDEX IF NOT EXISTS idx_contatos_compartilhados_principal
      ON contatos_compartilhados(usuario_principal_id);
    CREATE INDEX IF NOT EXISTS idx_contatos_compartilhados_contato
      ON contatos_compartilhados(contato_id);
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
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status, numero_usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
     RETURNING id, numero_usuario`,
    [uid, tipo, valor, descricao, categoria || 'Outros', data || new Date().toISOString().split('T')[0], status || 'pago']
  );
  return { lastInsertRowid: result.rows[0].numero_usuario, dbId: result.rows[0].id };
}

async function listarTransacoes(usuarioId, tipo, limite) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
     FROM transacoes
     WHERE usuario_id = $1 AND ($2::text IS NULL OR tipo = $2)
     ORDER BY data DESC, id DESC
     LIMIT $3`,
    [uid, tipo, limite || 10]
  );
  return result.rows;
}

async function resumoMensal(usuarioId, mes, ano) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
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
    [uid, inicioMes, fimMes]
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
    [uid, inicioMes, fimMes]
  );

  return { mes: m, ano: a, totais: totaisResult.rows, porCategoria: catResult.rows };
}

async function resumoAnual(usuarioId, ano) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
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
    [uid, `${a}-01-01`, `${a}-12-31`]
  );
  return { ano: a, meses: result.rows };
}

async function excluirTransacao(usuarioId, numeroUsuario) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    'DELETE FROM transacoes WHERE numero_usuario = $1 AND usuario_id = $2',
    [numeroUsuario, uid]
  );
  return { changes: result.rowCount };
}

async function consultarTransacoes(usuarioId, filtros = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const { tipo, categoria, dataInicio, dataFim, descricao, status, limite } = filtros;
  let query = `
    SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
    FROM transacoes
    WHERE usuario_id = $1
  `;
  const params = [uid];
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
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const { tipo, categoria, dataInicio, dataFim, descricao, status } = filtros;
  let query = `
    SELECT COALESCE(SUM(valor), 0)::float as total, COUNT(*)::int as quantidade
    FROM transacoes
    WHERE usuario_id = $1
  `;
  const params = [uid];
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

async function liquidarTransacao(usuarioId, numeroUsuario) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE transacoes SET status = 'pago'
     WHERE numero_usuario = $1 AND usuario_id = $2 AND status = 'pendente'
     RETURNING numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data`,
    [numeroUsuario, uid]
  );
  return result.rows[0] || null;
}

async function listarPendentes(usuarioId, tipo) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status
     FROM transacoes
     WHERE usuario_id = $1 AND status = 'pendente' AND ($2::text IS NULL OR tipo = $2)
     ORDER BY data ASC, id ASC`,
    [uid, tipo || null]
  );
  return result.rows;
}

async function calcularSaldos(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
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
    [uid]
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
    `SELECT t.id, t.numero_usuario, t.usuario_id, t.tipo, t.valor::float, t.descricao, t.categoria,
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
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO lembretes_gerais (usuario_id, mensagem, dispara_em)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [uid, mensagem, disparaEm]
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
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem,
            TO_CHAR(dispara_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario
     FROM lembretes_gerais
     WHERE usuario_id = $1 AND enviado = FALSE AND dispara_em > NOW()
     ORDER BY dispara_em ASC`,
    [uid]
  );
  return result.rows;
}

// Cancelar lembrete
async function cancelarLembreteGeral(usuarioId, lembreteId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `DELETE FROM lembretes_gerais
     WHERE id = $1 AND usuario_id = $2 AND enviado = FALSE
     RETURNING id, mensagem`,
    [lembreteId, uid]
  );
  return result.rows[0] || null;
}

// Criar lembrete recorrente
async function criarLembreteRecorrente(usuarioId, mensagem, horario, frequencia, diaSemana, diaMes, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO lembretes_recorrentes (usuario_id, mensagem, horario, frequencia, dia_semana, dia_mes, data_fim)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [uid, mensagem, horario, frequencia, diaSemana, diaMes, dataFim]
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
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem, TO_CHAR(horario, 'HH24:MI') as horario, frequencia,
            dia_semana, dia_mes, TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim
     FROM lembretes_recorrentes
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY horario ASC`,
    [uid]
  );
  return result.rows;
}

// Cancelar lembrete recorrente
async function cancelarLembreteRecorrente(usuarioId, lembreteId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE lembretes_recorrentes SET ativo = FALSE
     WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE
     RETURNING id, mensagem, frequencia`,
    [lembreteId, uid]
  );
  return result.rows[0] || null;
}

// Verificar se é o primeiro contato do usuário
async function verificarUsuarioNovo(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  if (uid !== usuarioId) return false;

  const result = await pool.query(
    'SELECT id FROM usuarios WHERE usuario_id = $1',
    [uid]
  );
  return result.rows.length === 0;
}

// Registrar novo usuário
async function registrarUsuario(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `INSERT INTO usuarios (usuario_id, nome)
     VALUES ($1, $2)
     ON CONFLICT (usuario_id) DO UPDATE SET nome = $2`,
    [uid, nome]
  );
}

// Buscar dados do usuário
async function buscarUsuario(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    'SELECT usuario_id, nome, primeiro_contato FROM usuarios WHERE usuario_id = $1',
    [uid]
  );
  return result.rows[0] || null;
}

async function listarCategorias() {
  const result = await pool.query('SELECT nome FROM categorias ORDER BY nome');
  return result.rows.map(r => r.nome);
}

// Limpar todos os dados de um usuário (para testes)
async function limparDadosUsuario(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query('DELETE FROM transacoes WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_enviados WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_gerais WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_recorrentes WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM limites_categoria WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM contatos_compartilhados WHERE usuario_principal_id = $1 OR contato_id = $1', [uid]);
  await pool.query('DELETE FROM usuarios WHERE usuario_id = $1', [uid]);
  return true;
}

// Definir limite de gastos para uma categoria
async function definirLimite(usuarioId, categoria, valorLimite) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, categoria)
     DO UPDATE SET valor_limite = $3, ativo = TRUE
     RETURNING id`,
    [uid, categoria, valorLimite]
  );
  return result.rows[0].id;
}

// Listar limites ativos do usuário
async function listarLimites(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT categoria, valor_limite::float
     FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY categoria`,
    [uid]
  );
  return result.rows;
}

// Remover limite de uma categoria
async function removerLimite(usuarioId, categoria) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE limites_categoria SET ativo = FALSE
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE
     RETURNING id`,
    [uid, categoria]
  );
  return result.rows[0] || null;
}

// Buscar lembretes gerais por período (para agenda)
async function buscarLembretesGeraisPorPeriodo(usuarioId, dataInicio, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem,
            TO_CHAR(dispara_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario,
            TO_CHAR(dispara_em AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') as data_disparo,
            TO_CHAR(dispara_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') as hora
     FROM lembretes_gerais
     WHERE usuario_id = $1 AND enviado = FALSE
       AND dispara_em >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND dispara_em < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'America/Sao_Paulo')
     ORDER BY dispara_em ASC`,
    [uid, dataInicio, dataFim]
  );
  return result.rows;
}

// Verificar limite e gastos de uma categoria no mês atual
async function verificarLimite(usuarioId, categoria) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
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
    [uid, categoria]
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
    [uid, categoria, inicioMes, fimMes]
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

async function vincularContato(usuarioId, contatoId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const variantesContato = gerarVariantesContatoId(contatoId);

  if (variantesContato.length === 0) {
    return { status: 'invalid_contact' };
  }

  const variantesDoUsuario = new Set(gerarVariantesContatoId(uid));
  if (variantesContato.some(v => variantesDoUsuario.has(v))) {
    debugSharedLog(`vinculo rejeitado (self) principal=${uid} contato=${contatoId}`);
    return { status: 'self' };
  }

  const vinculoExistente = await pool.query(
    `SELECT contato_id, usuario_principal_id
     FROM contatos_compartilhados
     WHERE contato_id = ANY($1::text[])`,
    [variantesContato]
  );

  if (vinculoExistente.rows.some(r => r.usuario_principal_id !== uid)) {
    debugSharedLog(`vinculo rejeitado (outro dono) principal=${uid} contato=${contatoId}`);
    return { status: 'linked_to_other' };
  }

  if (vinculoExistente.rows.some(r => r.usuario_principal_id === uid)) {
    debugSharedLog(`vinculo já existente principal=${uid} contato=${contatoId}`);
    return { status: 'already_linked' };
  }

  await pool.query(
    `INSERT INTO contatos_compartilhados (usuario_principal_id, contato_id)
     VALUES ($1, $2)`,
    [uid, variantesContato[0]]
  );

  debugSharedLog(`vinculo criado principal=${uid} contato_salvo=${variantesContato[0]} variantes=[${variantesContato.join(', ')}]`);
  return { status: 'linked' };
}

async function listarContatosCompartilhados(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT contato_id
     FROM contatos_compartilhados
     WHERE usuario_principal_id = $1
     ORDER BY contato_id`,
    [uid]
  );
  return result.rows.map(r => r.contato_id);
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
  buscarLembretesGeraisPorPeriodo,
  vincularContato,
  listarContatosCompartilhados,
  resolverUsuarioPrincipal,
};
