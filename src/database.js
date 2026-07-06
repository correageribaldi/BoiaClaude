const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                       // máximo de conexões simultâneas
  idleTimeoutMillis: 30000,      // fecha conexão ociosa após 30s
  connectionTimeoutMillis: 5000, // timeout para obter conexão do pool
  statement_timeout: 15000,      // timeout para queries (15s)
});

pool.on('error', (err) => {
  console.error('⚠️  [POOL] Erro inesperado no pool PostgreSQL:', err.message);
});

// Helper: data de hoje em YYYY-MM-DD no timezone de São Paulo (evita bug UTC do toISOString)
function dataHojeBR() {
  const partes = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }).split('/');
  return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
}

function normalizarDataISO(valor) {
  if (!valor || typeof valor !== 'string') return null;
  const v = valor.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;

  const [ano, mes, dia] = v.split('-').map(Number);
  const dt = new Date(ano, mes - 1, dia);
  if (dt.getFullYear() !== ano || (dt.getMonth() + 1) !== mes || dt.getDate() !== dia) {
    return null;
  }

  return v;
}

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

  // Migração: coluna oculto para lembretes de sistema (despesas/cartões do Finanças em Dia)
  await pool.query(`
    ALTER TABLE lembretes_recorrentes
      ADD COLUMN IF NOT EXISTS oculto BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Migração: marcar lembretes de sistema existentes como ocultos (criados antes da coluna oculto)
  await pool.query(`
    UPDATE lembretes_recorrentes
    SET oculto = TRUE
    WHERE oculto = FALSE
      AND (
        mensagem LIKE '💸 Pagar:%'
        OR mensagem LIKE '💰 Receber:%'
        OR mensagem LIKE '💳 Vencimento fatura%'
      );
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

  // Migração: colunas de persistência de estado de onboarding e fluxo ativo
  await pool.query(`
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS onboarding_estado TEXT;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fluxo_ativo JSONB;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS fluxo_expira TIMESTAMP;
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

  // Migração: coluna parent para hierarquia principal/subcategoria
  await pool.query(`
    ALTER TABLE limites_categoria ADD COLUMN IF NOT EXISTS parent TEXT;
  `);

  // Tabela de categorias principais (por usuário) para distribuição de orçamento
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categorias_principais (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      percentual NUMERIC(5,2) NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(usuario_id, nome)
    );
    CREATE INDEX IF NOT EXISTS idx_catprincipais_usuario
      ON categorias_principais(usuario_id, ativo);
  `);

  // Migração: separar categorias de despesa e receita (bug de categoria cruzada)
  await pool.query(`
    ALTER TABLE categorias_principais ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'despesa' CHECK(tipo IN ('despesa', 'receita', 'ambos'));
    ALTER TABLE limites_categoria ADD COLUMN IF NOT EXISTS tipo TEXT CHECK(tipo IN ('despesa', 'receita', 'ambos'));
  `);

  // Migração idempotente: seed da categoria principal de Receitas + subcategorias
  // para usuários já existentes (usuários novos recebem via inicializarCategoriasPrincipais).
  await pool.query(
    `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem, tipo)
     SELECT DISTINCT usuario_id, $1, 0, 99, 'receita'
     FROM categorias_principais cp
     WHERE NOT EXISTS (
       SELECT 1 FROM categorias_principais cp2
       WHERE cp2.usuario_id = cp.usuario_id AND cp2.nome = $1
     )`,
    [CATEGORIA_PRINCIPAL_RECEITA.nome]
  );

  await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent, tipo)
     SELECT DISTINCT cp.usuario_id, sub.nome, 0, $2, 'receita'
     FROM categorias_principais cp
     CROSS JOIN UNNEST($1::text[]) AS sub(nome)
     WHERE cp.nome = $2
       AND NOT EXISTS (
         SELECT 1 FROM limites_categoria lc
         WHERE lc.usuario_id = cp.usuario_id AND lc.categoria = sub.nome
       )`,
    [SUBCATEGORIAS_RECEITA_PADRAO, CATEGORIA_PRINCIPAL_RECEITA.nome]
  );

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

  // Tabela de regras de recorrência (despesas/receitas fixas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recorrencias (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('receita', 'despesa')),
      valor NUMERIC(12,2) NOT NULL,
      descricao TEXT NOT NULL,
      categoria TEXT,
      frequencia TEXT NOT NULL CHECK (frequencia IN ('diario', 'semanal', 'mensal', 'anual')),
      dia_mes INTEGER CHECK (dia_mes BETWEEN 1 AND 31),
      dia_semana INTEGER CHECK (dia_semana BETWEEN 0 AND 6),
      data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
      data_fim DATE,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_recorrencias_usuario
      ON recorrencias(usuario_id, ativo);
  `);

  // Migração: coluna recorrencia_id em transacoes (link para a regra de origem)
  await pool.query(`
    ALTER TABLE transacoes
      ADD COLUMN IF NOT EXISTS recorrencia_id INTEGER REFERENCES recorrencias(id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transacoes_recorrencia_id
      ON transacoes(recorrencia_id)
      WHERE recorrencia_id IS NOT NULL;
  `);

  // Migração: converter lembretes_recorrentes ocultos (💸/💰/💳) → recorrencias
  await pool.query(`
    DO $$
    DECLARE
      rec RECORD;
      v_tipo TEXT;
      v_descricao TEXT;
      v_valor NUMERIC(12,2);
      v_str TEXT;
    BEGIN
      FOR rec IN
        SELECT * FROM lembretes_recorrentes
        WHERE ativo = TRUE
          AND (
            mensagem LIKE '💸 Pagar:%'
            OR mensagem LIKE '💰 Receber:%'
            OR mensagem LIKE '💳 Vencimento fatura%'
          )
      LOOP
        BEGIN
          IF rec.mensagem LIKE '💰 Receber:%' THEN
            v_tipo := 'receita';
          ELSE
            v_tipo := 'despesa';
          END IF;
          v_str := REGEXP_REPLACE(rec.mensagem, '^[^:]+:\\s*', '');
          v_descricao := SPLIT_PART(v_str, ' - R$ ', 1);
          v_valor := REPLACE(REPLACE(SPLIT_PART(v_str, ' - R$ ', 2), '.', ''), ',', '.')::NUMERIC(12,2);
          IF NOT EXISTS (
            SELECT 1 FROM recorrencias
            WHERE usuario_id = rec.usuario_id
              AND descricao = v_descricao
              AND frequencia = rec.frequencia
              AND dia_mes IS NOT DISTINCT FROM rec.dia_mes
              AND dia_semana IS NOT DISTINCT FROM rec.dia_semana
          ) THEN
            INSERT INTO recorrencias
              (usuario_id, tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, ativo)
            VALUES
              (rec.usuario_id, v_tipo, v_valor, v_descricao, 'Outros',
               rec.frequencia, rec.dia_mes, rec.dia_semana, CURRENT_DATE, rec.ativo);
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'Falha ao migrar lembrete id=%: %', rec.id, SQLERRM;
        END;
      END LOOP;
    END $$;
  `);

  // Tabela de caixinhas de investimento
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caixinhas (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      saldo NUMERIC(12,2) DEFAULT 0,
      meta NUMERIC(12,2),
      tipo TEXT,
      rendimento_mensal NUMERIC(8,4),
      criado_em TIMESTAMP DEFAULT NOW(),
      ativo BOOLEAN DEFAULT TRUE
    );
    CREATE INDEX IF NOT EXISTS idx_caixinhas_usuario_id ON caixinhas(usuario_id);
  `);

  // Tabela de assinaturas (controle de acesso por período de trial/pagamento)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assinaturas (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'trial'
        CHECK(status IN ('trial', 'ativo', 'graca', 'expirado')),
      trial_fim TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      pago_ate DATE,
      order_nsu TEXT,
      link_pagamento TEXT,
      link_criado_em TIMESTAMPTZ,
      avisos_enviados INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_assinaturas_usuario_id ON assinaturas(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_assinaturas_order_nsu ON assinaturas(order_nsu)
      WHERE order_nsu IS NOT NULL;
  `);

  // Migração: coluna pausado para pausar bot em usuário específico
  await pool.query(`
    ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS pausado BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Migração: criar assinaturas para usuários existentes que ainda não têm registro
  // trial_fim = NOW() → já expirado, entram em carência de 5 dias para assinar
  await pool.query(`
    INSERT INTO assinaturas (usuario_id, trial_fim)
    SELECT u.usuario_id, NOW()
    FROM usuarios u
    LEFT JOIN assinaturas a ON a.usuario_id = u.usuario_id
    WHERE a.id IS NULL
    ON CONFLICT (usuario_id) DO NOTHING
  `);

  // Migração: adicionar colunas transaction_nsu e invoice_slug (InfinityPay payment_check)
  await pool.query(`
    ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS transaction_nsu TEXT;
    ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS invoice_slug TEXT;
  `);

  // Tabela de usuários do painel web (usuário/senha)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS painel_usuarios (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_painel_usuarios_username
      ON painel_usuarios(username);
    CREATE INDEX IF NOT EXISTS idx_painel_usuarios_usuario_id
      ON painel_usuarios(usuario_id);
  `);

  // Migração: coluna is_admin em painel_usuarios
  await pool.query(`
    ALTER TABLE painel_usuarios ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Migração: coluna avatar_data em painel_usuarios
  await pool.query(`
    ALTER TABLE painel_usuarios ADD COLUMN IF NOT EXISTS avatar_data TEXT;
  `);

  // Tabela de cupons de desconto/período grátis
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cupons (
      id SERIAL PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL CHECK(tipo IN ('dias_gratis', 'desconto_percent')),
      valor INTEGER NOT NULL,
      uso_maximo INTEGER NOT NULL DEFAULT 1,
      usos INTEGER NOT NULL DEFAULT 0,
      valido_ate DATE,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cupons_codigo ON cupons(codigo);
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

  // Migração: coluna budget_cat para mapear categorias ao orçamento mensal
  await pool.query(`
    ALTER TABLE categorias ADD COLUMN IF NOT EXISTS budget_cat TEXT;
  `);

  // Seed: mapeamento padrão das categorias conhecidas
  const mapeamentoPadrao = [
    ['Alimentação',   'Variáveis'],
    ['Alimentacao',   'Variáveis'],
    ['Transporte',    'Variáveis'],
    ['Moradia',       'Variáveis'],
    ['Saúde',         'Variáveis'],
    ['Saude',         'Variáveis'],
    ['Educação',      'Variáveis'],
    ['Educacao',      'Variáveis'],
    ['Vestuário',     'Variáveis'],
    ['Vestuario',     'Variáveis'],
    ['Compras',       'Variáveis'],
    ['Outros',        'Variáveis'],
    ['Lazer',         'Lazer'],
    ['Investimentos', 'Investimentos'],
    ['Poupança',      'Investimentos'],
    ['Poupanca',      'Investimentos'],
    ['Objetivos',     'Objetivos'],
    ['Salário',       null],
    ['Salario',       null],
    ['Freelance',     null],
  ];
  for (const [nome, budgetCat] of mapeamentoPadrao) {
    await pool.query(
      `UPDATE categorias SET budget_cat = $1 WHERE nome = $2 AND budget_cat IS NULL`,
      [budgetCat, nome]
    );
  }

  // Tabela de cartões de crédito
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cartoes (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      limite_total NUMERIC(12,2),
      dia_fechamento INT,
      dia_vencimento INT,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cartoes_usuario ON cartoes(usuario_id);
  `);

  // Migração: coluna cartao_id em transacoes para rastrear compras no cartão
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS cartao_id INTEGER REFERENCES cartoes(id);
  `);

  // Categoria padrão para faturas de cartão
  await pool.query(`
    INSERT INTO categorias (nome) VALUES ('Fatura') ON CONFLICT (nome) DO NOTHING;
  `);

  // Tabela de lembretes pontuais (substituição de lembretes_gerais, com BullMQ)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','sending','sent','failed','canceled')),
      attempts INT NOT NULL DEFAULT 0,
      locked_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_status_run_at ON reminders(status, run_at);
  `);

  // Tabela de campanhas de feedback
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_campanhas (
      id SERIAL PRIMARY KEY,
      mensagem TEXT NOT NULL,
      filtro_dias_apos_acesso INTEGER,
      total_destinatarios INTEGER NOT NULL DEFAULT 0,
      enviados INTEGER NOT NULL DEFAULT 0,
      erros INTEGER NOT NULL DEFAULT 0,
      finalizado BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Tabela de respostas de feedback
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feedback_respostas (
      id SERIAL PRIMARY KEY,
      campanha_id INTEGER NOT NULL REFERENCES feedback_campanhas(id) ON DELETE CASCADE,
      usuario_id TEXT NOT NULL,
      nome_usuario TEXT,
      enviado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      respondido BOOLEAN NOT NULL DEFAULT FALSE,
      resposta TEXT,
      respondido_em TIMESTAMP,
      UNIQUE(campanha_id, usuario_id)
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_respostas_campanha ON feedback_respostas(campanha_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_respostas_usuario ON feedback_respostas(usuario_id);
  `);

  // Tabela de crons configuráveis pelo admin
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_crons (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      mensagem TEXT NOT NULL,
      frequencia TEXT NOT NULL DEFAULT 'todo_dia',
      horario TEXT DEFAULT '10:00',
      regra TEXT NOT NULL,
      regra_valor INTEGER,
      usuario_ids TEXT[],
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      ultimo_envio TIMESTAMPTZ,
      total_enviados INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migração: trocar expressao_cron → frequencia + horario (caso tabela antiga exista)
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_crons' AND column_name='expressao_cron') THEN
        ALTER TABLE admin_crons DROP COLUMN expressao_cron;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_crons' AND column_name='frequencia') THEN
        ALTER TABLE admin_crons ADD COLUMN frequencia TEXT NOT NULL DEFAULT 'todo_dia';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='admin_crons' AND column_name='horario') THEN
        ALTER TABLE admin_crons ADD COLUMN horario TEXT DEFAULT '10:00';
      END IF;
    END$$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_crons_log (
      id            SERIAL PRIMARY KEY,
      cron_id       INTEGER NOT NULL REFERENCES admin_crons(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'processando',
      total         INTEGER NOT NULL DEFAULT 0,
      enviados      INTEGER NOT NULL DEFAULT 0,
      erros         INTEGER NOT NULL DEFAULT 0,
      iniciado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finalizado_em TIMESTAMPTZ
    );
  `);

  // Migração: coluna ultima_interacao e churned em usuarios (sistema de reativação)
  await pool.query(`
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultima_interacao TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS churned BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // Tabela de log de reativação (controle de etapas enviadas)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reativacao_log (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      etapa INTEGER NOT NULL,
      enviado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(usuario_id, etapa)
    );
    CREATE INDEX IF NOT EXISTS idx_reativacao_log_usuario
      ON reativacao_log(usuario_id);
  `);

  // Tabela de tokens Google Calendar (OAuth 2.0)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_tokens (
      usuario_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expiry_date BIGINT,
      conectado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Coluna para vincular lembretes ao evento no Google Calendar
  await pool.query(`
    ALTER TABLE lembretes_gerais ADD COLUMN IF NOT EXISTS google_event_id TEXT;
    ALTER TABLE lembretes_recorrentes ADD COLUMN IF NOT EXISTS google_event_id TEXT;
  `);

  // ─── Módulo de Contas (Marco 1) ─────────────────────────────────────────────

  // Tabela de contas (Conta Corrente, Poupança, Carteira, etc) por usuário
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      tipo TEXT CHECK(tipo IN ('corrente', 'poupanca', 'carteira', 'investimento', 'outro')),
      saldo_inicial NUMERIC(12,2) NOT NULL DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      padrao BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(usuario_id, nome)
    );
    CREATE INDEX IF NOT EXISTS idx_contas_usuario ON contas(usuario_id, ativo);
  `);

  // Tabela de transferências entre contas (fundação para Marco 3 — sem uso ainda)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transferencias (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      conta_origem_id INTEGER NOT NULL REFERENCES contas(id),
      conta_destino_id INTEGER NOT NULL REFERENCES contas(id),
      valor NUMERIC(12,2) NOT NULL CHECK(valor > 0),
      descricao TEXT,
      data DATE NOT NULL DEFAULT CURRENT_DATE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK(conta_origem_id <> conta_destino_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transferencias_usuario ON transferencias(usuario_id, data);
    CREATE INDEX IF NOT EXISTS idx_transferencias_origem ON transferencias(conta_origem_id);
    CREATE INDEX IF NOT EXISTS idx_transferencias_destino ON transferencias(conta_destino_id);
  `);

  // Migração: coluna conta_id em transacoes (nullable — retrocompatível com os call sites existentes)
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS conta_id INTEGER REFERENCES contas(id);
    CREATE INDEX IF NOT EXISTS idx_transacoes_conta_id ON transacoes(conta_id) WHERE conta_id IS NOT NULL;
  `);

  // Migração idempotente: cria "Conta Principal" para todo usuário que nunca
  // teve nenhuma conta padrão (independente de ter transação ou não),
  // e vincula as transações órfãs (conta_id NULL) a ela.
  await pool.query(`
    INSERT INTO contas (usuario_id, nome, saldo_inicial, padrao)
    SELECT u.usuario_id, 'Conta Principal', 0, TRUE
    FROM usuarios u
    LEFT JOIN contas c ON c.usuario_id = u.usuario_id AND c.padrao = TRUE
    WHERE c.id IS NULL
    ON CONFLICT (usuario_id, nome) DO NOTHING;
  `);
  await pool.query(`
    UPDATE transacoes t
    SET conta_id = c.id
    FROM contas c
    WHERE c.usuario_id = t.usuario_id AND c.padrao = TRUE AND t.conta_id IS NULL;
  `);
}

// ─── Recorrências ────────────────────────────────────────────────────────────

async function criarRecorrencia(usuarioId, tipo, valor, descricao, categoria, frequencia, diaMes, diaSemana, dataInicio, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO recorrencias
       (usuario_id, tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, data_fim)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [uid, tipo, valor, descricao, categoria || 'Outros', frequencia,
     diaMes || null, diaSemana || null,
     dataInicio || dataHojeBR(), dataFim || null]
  );
  return result.rows[0].id;
}

async function listarRecorrencias(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, frequencia,
            dia_mes, dia_semana,
            TO_CHAR(data_inicio, 'YYYY-MM-DD') as data_inicio,
            TO_CHAR(data_fim,    'YYYY-MM-DD') as data_fim
     FROM recorrencias
     WHERE usuario_id = $1
       AND ativo = TRUE
       AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)
     ORDER BY dia_mes ASC NULLS LAST, dia_semana ASC NULLS LAST, descricao ASC`,
    [uid]
  );
  return result.rows;
}

// Calcula ocorrências de regras recorrentes num período — sem I/O, pura memória
function calcularOcorrenciasNoPerodo(regras, dataInicioObj, dataFimObj) {
  const ocorrencias = [];
  for (const regra of regras) {
    const regraInicio = regra.data_inicio ? new Date(regra.data_inicio + 'T12:00:00') : null;
    const regraFim    = regra.data_fim    ? new Date(regra.data_fim    + 'T12:00:00') : null;
    const d = new Date(dataInicioObj);
    d.setHours(12, 0, 0, 0);
    const fim = new Date(dataFimObj);
    fim.setHours(12, 0, 0, 0);
    while (d <= fim) {
      if (regraInicio && d < regraInicio) { d.setDate(d.getDate() + 1); continue; }
      if (regraFim    && d > regraFim)    { break; }
      let dispara = false;
      if      (regra.frequencia === 'diario')  dispara = true;
      else if (regra.frequencia === 'semanal') dispara = (d.getDay() === regra.dia_semana);
      else if (regra.frequencia === 'mensal')  dispara = (d.getDate() === regra.dia_mes);
      else if (regra.frequencia === 'anual')   dispara = (d.getDate() === regra.dia_mes && (d.getMonth() + 1) === regra.dia_semana);
      if (dispara) {
        const yyyy = d.getFullYear();
        const mm   = String(d.getMonth() + 1).padStart(2, '0');
        const dd   = String(d.getDate()).padStart(2, '0');
        ocorrencias.push({
          tipo:           regra.tipo,
          valor:          regra.valor,
          descricao:      regra.descricao,
          categoria:      regra.categoria,
          data:           `${yyyy}-${mm}-${dd}`,
          recorrencia_id: regra.id,
          status:         'projetado',
        });
      }
      d.setDate(d.getDate() + 1);
    }
  }
  return ocorrencias;
}

// Cria transação com vínculo à regra de recorrência
async function adicionarTransacaoComRecorrencia(usuarioId, tipo, valor, descricao, categoria, data, status, recorrenciaId, cartaoId = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status, recorrencia_id, cartao_id, numero_usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
     RETURNING id, numero_usuario`,
    [uid, tipo, valor, descricao, categoria || 'Outros',
     data || dataHojeBR(), status || 'pago', recorrenciaId || null, cartaoId || null]
  );
  return { lastInsertRowid: result.rows[0].numero_usuario, dbId: result.rows[0].id };
}

// ─────────────────────────────────────────────────────────────────────────────

async function adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data, status, cartaoId = null, contaId = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status, cartao_id, conta_id, numero_usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
       (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
     RETURNING id, numero_usuario`,
    [uid, tipo, valor, descricao, categoria || 'Outros', data || dataHojeBR(), status || 'pago', cartaoId || null, contaId || null]
  );
  return { lastInsertRowid: result.rows[0].numero_usuario, dbId: result.rows[0].id };
}

async function adicionarTransacoesParcelas(usuarioId, valor, descricao, categoria, dataBase, cartaoId, parcelas, contaId = null) {
  const valorParcela = Math.round((valor / parcelas) * 100) / 100;
  const valorUltima  = Math.round((valor - valorParcela * (parcelas - 1)) * 100) / 100;
  const ids = [];
  for (let i = 0; i < parcelas; i++) {
    const d = new Date(dataBase + 'T12:00:00');
    d.setMonth(d.getMonth() + i);
    const dataStr = d.toISOString().slice(0, 10);
    const valorAtual = i === parcelas - 1 ? valorUltima : valorParcela;
    const status = i === 0 ? 'pago' : 'pendente';
    const result = await adicionarTransacao(
      usuarioId, 'despesa', valorAtual,
      `${descricao} (${i + 1}/${parcelas})`,
      categoria, dataStr, status, cartaoId, contaId
    );
    ids.push(result);
  }
  return ids;
}

async function listarTransacoes(usuarioId, tipo, limite) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, recorrencia_id
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

  // Compras no cartão excluídas do resumo da conta corrente (cartao_id IS NULL)
  // evitando double-counting com o pagamento da fatura (que é uma despesa separada)
  const totaisResult = await pool.query(
    `SELECT
       tipo,
       status,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
       AND (cartao_id IS NULL OR tipo = 'receita')
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
       AND (cartao_id IS NULL OR tipo = 'receita')
     GROUP BY categoria, tipo
     ORDER BY total DESC`,
    [uid, inicioMes, fimMes]
  );

  const atrasadasResult = await pool.query(
    `SELECT tipo, COUNT(*)::int as quantidade, SUM(valor)::float as total
     FROM transacoes
     WHERE usuario_id = $1
       AND status = 'pendente'
       AND data >= $2 AND data <= $3
       AND data < CURRENT_DATE
     GROUP BY tipo`,
    [uid, inicioMes, fimMes]
  );

  // Merge recorrências projetadas para o mês selecionado (evita dupla contagem)
  const regras = await listarRecorrencias(uid);
  const totais = [...totaisResult.rows];
  const porCategoria = [...catResult.rows];
  const atrasadas = [...atrasadasResult.rows];

  if (regras.length > 0) {
    const inicioMesObj = new Date(a, m - 1, 1);
    const fimMesObj    = new Date(a, m, 0);
    const ocorrencias  = calcularOcorrenciasNoPerodo(regras, inicioMesObj, fimMesObj);
    if (ocorrencias.length > 0) {
      const ids    = [...new Set(ocorrencias.map(o => o.recorrencia_id))];
      const anoMes = `${a}-${mesStr}`;
      const existRes = await pool.query(
        `SELECT DISTINCT recorrencia_id FROM transacoes
         WHERE usuario_id = $1
           AND recorrencia_id = ANY($2::int[])
           AND TO_CHAR(data, 'YYYY-MM') = $3`,
        [uid, ids, anoMes]
      );
      const jaTemTransacao = new Set(existRes.rows.map(row => row.recorrencia_id));
      const hoje = dataHojeBR();

      for (const o of ocorrencias) {
        if (jaTemTransacao.has(o.recorrencia_id)) continue;

        // Adicionar à lista de totais como pendente
        const existingTotais = totais.find(t => t.tipo === o.tipo && t.status === 'pendente');
        if (existingTotais) {
          existingTotais.total += o.valor;
          existingTotais.quantidade += 1;
        } else {
          totais.push({ tipo: o.tipo, status: 'pendente', total: o.valor, quantidade: 1 });
        }

        // Adicionar à lista por categoria
        const catEx = porCategoria.find(c => c.tipo === o.tipo && c.categoria === (o.categoria || 'Outros'));
        if (catEx) {
          catEx.total += o.valor;
          catEx.quantidade += 1;
        } else {
          porCategoria.push({ tipo: o.tipo, categoria: o.categoria || 'Outros', total: o.valor, quantidade: 1 });
        }

        // Se data já passou → atrasada
        if (o.data < hoje) {
          const atrasadaEx = atrasadas.find(at => at.tipo === o.tipo);
          if (atrasadaEx) {
            atrasadaEx.total += o.valor;
            atrasadaEx.quantidade += 1;
          } else {
            atrasadas.push({ tipo: o.tipo, quantidade: 1, total: o.valor });
          }
        }
      }
    }
  }

  return { mes: m, ano: a, totais, porCategoria, atrasadas };
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

async function buscarTransacoesPorDescricao(usuarioId, query, tipo) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const params = [uid, `%${query}%`];
  let tipoClause = '';
  if (tipo === 'despesa' || tipo === 'receita') {
    tipoClause = ` AND tipo = $3`;
    params.push(tipo);
  }
  const result = await pool.query(
    `SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, recorrencia_id
     FROM transacoes
     WHERE usuario_id = $1 AND descricao ILIKE $2${tipoClause}
     ORDER BY data DESC, id DESC
     LIMIT 10`,
    params
  );
  return result.rows;
}

async function atualizarTransacao(usuarioId, numeroUsuario, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['valor', 'data', 'descricao', 'categoria', 'conta_id'];
  if (!camposPermitidos.includes(campo)) throw new Error(`Campo inválido: ${campo}`);
  const result = await pool.query(
    `UPDATE transacoes SET ${campo} = $1
     WHERE numero_usuario = $2 AND usuario_id = $3
     RETURNING numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, cartao_id, conta_id`,
    [novoValor, numeroUsuario, uid]
  );
  return result.rows[0] || null;
}

async function buscarTransacaoPorId(usuarioId, id) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT numero_usuario as id, tipo, valor::float, descricao, categoria,
            TO_CHAR(data, 'YYYY-MM-DD') as data, status, recorrencia_id, cartao_id, conta_id
     FROM transacoes WHERE numero_usuario = $1 AND usuario_id = $2`,
    [id, uid]
  );
  return result.rows[0] || null;
}

async function atualizarRecorrencia(usuarioId, recorrenciaId, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['valor', 'descricao', 'categoria', 'dia_mes', 'dia_semana', 'frequencia'];
  if (!camposPermitidos.includes(campo)) throw new Error(`Campo inválido para recorrência: ${campo}`);
  const result = await pool.query(
    `UPDATE recorrencias SET ${campo} = $1
     WHERE id = $2 AND usuario_id = $3 AND ativo = TRUE
     RETURNING id, tipo, valor::float, descricao, categoria, frequencia, dia_mes, dia_semana,
               TO_CHAR(data_inicio, 'YYYY-MM-DD') as data_inicio,
               TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim`,
    [novoValor, recorrenciaId, uid]
  );
  return result.rows[0] || null;
}

async function buscarRecorrenciaPorId(usuarioId, recorrenciaId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, frequencia, dia_mes, dia_semana,
            TO_CHAR(data_inicio, 'YYYY-MM-DD') as data_inicio,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim
     FROM recorrencias
     WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE`,
    [recorrenciaId, uid]
  );
  return result.rows[0] || null;
}

async function buscarRecorrenciasPorDescricao(usuarioId, descricao) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, frequencia, dia_mes, dia_semana,
            TO_CHAR(data_inicio, 'YYYY-MM-DD') as data_inicio,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim
     FROM recorrencias
     WHERE usuario_id = $1 AND ativo = TRUE
       AND LOWER(descricao) LIKE '%' || LOWER($2) || '%'
     ORDER BY descricao ASC`,
    [uid, descricao]
  );
  return result.rows;
}

async function desativarRecorrencia(usuarioId, recorrenciaId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `UPDATE recorrencias SET ativo = FALSE WHERE id = $1 AND usuario_id = $2`,
    [recorrenciaId, uid]
  );
  await pool.query(
    `DELETE FROM transacoes WHERE recorrencia_id = $1 AND usuario_id = $2 AND status = 'pendente'`,
    [recorrenciaId, uid]
  );
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
  const { tipo, categoria, dataInicio, dataFim, descricao, status, limite, recorrente } = filtros;
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);

  if (dataInicio && !dataInicioValida) {
    console.warn(`[DB] consultarTransacoes ignorou dataInicio invalida: "${dataInicio}" (uid=${uid})`);
  }
  if (dataFim && !dataFimValida) {
    console.warn(`[DB] consultarTransacoes ignorou dataFim invalida: "${dataFim}" (uid=${uid})`);
  }

  let query = `
    SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, recorrencia_id, cartao_id, conta_id
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
  if (dataInicioValida) {
    query += ` AND data >= $${idx++}`;
    params.push(dataInicioValida);
  }
  if (dataFimValida) {
    query += ` AND data <= $${idx++}`;
    params.push(dataFimValida);
  }
  if (descricao) {
    query += ` AND descricao ILIKE $${idx++}`;
    params.push(`%${descricao}%`);
  }
  if (status) {
    query += ` AND status = $${idx++}`;
    params.push(status);
  }
  if (recorrente) {
    query += ` AND recorrencia_id IS NOT NULL`;
  }

  query += ` ORDER BY data DESC, id DESC LIMIT $${idx}`;
  params.push(limite || 20);

  const result = await pool.query(query, params);
  return result.rows;
}

async function consultarTotalTransacoes(usuarioId, filtros = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const { tipo, categoria, dataInicio, dataFim, descricao, status } = filtros;
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);

  if (dataInicio && !dataInicioValida) {
    console.warn(`[DB] consultarTotalTransacoes ignorou dataInicio invalida: "${dataInicio}" (uid=${uid})`);
  }
  if (dataFim && !dataFimValida) {
    console.warn(`[DB] consultarTotalTransacoes ignorou dataFim invalida: "${dataFim}" (uid=${uid})`);
  }

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
  if (dataInicioValida) {
    query += ` AND data >= $${idx++}`;
    params.push(dataInicioValida);
  }
  if (dataFimValida) {
    query += ` AND data <= $${idx++}`;
    params.push(dataFimValida);
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

// Liquidar por ID interno do banco (usado ao confirmar lembretes)
async function liquidarTransacaoPorId(transacaoId) {
  const result = await pool.query(
    `UPDATE transacoes SET status = 'pago'
     WHERE id = $1 AND status = 'pendente'
     RETURNING numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data`,
    [transacaoId]
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

  // 1. Saldo atual (histórico completo de pagos) + pendentes de transações explícitas do mês
  // Compras no cartão (cartao_id IS NOT NULL) são excluídas: não saem da conta corrente diretamente
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pago' THEN valor ELSE 0 END), 0)::float as receitas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %') THEN valor ELSE 0 END), 0)::float as despesas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pendente'
         AND EXTRACT(YEAR  FROM data) = EXTRACT(YEAR  FROM CURRENT_DATE)
         AND EXTRACT(MONTH FROM data) = EXTRACT(MONTH FROM CURRENT_DATE)
         THEN valor ELSE 0 END), 0)::float as receitas_pendentes,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pendente'
         AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
         AND EXTRACT(YEAR  FROM data) = EXTRACT(YEAR  FROM CURRENT_DATE)
         AND EXTRACT(MONTH FROM data) = EXTRACT(MONTH FROM CURRENT_DATE)
         THEN valor ELSE 0 END), 0)::float as despesas_pendentes
     FROM transacoes
     WHERE usuario_id = $1`,
    [uid]
  );
  const r = result.rows[0];
  const saldoAtual = r.receitas_pagas - r.despesas_pagas;

  // 2. Recorrências do mês atual que ainda não têm transação (pendente ou paga)
  const regras = await listarRecorrencias(uid);
  let receitasRecorrentes = 0;
  let despesasRecorrentes = 0;
  if (regras.length > 0) {
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const fimMes    = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);
    const ocorrencias = calcularOcorrenciasNoPerodo(regras, inicioMes, fimMes);
    if (ocorrencias.length > 0) {
      const ids = [...new Set(ocorrencias.map(o => o.recorrencia_id))];
      const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
      const existRes = await pool.query(
        `SELECT DISTINCT recorrencia_id FROM transacoes
         WHERE usuario_id = $1
           AND recorrencia_id = ANY($2::int[])
           AND TO_CHAR(data, 'YYYY-MM') = $3`,
        [uid, ids, anoMes]
      );
      const jaTemTransacao = new Set(existRes.rows.map(row => row.recorrencia_id));
      for (const o of ocorrencias) {
        if (!jaTemTransacao.has(o.recorrencia_id)) {
          if (o.tipo === 'receita') receitasRecorrentes += o.valor;
          else despesasRecorrentes += o.valor;
        }
      }
    }
  }

  const caixRes = await pool.query(
    `SELECT COALESCE(SUM(saldo), 0)::float as total FROM caixinhas WHERE usuario_id = $1 AND ativo = TRUE`,
    [uid]
  );
  const totalCaixinhas = caixRes.rows[0].total;

  // 3. Projeção de faturas de cartão do mês atual (parcelas pendentes que não têm fatura criada)
  const anoMesHoje = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const cartoesRes = await pool.query(
    `SELECT id FROM cartoes WHERE usuario_id = $1`, [uid]
  );
  let faturaCartaoProjetada = 0;
  for (const cartao of cartoesRes.rows) {
    // Verificar se já existe transação de fatura neste mês para este cartão
    const faturaExiste = await pool.query(
      `SELECT 1 FROM transacoes
       WHERE usuario_id = $1 AND cartao_id = $2 AND descricao ILIKE 'Fatura %'
         AND TO_CHAR(data, 'YYYY-MM') = $3 LIMIT 1`,
      [uid, cartao.id, anoMesHoje]
    );
    if (faturaExiste.rows.length > 0) continue; // fatura já criada, já está em despesas_pendentes

    const projMap = await projetarFaturasCartao(cartao.id);
    if (projMap[anoMesHoje]) faturaCartaoProjetada += projMap[anoMesHoje];
  }

  const receitasPendentes = r.receitas_pendentes + receitasRecorrentes;
  const despesasPendentes = r.despesas_pendentes + despesasRecorrentes + faturaCartaoProjetada;

  // 4. Saldo inicial das contas ativas do usuário (módulo de Contas — Marco 1)
  const saldoInicialRes = await pool.query(
    `SELECT COALESCE(SUM(saldo_inicial), 0)::float as total FROM contas WHERE usuario_id = $1 AND ativo = TRUE`,
    [uid]
  );
  const saldoInicialContas = saldoInicialRes.rows[0].total;
  const saldoAtualComContas = saldoAtual + saldoInicialContas;

  return {
    saldoAtual: saldoAtualComContas,
    saldoPrevisao: saldoAtualComContas + receitasPendentes - despesasPendentes,
    receitasPagas:    r.receitas_pagas,
    despesasPagas:    r.despesas_pagas,
    receitasPendentes,
    despesasPendentes,
    totalCaixinhas,
    patrimonio: saldoAtualComContas + totalCaixinhas,
  };
}

// Calcula o saldo de cada conta ativa do usuário.
// Transações com conta_id NULL (histórico anterior ao módulo de Contas) contam
// para a conta marcada como padrão (fallback histórico).
// Inclui o efeito das transferências (Marco 3): entra como destino, sai como origem.
// O agregado total do usuário (calcularSaldos) não muda com transferências — elas
// vivem em tabela própria e nunca tocam `transacoes`, então a soma líquida entre
// contas do mesmo usuário é sempre zero no total.
async function calcularSaldosPorConta(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT
       c.id,
       c.nome,
       c.tipo,
       (
         c.saldo_inicial
         + COALESCE((
             SELECT SUM(CASE WHEN t.tipo = 'receita' THEN t.valor ELSE -t.valor END)
             FROM transacoes t
             WHERE t.usuario_id = $1
               AND t.status = 'pago'
               AND (
                 t.conta_id = c.id
                 OR (t.conta_id IS NULL AND c.padrao = TRUE)
               )
           ), 0)
         + COALESCE((
             SELECT SUM(tr.valor) FROM transferencias tr
             WHERE tr.usuario_id = $1 AND tr.conta_destino_id = c.id
           ), 0)
         - COALESCE((
             SELECT SUM(tr.valor) FROM transferencias tr
             WHERE tr.usuario_id = $1 AND tr.conta_origem_id = c.id
           ), 0)
       )::float as saldo
     FROM contas c
     WHERE c.usuario_id = $1 AND c.ativo = TRUE
     ORDER BY c.padrao DESC, c.nome ASC`,
    [uid]
  );
  return result.rows;
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

// Buscar transações pendentes que foram lembradas hoje (fallback para confirmação sem estado em memória)
async function buscarPendentesLembradosHoje(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT DISTINCT t.id, t.tipo, t.valor::float, t.descricao
     FROM transacoes t
     JOIN lembretes_enviados le ON le.transacao_id = t.id
     WHERE t.usuario_id = $1
       AND t.status = 'pendente'
       AND le.data_envio = CURRENT_DATE
     ORDER BY t.id ASC`,
    [uid]
  );
  return result.rows;
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
async function criarLembreteRecorrente(usuarioId, mensagem, horario, frequencia, diaSemana, diaMes, dataFim, oculto = false) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  // Se o horário agendado já passou hoje, define ultimo_envio = hoje para evitar
  // disparo imediato — o lembrete só disparará na próxima ocorrência.
  const result = await pool.query(
    `INSERT INTO lembretes_recorrentes
       (usuario_id, mensagem, horario, frequencia, dia_semana, dia_mes, data_fim, oculto, ultimo_envio)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $3::time <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::time
            THEN (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
            ELSE NULL END)
     RETURNING id`,
    [uid, mensagem, horario, frequencia, diaSemana, diaMes, dataFim, oculto]
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
       AND (data_fim IS NULL OR data_fim >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
       AND (ultimo_envio IS NULL OR ultimo_envio < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
       AND horario <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::time
       AND (
         (frequencia = 'diario')
         OR (frequencia = 'semanal' AND dia_semana = EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int)
         OR (frequencia = 'mensal' AND dia_mes = EXTRACT(DAY FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::int)
       )`
  );
  return result.rows;
}

// Marcar recorrente como enviado hoje
async function marcarRecorrenteEnviado(lembreteId) {
  await pool.query(
    `UPDATE lembretes_recorrentes SET ultimo_envio = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date WHERE id = $1`,
    [lembreteId]
  );
}

// Desativar recorrentes expirados
async function desativarRecorrentesExpirados() {
  await pool.query(
    `UPDATE lembretes_recorrentes SET ativo = FALSE WHERE data_fim < (NOW() AT TIME ZONE 'America/Sao_Paulo')::date AND ativo = TRUE`
  );
}

// Listar lembretes recorrentes ativos de um usuário (exclui os de sistema pelo padrão da mensagem)
async function listarLembretesRecorrentes(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem, TO_CHAR(horario, 'HH24:MI') as horario, frequencia,
            dia_semana, dia_mes, TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim
     FROM lembretes_recorrentes
     WHERE usuario_id = $1 AND ativo = TRUE AND oculto = FALSE
       AND mensagem NOT LIKE '💸 Pagar:%'
       AND mensagem NOT LIKE '💰 Receber:%'
       AND mensagem NOT LIKE '💳 Vencimento fatura%'
     ORDER BY horario ASC`,
    [uid]
  );
  return result.rows;
}

// Listar lembretes recorrentes de sistema — usados para projetar meses futuros na agenda
// Detectados pelo padrão da mensagem (independe do campo oculto)
async function listarLembretesRecorrentesSistema(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem, frequencia, dia_semana, dia_mes
     FROM lembretes_recorrentes
     WHERE usuario_id = $1 AND ativo = TRUE
       AND (
         mensagem LIKE '💸 Pagar:%'
         OR mensagem LIKE '💰 Receber:%'
         OR mensagem LIKE '💳 Vencimento fatura%'
       )
     ORDER BY dia_mes ASC NULLS LAST`,
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
  // Garante que todo usuário tenha ao menos a "Conta Principal" (padrão), sem depender
  // apenas da migração de boot — cobre o caso de usuário 100% novo (sem transações).
  await pool.query(
    `INSERT INTO contas (usuario_id, nome, saldo_inicial, padrao)
     VALUES ($1, 'Conta Principal', 0, TRUE)
     ON CONFLICT (usuario_id, nome) DO NOTHING`,
    [uid]
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

// Persistência de estado de onboarding no banco
async function salvarOnboardingEstadoDB(usuarioId, estado) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `UPDATE usuarios SET onboarding_estado = $1 WHERE usuario_id = $2`,
    [estado, uid]
  );
}

async function buscarOnboardingEstadoDB(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT onboarding_estado FROM usuarios WHERE usuario_id = $1`, [uid]
  );
  return res.rows[0]?.onboarding_estado || null;
}

// Persistência de fluxo ativo (ponto zero) no banco
async function salvarFluxoAtivoDB(usuarioId, dados) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const expira = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h
  const { expiraEm, ...dadosSemExpira } = dados;
  await pool.query(
    `UPDATE usuarios SET fluxo_ativo = $1, fluxo_expira = $2 WHERE usuario_id = $3`,
    [JSON.stringify(dadosSemExpira), expira, uid]
  );
}

async function buscarFluxoAtivoDB(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT fluxo_ativo, fluxo_expira FROM usuarios WHERE usuario_id = $1`, [uid]
  );
  const row = res.rows[0];
  if (!row?.fluxo_ativo) return null;
  if (new Date() > new Date(row.fluxo_expira)) {
    pool.query(
      `UPDATE usuarios SET fluxo_ativo = NULL, fluxo_expira = NULL WHERE usuario_id = $1`, [uid]
    );
    return null;
  }
  return row.fluxo_ativo;
}

async function limparFluxoAtivoDB(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `UPDATE usuarios SET fluxo_ativo = NULL, fluxo_expira = NULL, onboarding_estado = NULL WHERE usuario_id = $1`,
    [uid]
  );
}

async function listarCategorias() {
  const result = await pool.query('SELECT nome FROM categorias ORDER BY nome');
  return result.rows.map(r => r.nome);
}

// Retorna categorias formatadas para o prompt da IA: "Principal(sub1, sub2), Principal2(sub3)"
// Parametrizado por tipo (despesa/receita) — filtra categorias principais e subcategorias
// cujo tipo bata com o pedido ou seja 'ambos'. Default 'despesa' preserva comportamento
// anterior para call sites que ainda não passam tipo.
async function listarCategoriasParaIA(usuarioId, tipo = 'despesa') {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const catsPrincipais = await pool.query(
    `SELECT id, nome, percentual::float, ordem
     FROM categorias_principais
     WHERE usuario_id = $1 AND ativo = TRUE AND (tipo = $2 OR tipo = 'ambos')
     ORDER BY ordem, nome`,
    [uid, tipo]
  );
  if (catsPrincipais.rows.length === 0) {
    // Fallback: retorna categorias antigas se não tem categorias principais
    return (await listarCategorias()).join(', ');
  }

  // tipo NULL = subcategoria legada (criada antes da separação despesa/receita) → trata como despesa
  const subs = await pool.query(
    `SELECT categoria, parent FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE AND parent IS NOT NULL
       AND (tipo = $2 OR tipo = 'ambos' OR (tipo IS NULL AND $2 = 'despesa'))
     ORDER BY parent, categoria`,
    [uid, tipo]
  );

  const subMap = {};
  for (const s of subs.rows) {
    if (!subMap[s.parent]) subMap[s.parent] = [];
    subMap[s.parent].push(s.categoria);
  }

  const partes = [];
  for (const cp of catsPrincipais.rows) {
    const filhas = subMap[cp.nome] || [];
    if (filhas.length > 0) {
      partes.push(`${cp.nome}(${filhas.join(', ')})`);
    } else {
      partes.push(cp.nome);
    }
  }
  return partes.join(', ');
}

// Retorna array plano de nomes de subcategoria (ou categoria principal, se não tiver
// subcategorias) do usuário, filtrado por tipo — usado para popular <select> no painel web.
// Mesma fonte de dados usada pela IA (categorias_principais/limites_categoria), diferente
// da tabela global legada "categorias".
async function listarSubcategoriasPorTipo(usuarioId, tipo = 'despesa') {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const catsPrincipais = await pool.query(
    `SELECT nome FROM categorias_principais
     WHERE usuario_id = $1 AND ativo = TRUE AND (tipo = $2 OR tipo = 'ambos')
     ORDER BY ordem, nome`,
    [uid, tipo]
  );
  if (catsPrincipais.rows.length === 0) {
    return await listarCategorias();
  }

  const subs = await pool.query(
    `SELECT categoria, parent FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE AND parent IS NOT NULL
       AND (tipo = $2 OR tipo = 'ambos' OR (tipo IS NULL AND $2 = 'despesa'))
     ORDER BY parent, categoria`,
    [uid, tipo]
  );

  const subMap = {};
  for (const s of subs.rows) {
    if (!subMap[s.parent]) subMap[s.parent] = [];
    subMap[s.parent].push(s.categoria);
  }

  const nomes = [];
  for (const cp of catsPrincipais.rows) {
    const filhas = subMap[cp.nome] || [];
    if (filhas.length > 0) {
      nomes.push(...filhas);
    } else {
      nomes.push(cp.nome);
    }
  }
  return nomes;
}

// Limpar todos os dados de um usuário (para testes)
async function limparDadosUsuario(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  // transacoes tem FK para recorrencias, cartoes e contas: deletar primeiro
  await pool.query('DELETE FROM transacoes WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM recorrencias WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM cartoes WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_enviados WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_gerais WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM lembretes_recorrentes WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM limites_categoria WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM caixinhas WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM contatos_compartilhados WHERE usuario_principal_id = $1 OR contato_id = $1', [uid]);
  await pool.query('DELETE FROM transferencias WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM contas WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM usuarios WHERE usuario_id = $1', [uid]);
  return true;
}

// Definir limite de gastos para uma categoria (principal ou subcategoria)
async function definirLimite(usuarioId, categoria, valorLimite, parent = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id, categoria)
     DO UPDATE SET valor_limite = $3, ativo = TRUE, parent = $4
     RETURNING id`,
    [uid, categoria, valorLimite, parent]
  );
  return result.rows[0].id;
}

// Listar limites ativos do usuário
async function listarLimites(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT categoria, valor_limite::float, parent
     FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY parent NULLS FIRST, categoria`,
    [uid]
  );
  return result.rows;
}

// Listar limites agrupados: principais + subcategorias
async function listarLimitesComSub(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  // Buscar limites existentes
  const result = await pool.query(
    `SELECT categoria, valor_limite::float, parent
     FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY parent NULLS FIRST, categoria`,
    [uid]
  );

  // Buscar categorias principais do usuário (podem não ter limite em limites_categoria)
  const catsPrincipais = await listarCategoriasPrincipais(usuarioId);

  // Agrupar: {categoria, valor_limite, subs: [{categoria, valor_limite}]}
  const principaisMap = {};
  const subMap = {};

  // Primeiro: garantir que todas as categorias principais existam
  for (const cp of catsPrincipais) {
    principaisMap[cp.nome] = { categoria: cp.nome, valor_limite: 0, subs: [] };
  }

  for (const r of result.rows) {
    if (!r.parent) {
      if (principaisMap[r.categoria]) {
        principaisMap[r.categoria].valor_limite = r.valor_limite;
      } else {
        principaisMap[r.categoria] = { categoria: r.categoria, valor_limite: r.valor_limite, subs: [] };
      }
    } else {
      if (!subMap[r.parent]) subMap[r.parent] = [];
      subMap[r.parent].push({ categoria: r.categoria, valor_limite: r.valor_limite });
    }
  }

  const principais = Object.values(principaisMap);
  for (const p of principais) {
    p.subs = subMap[p.categoria] || [];
  }
  return principais;
}

// Salvar limites em batch (para o painel)
async function salvarLimitesBatch(usuarioId, limites) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  for (const l of limites) {
    await pool.query(
      `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id, categoria)
       DO UPDATE SET valor_limite = $3, ativo = TRUE, parent = $4`,
      [uid, l.categoria, l.valor_limite, l.parent || null]
    );
  }
}

// Buscar salário (receitas fixas) do mês atual
async function buscarSalarioUsuario(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const agora = new Date();
  const mesStr = String(agora.getMonth() + 1).padStart(2, '0');
  const inicioMes = `${agora.getFullYear()}-${mesStr}-01`;
  const ultimoDia = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
  const fimMes = `${agora.getFullYear()}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;
  const result = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes
     WHERE usuario_id = $1 AND tipo = 'receita' AND data >= $2 AND data <= $3`,
    [uid, inicioMes, fimMes]
  );
  return result.rows[0].total;
}

// Criar subcategoria vinculada a uma categoria principal (valor_limite começa em 0)
async function criarSubcategoria(usuarioId, nome, parent) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (usuario_id, categoria)
     DO UPDATE SET ativo = TRUE, parent = $3
     RETURNING id`,
    [uid, nome.trim(), parent.trim()]
  );
  return result.rows[0].id;
}

// Excluir subcategoria (desativar)
async function excluirSubcategoria(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE limites_categoria SET ativo = FALSE
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE AND parent IS NOT NULL
     RETURNING id`,
    [uid, nome.trim()]
  );
  return result.rows[0] || null;
}

// Garantir que uma subcategoria existe vinculada a uma principal (auto-criar se não existe)
// tipo: 'despesa' (default, preserva comportamento anterior) ou 'receita'.
async function garantirSubcategoria(usuarioId, subcategoria, parent, tipo = 'despesa') {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  // Verifica se já existe
  const existing = await pool.query(
    `SELECT id FROM limites_categoria
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE`,
    [uid, subcategoria.trim()]
  );
  if (existing.rows.length > 0) return;

  // Calcular saldo livre da categoria principal (limite total - soma das subs existentes)
  const parentLimit = await pool.query(
    `SELECT valor_limite::float FROM limites_categoria
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE AND parent IS NULL`,
    [uid, parent.trim()]
  );
  const limiteParent = parentLimit.rows.length > 0 ? parentLimit.rows[0].valor_limite : 0;

  const subsExistentes = await pool.query(
    `SELECT COALESCE(SUM(valor_limite), 0)::float AS total FROM limites_categoria
     WHERE usuario_id = $1 AND parent = $2 AND ativo = TRUE`,
    [uid, parent.trim()]
  );
  const totalSubsAlocado = subsExistentes.rows[0].total;
  const saldoLivre = Math.max(0, limiteParent - totalSubsAlocado);

  await pool.query(
    `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent, tipo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (usuario_id, categoria)
     DO UPDATE SET ativo = TRUE, parent = $4, valor_limite = $3, tipo = $5`,
    [uid, subcategoria.trim(), saldoLivre, parent.trim(), tipo]
  );
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
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);

  if (!dataInicioValida || !dataFimValida) {
    console.warn(`[DB] buscarLembretesGeraisPorPeriodo recebeu periodo invalido: inicio="${dataInicio}" fim="${dataFim}" (uid=${uid})`);
    return [];
  }

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
    [uid, dataInicioValida, dataFimValida]
  );
  return result.rows;
}

// Projeta lembretes recorrentes ativos dentro de um mês (para agenda do painel)
async function buscarLembretesRecorrentesPorMes(usuarioId, ano, mes) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem, TO_CHAR(horario, 'HH24:MI') as horario,
            frequencia, dia_semana, dia_mes,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim
     FROM lembretes_recorrentes
     WHERE usuario_id = $1 AND ativo = TRUE AND oculto = FALSE
       AND (data_fim IS NULL OR data_fim >= make_date($2, $3, 1))
     ORDER BY horario ASC`,
    [uid, ano, mes]
  );

  const mesStr = String(mes).padStart(2, '0');
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const ocorrencias = [];

  for (const r of result.rows) {
    for (let dia = 1; dia <= ultimoDia; dia++) {
      const date = new Date(ano, mes - 1, dia);
      let dispara = false;

      if      (r.frequencia === 'diario')  dispara = true;
      else if (r.frequencia === 'semanal') dispara = (date.getDay() === r.dia_semana);
      else if (r.frequencia === 'mensal')  dispara = (dia === r.dia_mes);

      if (!dispara) continue;
      if (r.data_fim) {
        const fim = new Date(r.data_fim + 'T23:59:59');
        if (date > fim) continue;
      }

      const diaStr = String(dia).padStart(2, '0');
      ocorrencias.push({
        id: `R${r.id}`,
        mensagem: r.mensagem,
        horario: `${diaStr}/${mesStr} ${r.horario}`,
        data_disparo: `${ano}-${mesStr}-${diaStr}`,
        hora: r.horario,
        recorrente: true,
      });
    }
  }

  return ocorrencias;
}

// Verificar limite de uma subcategoria individual (parent != NULL)
async function verificarLimiteSub(usuarioId, categoriaSub) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const mesStr = String(mes).padStart(2, '0');
  const inicioMes = `${ano}-${mesStr}-01`;
  const fimMes = `${ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

  const limiteResult = await pool.query(
    `SELECT valor_limite::float, parent FROM limites_categoria
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE AND parent IS NOT NULL`,
    [uid, categoriaSub]
  );
  if (limiteResult.rows.length === 0) return null;

  const limite = limiteResult.rows[0].valor_limite;
  const gastosResult = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes
     WHERE usuario_id = $1 AND tipo = 'despesa'
       AND data >= $2 AND data <= $3
       AND categoria = $4`,
    [uid, inicioMes, fimMes, categoriaSub]
  );
  const gastos = gastosResult.rows[0].total;
  const restante = limite - gastos;
  const percentual = limite > 0 ? (gastos / limite) * 100 : 0;

  return {
    categoria: categoriaSub,
    limite,
    limiteEfetivo: limite,
    gastos,
    restante,
    percentual: Math.round(percentual),
    proporcional: false,
    diasMes: ultimoDia,
    diasUsuario: ultimoDia,
  };
}

// Verificar limite e gastos de uma categoria no mês atual
// subcategorias: array de categorias de transação que compõem esse bucket (ex: ['Alimentacao','Transporte'])
async function verificarLimite(usuarioId, categoria, subcategorias = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;

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

  // Verificar se o usuário começou no mês atual (pro-rata)
  const usuarioResult = await pool.query(
    `SELECT primeiro_contato FROM usuarios WHERE usuario_id = $1`,
    [uid]
  );
  let limiteEfetivo = limite;
  let proporcional = false;
  let diasMes = ultimoDia;
  let diasUsuario = ultimoDia;

  if (usuarioResult.rows.length > 0) {
    const primeiroContato = new Date(usuarioResult.rows[0].primeiro_contato);
    const anoInicio = primeiroContato.getFullYear();
    const mesInicio = primeiroContato.getMonth() + 1;
    const diaInicio = primeiroContato.getDate();

    if (anoInicio === ano && mesInicio === mes && diaInicio > 1) {
      // Usuário começou no mês atual após o dia 1 → pro-rata
      diasUsuario = ultimoDia - diaInicio + 1;
      limiteEfetivo = Math.round(limite * diasUsuario / ultimoDia);
      proporcional = true;
    }
  }

  // Calcular gastos do mês — soma todas as subcategorias do bucket
  const cats = subcategorias && subcategorias.length > 0 ? subcategorias : [categoria];
  const placeholders = cats.map((_, i) => `$${i + 4}`).join(', ');
  const gastosResult = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes
     WHERE usuario_id = $1
       AND tipo = 'despesa'
       AND data >= $2 AND data <= $3
       AND categoria IN (${placeholders})`,
    [uid, inicioMes, fimMes, ...cats]
  );

  const gastos = gastosResult.rows[0].total;
  const restante = limiteEfetivo - gastos;
  const percentual = limiteEfetivo > 0 ? (gastos / limiteEfetivo) * 100 : 0;

  return {
    categoria,
    limite,
    limiteEfetivo,
    gastos,
    restante,
    percentual: Math.round(percentual),
    proporcional,
    diasMes,
    diasUsuario,
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

async function obterVinculoSecundario(usuarioId) {
  const variantes = gerarVariantesContatoId(usuarioId);
  if (variantes.length === 0) return null;

  const result = await pool.query(
    `SELECT usuario_principal_id, contato_id
     FROM contatos_compartilhados
     WHERE contato_id = ANY($1::text[])
     LIMIT 1`,
    [variantes]
  );

  return result.rows[0] || null;
}

// === PAINEL WEB ===

async function criarUsuarioPainel(usuarioId, username, passwordHash) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `INSERT INTO painel_usuarios (usuario_id, username, password_hash)
     VALUES ($1, $2, $3)`,
    [uid, username.toLowerCase().trim(), passwordHash]
  );
}

async function buscarUsuarioPainelPorUsername(username) {
  const result = await pool.query(
    `SELECT id, usuario_id, username, password_hash, is_admin
     FROM painel_usuarios WHERE username = $1 LIMIT 1`,
    [username.toLowerCase().trim()]
  );
  return result.rows[0] || null;
}

async function buscarUsuarioPainelPorUserId(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, username, is_admin, avatar_data FROM painel_usuarios WHERE usuario_id = $1 LIMIT 1`,
    [uid]
  );
  return result.rows[0] || null;
}

async function salvarAvatarPainel(usuarioId, avatarData) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `UPDATE painel_usuarios SET avatar_data = $1 WHERE usuario_id = $2`,
    [avatarData, uid]
  );
}

async function usernameDisponivel(username) {
  const result = await pool.query(
    `SELECT id FROM painel_usuarios WHERE username = $1 LIMIT 1`,
    [username.toLowerCase().trim()]
  );
  return result.rows.length === 0;
}

async function criarCategoria(nome, budgetCat = null) {
  await pool.query(
    'INSERT INTO categorias (nome, budget_cat) VALUES ($1, $2) ON CONFLICT (nome) DO NOTHING',
    [nome.trim(), budgetCat]
  );
}

async function buscarBudgetCat(categoria) {
  const result = await pool.query(
    'SELECT budget_cat FROM categorias WHERE nome = $1',
    [categoria]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].budget_cat || null;
}

async function salvarBudgetCat(categoria, budgetCat) {
  await pool.query(
    `INSERT INTO categorias (nome, budget_cat) VALUES ($1, $2)
     ON CONFLICT (nome) DO UPDATE SET budget_cat = $2`,
    [categoria.trim(), budgetCat]
  );
}

// ── Categorias Principais (por usuário) ─────────────────────────────────────

const CATEGORIAS_PRINCIPAIS_PADRAO = [
  { nome: 'Despesas Fixas',    percentual: 50, ordem: 1 },
  { nome: 'Variáveis',         percentual: 20, ordem: 2 },
  { nome: 'Lazer',             percentual: 10, ordem: 3 },
  { nome: 'Investimentos',     percentual: 15, ordem: 4 },
  { nome: 'Objetivos',         percentual:  5, ordem: 5 },
];

// Categoria principal de receita: lista simples, sem percentual/distribuição de orçamento
// (não participa do budget 50/30/20 — só agrupa subcategorias de receita).
const CATEGORIA_PRINCIPAL_RECEITA = { nome: 'Receitas', percentual: 0, ordem: 99 };
const SUBCATEGORIAS_RECEITA_PADRAO = ['Salário', 'Freelance', 'Investimentos (retorno)', 'Outras Receitas'];

async function listarCategoriasPrincipais(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, nome, percentual::float, ordem
     FROM categorias_principais
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY ordem, nome`,
    [uid]
  );
  return result.rows;
}

async function inicializarCategoriasPrincipais(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  // Só inicializa se o usuário não tem nenhuma
  const check = await pool.query(
    'SELECT id FROM categorias_principais WHERE usuario_id = $1 LIMIT 1',
    [uid]
  );
  if (check.rows.length > 0) return;
  for (const cat of CATEGORIAS_PRINCIPAIS_PADRAO) {
    await pool.query(
      `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem, tipo)
       VALUES ($1, $2, $3, $4, 'despesa') ON CONFLICT (usuario_id, nome) DO NOTHING`,
      [uid, cat.nome, cat.percentual, cat.ordem]
    );
  }

  await pool.query(
    `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem, tipo)
     VALUES ($1, $2, $3, $4, 'receita') ON CONFLICT (usuario_id, nome) DO NOTHING`,
    [uid, CATEGORIA_PRINCIPAL_RECEITA.nome, CATEGORIA_PRINCIPAL_RECEITA.percentual, CATEGORIA_PRINCIPAL_RECEITA.ordem]
  );
  for (const sub of SUBCATEGORIAS_RECEITA_PADRAO) {
    await pool.query(
      `INSERT INTO limites_categoria (usuario_id, categoria, valor_limite, parent, tipo)
       VALUES ($1, $2, 0, $3, 'receita') ON CONFLICT (usuario_id, categoria) DO NOTHING`,
      [uid, sub, CATEGORIA_PRINCIPAL_RECEITA.nome]
    );
  }
}

// Busca o tipo (despesa/receita/ambos) cadastrado para uma categoria/subcategoria pelo nome.
// Procura primeiro em limites_categoria (subcategoria), depois em categorias_principais.
// Retorna null se a categoria ainda não existe (categoria nova, ainda não cadastrada).
async function buscarTipoCategoria(usuarioId, nomeCategoria) {
  if (!nomeCategoria) return null;
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const nome = nomeCategoria.trim();

  const sub = await pool.query(
    `SELECT tipo FROM limites_categoria
     WHERE usuario_id = $1 AND categoria = $2 AND ativo = TRUE`,
    [uid, nome]
  );
  if (sub.rows.length > 0) return sub.rows[0].tipo;

  const principal = await pool.query(
    `SELECT tipo FROM categorias_principais
     WHERE usuario_id = $1 AND nome = $2 AND ativo = TRUE`,
    [uid, nome]
  );
  if (principal.rows.length > 0) return principal.rows[0].tipo;

  return null;
}

async function criarCategoriaPrincipal(usuarioId, nome, percentual, ordem = 99) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id, nome)
     DO UPDATE SET percentual = $3, ordem = $4, ativo = TRUE
     RETURNING id, nome, percentual::float, ordem`,
    [uid, nome.trim(), percentual, ordem]
  );
  return result.rows[0];
}

async function atualizarCategoriaPrincipal(usuarioId, id, nome, percentual) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE categorias_principais SET nome = $3, percentual = $4
     WHERE id = $2 AND usuario_id = $1 AND ativo = TRUE
     RETURNING id, nome, percentual::float, ordem`,
    [uid, id, nome.trim(), percentual]
  );
  return result.rows[0] || null;
}

async function excluirCategoriaPrincipal(usuarioId, id) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE categorias_principais SET ativo = FALSE
     WHERE id = $2 AND usuario_id = $1 AND ativo = TRUE
     RETURNING id, nome`,
    [uid, id]
  );
  return result.rows[0] || null;
}

async function salvarCategoriasPrincipaisBatch(usuarioId, categorias) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  for (const cat of categorias) {
    if (cat.id) {
      await pool.query(
        `UPDATE categorias_principais SET nome = $3, percentual = $4, ordem = $5
         WHERE id = $2 AND usuario_id = $1 AND ativo = TRUE`,
        [uid, cat.id, cat.nome.trim(), cat.percentual, cat.ordem || 0]
      );
    } else {
      await pool.query(
        `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (usuario_id, nome)
         DO UPDATE SET percentual = $3, ordem = $4, ativo = TRUE`,
        [uid, cat.nome.trim(), cat.percentual, cat.ordem || 0]
      );
    }
  }
}

async function excluirCategoria(nome) {
  const result = await pool.query(
    'DELETE FROM categorias WHERE nome = $1 RETURNING nome',
    [nome]
  );
  return result.rows[0] || null;
}

async function removerContatoCompartilhado(usuarioId, contatoId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const variantesContato = gerarVariantesContatoId(contatoId);
  if (variantesContato.length === 0) return null;

  const result = await pool.query(
    `DELETE FROM contatos_compartilhados
     WHERE usuario_principal_id = $1
       AND contato_id = ANY($2::text[])
     RETURNING contato_id`,
    [uid, variantesContato]
  );

  return result.rows[0] || null;
}

async function criarCaixinha(usuarioId, nome, saldo, meta, tipo, rendimentoMensal) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `INSERT INTO caixinhas (usuario_id, nome, saldo, meta, tipo, rendimento_mensal)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uid, nome, saldo || 0, meta || null, tipo || null, rendimentoMensal || null]
  );
}

async function listarCaixinhas(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, nome, saldo::float, meta::float, tipo, rendimento_mensal::float
     FROM caixinhas WHERE usuario_id = $1 AND ativo = TRUE ORDER BY criado_em ASC`,
    [uid]
  );
  return result.rows;
}

// Busca caixinha(s) por nome: tenta match exato primeiro, depois parcial
async function buscarCaixinhasPorNome(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  // Exato (case-insensitive)
  let result = await pool.query(
    `SELECT id, nome, saldo::float, meta::float, tipo, rendimento_mensal::float
     FROM caixinhas WHERE usuario_id = $1 AND ativo = TRUE AND LOWER(nome) = LOWER($2)`,
    [uid, nome]
  );
  if (result.rows.length > 0) return result.rows;

  // Parcial
  result = await pool.query(
    `SELECT id, nome, saldo::float, meta::float, tipo, rendimento_mensal::float
     FROM caixinhas WHERE usuario_id = $1 AND ativo = TRUE AND nome ILIKE $2
     ORDER BY criado_em ASC`,
    [uid, `%${nome}%`]
  );
  return result.rows;
}

async function atualizarCaixinha(usuarioId, caixinhaId, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['nome', 'saldo', 'meta', 'tipo', 'rendimento_mensal'];
  if (!camposPermitidos.includes(campo)) return null;
  const res = await pool.query(
    `UPDATE caixinhas SET ${campo} = $1 WHERE id = $2 AND usuario_id = $3 AND ativo = TRUE
     RETURNING id, nome, saldo::float, meta::float, tipo, rendimento_mensal::float`,
    [novoValor, caixinhaId, uid]
  );
  return res.rows[0] || null;
}

async function excluirCaixinha(usuarioId, caixinhaId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `UPDATE caixinhas SET ativo = FALSE WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE
     RETURNING id, nome`,
    [caixinhaId, uid]
  );
  return res.rows[0] || null;
}

async function atualizarLembreteGeral(usuarioId, lembreteId, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['mensagem', 'dispara_em'];
  if (!camposPermitidos.includes(campo)) return null;
  const res = await pool.query(
    `UPDATE lembretes_gerais SET ${campo} = $1
     WHERE id = $2 AND usuario_id = $3 AND enviado = FALSE
     RETURNING id, mensagem, TO_CHAR(dispara_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario`,
    [novoValor, lembreteId, uid]
  );
  return res.rows[0] || null;
}

async function atualizarLembreteRecorrente(usuarioId, lembreteId, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['mensagem', 'horario', 'frequencia', 'dia_semana', 'dia_mes'];
  if (!camposPermitidos.includes(campo)) return null;
  const res = await pool.query(
    `UPDATE lembretes_recorrentes SET ${campo} = $1
     WHERE id = $2 AND usuario_id = $3 AND ativo = TRUE
     RETURNING id, mensagem, TO_CHAR(horario, 'HH24:MI') as horario, frequencia, dia_semana, dia_mes`,
    [novoValor, lembreteId, uid]
  );
  return res.rows[0] || null;
}

// Adiciona valor ao saldo de uma caixinha pelo ID
async function adicionarSaldoCaixinha(caixinhaId, valor) {
  const result = await pool.query(
    `UPDATE caixinhas SET saldo = saldo + $1 WHERE id = $2
     RETURNING id, nome, saldo::float, meta::float, tipo`,
    [valor, caixinhaId]
  );
  return result.rows[0] || null;
}

// ─── Assinaturas ─────────────────────────────────────────────────────────────

async function criarAssinatura(usuarioId, trialDias = 30) {
  await pool.query(
    `INSERT INTO assinaturas (usuario_id, trial_fim)
     VALUES ($1, NOW() + ($2 || ' days')::INTERVAL)
     ON CONFLICT (usuario_id) DO NOTHING`,
    [usuarioId, trialDias]
  );
}

async function buscarAssinatura(usuarioId) {
  const result = await pool.query(
    `SELECT id, usuario_id, status, trial_fim, pago_ate::text as pago_ate,
            order_nsu, link_pagamento, link_criado_em, avisos_enviados, pausado
     FROM assinaturas WHERE usuario_id = $1`,
    [usuarioId]
  );
  return result.rows[0] || null;
}

async function pausarUsuario(usuarioId) {
  await pool.query(
    `UPDATE assinaturas SET pausado = TRUE, atualizado_em = NOW() WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function retomarUsuario(usuarioId) {
  await pool.query(
    `UPDATE assinaturas SET pausado = FALSE, atualizado_em = NOW() WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function buscarAssinaturasPendentes() {
  const result = await pool.query(
    `SELECT id, usuario_id, status, order_nsu, transaction_nsu, invoice_slug, link_criado_em
     FROM assinaturas
     WHERE status IN ('graca', 'expirado') AND order_nsu IS NOT NULL`
  );
  return result.rows;
}

async function buscarAssinaturaPorOrderNSU(orderNsu) {
  const result = await pool.query(
    `SELECT id, usuario_id, status, trial_fim, pago_ate::text as pago_ate, order_nsu
     FROM assinaturas WHERE order_nsu = $1`,
    [orderNsu]
  );
  return result.rows[0] || null;
}

async function atualizarStatusAssinatura(usuarioId, status) {
  await pool.query(
    `UPDATE assinaturas SET status = $1, atualizado_em = NOW() WHERE usuario_id = $2`,
    [status, usuarioId]
  );
}

async function ativarAssinatura(usuarioId, pagoAte) {
  await pool.query(
    `UPDATE assinaturas
     SET status = 'ativo', pago_ate = $1, avisos_enviados = 0,
         order_nsu = NULL, link_pagamento = NULL, link_criado_em = NULL,
         atualizado_em = NOW()
     WHERE usuario_id = $2`,
    [pagoAte, usuarioId]
  );
}

async function incrementarAvisosAssinatura(usuarioId) {
  await pool.query(
    `UPDATE assinaturas
     SET avisos_enviados = avisos_enviados + 1, atualizado_em = NOW()
     WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function salvarLinkAssinatura(usuarioId, orderNsu, link) {
  await pool.query(
    `UPDATE assinaturas
     SET order_nsu = $1, link_pagamento = $2, link_criado_em = NOW(), atualizado_em = NOW()
     WHERE usuario_id = $3`,
    [orderNsu, link, usuarioId]
  );
}

// Salva transaction_nsu e invoice_slug recebidos do webhook para uso no payment_check
async function salvarTransacaoAssinatura(orderNsu, transactionNsu, invoiceSlug) {
  await pool.query(
    `UPDATE assinaturas
     SET transaction_nsu = $1, invoice_slug = $2, atualizado_em = NOW()
     WHERE order_nsu = $3`,
    [transactionNsu || null, invoiceSlug || null, orderNsu]
  );
}

// ─── Admin ────────────────────────────────────────────────────────────────────

async function listarUsuariosNaoPagantes(filtro = 'todos') {
  let condicaoStatus;
  if (filtro === 'trial')         condicaoStatus = `a.status = 'trial'`;
  else if (filtro === 'expirado') condicaoStatus = `a.status = 'expirado'`;
  else if (filtro === 'graca')    condicaoStatus = `a.status = 'graca'`;
  else                            condicaoStatus = `a.status IN ('trial', 'graca', 'expirado')`;

  // DISTINCT ON evita duplicatas por usuario_id (ex: duas assinaturas no banco)
  // AND pago_ate check exclui quem de fato pagou, independente do status armazenado
  // AND NOT LIKE '%@lid' exclui dispositivos vinculados (WhatsApp multi-device) — não recebem mensagens
  const result = await pool.query(`
    SELECT DISTINCT ON (u.usuario_id)
      u.usuario_id, u.nome, a.status, a.trial_fim, a.pago_ate
    FROM usuarios u
    JOIN assinaturas a ON a.usuario_id = u.usuario_id
    WHERE ${condicaoStatus}
      AND (a.pago_ate IS NULL OR a.pago_ate::date < CURRENT_DATE)
      AND u.usuario_id NOT LIKE '%@lid'
    ORDER BY u.usuario_id, a.atualizado_em DESC
  `);
  return result.rows;
}

async function atualizarNomeUsuario(usuarioId, nome) {
  await pool.query(
    `UPDATE usuarios SET nome = $1 WHERE usuario_id = $2`,
    [nome, usuarioId]
  );
}

async function listarUsuariosAdmin() {
  const result = await pool.query(`
    SELECT u.usuario_id, u.nome, u.primeiro_contato,
           a.status, a.trial_fim, a.pago_ate, a.order_nsu, a.atualizado_em,
           COALESCE(a.pausado, FALSE) as pausado
    FROM usuarios u
    LEFT JOIN assinaturas a ON a.usuario_id = u.usuario_id
    ORDER BY u.primeiro_contato DESC
  `);
  return result.rows;
}

// ─── Cupons ───────────────────────────────────────────────────────────────────

async function criarCupom(codigo, tipo, valor, usoMaximo, validoAte) {
  await pool.query(
    `INSERT INTO cupons (codigo, tipo, valor, uso_maximo, valido_ate)
     VALUES ($1, $2, $3, $4, $5)`,
    [codigo.toUpperCase().trim(), tipo, valor, usoMaximo || 1, validoAte || null]
  );
}

async function buscarCupom(codigo) {
  const result = await pool.query(
    `SELECT * FROM cupons WHERE codigo = $1`,
    [codigo.toUpperCase().trim()]
  );
  return result.rows[0] || null;
}

async function incrementarUsoCupom(id) {
  await pool.query(`UPDATE cupons SET usos = usos + 1 WHERE id = $1`, [id]);
}

async function listarCupons() {
  const result = await pool.query(
    `SELECT id, codigo, tipo, valor, uso_maximo, usos, valido_ate, ativo, criado_em
     FROM cupons ORDER BY criado_em DESC`
  );
  return result.rows;
}

// ─── Cartões de crédito ───────────────────────────────────────────────────────

async function criarCartao(usuarioId, nome, limiteTotal, diaFechamento, diaVencimento) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `INSERT INTO cartoes (usuario_id, nome, limite_total, dia_fechamento, dia_vencimento)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [uid, nome, limiteTotal || null, diaFechamento || null, diaVencimento || null]
  );
  return res.rows[0]?.id || null;
}

async function listarCartoes(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, nome, limite_total::float, dia_fechamento, dia_vencimento
     FROM cartoes WHERE usuario_id = $1 ORDER BY nome`,
    [uid]
  );
  return res.rows;
}

async function buscarCartoesPorNome(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, nome, limite_total::float, dia_fechamento, dia_vencimento
     FROM cartoes WHERE usuario_id = $1 AND nome ILIKE $2`,
    [uid, `%${nome}%`]
  );
  return res.rows;
}

// ─── Contas (Marco 2) ──────────────────────────────────────────────────────────

async function criarConta(usuarioId, nome, tipo = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  try {
    const res = await pool.query(
      `INSERT INTO contas (usuario_id, nome, tipo)
       VALUES ($1, $2, $3)
       RETURNING id, nome, tipo, saldo_inicial::float, ativo, padrao`,
      [uid, nome, tipo || null]
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '23505') { // unique_violation (usuario_id, nome)
      throw new Error(`Você já tem uma conta chamada "${nome}".`);
    }
    throw err;
  }
}

async function listarContas(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, nome, tipo, saldo_inicial::float, ativo, padrao
     FROM contas WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY padrao DESC, nome ASC`,
    [uid]
  );
  return res.rows;
}

async function buscarContasPorNome(usuarioId, nomeParcial) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, nome, tipo, saldo_inicial::float, ativo, padrao
     FROM contas WHERE usuario_id = $1 AND ativo = TRUE AND nome ILIKE $2
     ORDER BY nome ASC`,
    [uid, `%${nomeParcial}%`]
  );
  return res.rows;
}

// ─── Transferências entre contas (Marco 3) ─────────────────────────────────────
// Saldo negativo na conta origem é PERMITIDO (mesmo comportamento de despesa comum).
// Aqui só validamos que as contas existem e pertencem ao usuário — nada de saldo.

async function criarTransferencia(usuarioId, contaOrigemId, contaDestinoId, valor, descricao = null, data = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  if (contaOrigemId === contaDestinoId) {
    throw new Error('Conta de origem e destino não podem ser a mesma.');
  }

  try {
    const res = await pool.query(
      `INSERT INTO transferencias (usuario_id, conta_origem_id, conta_destino_id, valor, descricao, data)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE))
       RETURNING id, conta_origem_id, conta_destino_id, valor::float, descricao,
                 TO_CHAR(data, 'YYYY-MM-DD') as data, criado_em`,
      [uid, contaOrigemId, contaDestinoId, valor, descricao || null, data || null]
    );
    return res.rows[0];
  } catch (err) {
    if (err.code === '23503') { // foreign_key_violation (conta_origem_id/conta_destino_id inexistente)
      throw new Error('Uma das contas informadas não existe.');
    }
    if (err.code === '23514') { // check_violation (mesma conta, ou valor <= 0)
      throw new Error('Transferência inválida: verifique o valor e as contas informadas.');
    }
    throw err;
  }
}

async function listarTransferencias(usuarioId, limite = 20) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT
       tr.id,
       tr.valor::float,
       tr.descricao,
       TO_CHAR(tr.data, 'YYYY-MM-DD') as data,
       tr.conta_origem_id,
       co.nome as conta_origem_nome,
       tr.conta_destino_id,
       cd.nome as conta_destino_nome
     FROM transferencias tr
     JOIN contas co ON co.id = tr.conta_origem_id
     JOIN contas cd ON cd.id = tr.conta_destino_id
     WHERE tr.usuario_id = $1
     ORDER BY tr.data DESC, tr.id DESC
     LIMIT $2`,
    [uid, limite]
  );
  return res.rows;
}

// Atualiza nome/tipo de uma conta. Bloqueia edição se a conta for a padrão.
async function atualizarConta(usuarioId, contaId, nome, tipo) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const contaRes = await pool.query(
    `SELECT id, padrao FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE`,
    [contaId, uid]
  );
  if (contaRes.rows.length === 0) return null;
  if (contaRes.rows[0].padrao) {
    throw new Error('A conta padrão não pode ser editada.');
  }

  try {
    const res = await pool.query(
      `UPDATE contas SET nome = $1, tipo = $2 WHERE id = $3 AND usuario_id = $4
       RETURNING id, nome, tipo, saldo_inicial::float, ativo, padrao`,
      [nome, tipo || null, contaId, uid]
    );
    return res.rows[0] || null;
  } catch (err) {
    if (err.code === '23505') {
      throw new Error(`Você já tem uma conta chamada "${nome}".`);
    }
    throw err;
  }
}

// Soft-delete de conta. Bloqueia se for a conta padrão ou se houver transações vinculadas.
async function excluirConta(usuarioId, contaId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const contaRes = await pool.query(
    `SELECT id, padrao FROM contas WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE`,
    [contaId, uid]
  );
  if (contaRes.rows.length === 0) return null;
  if (contaRes.rows[0].padrao) {
    throw new Error('A conta padrão não pode ser excluída.');
  }

  const transRes = await pool.query(
    `SELECT 1 FROM transacoes WHERE usuario_id = $1 AND conta_id = $2 LIMIT 1`,
    [uid, contaId]
  );
  if (transRes.rows.length > 0) {
    throw new Error('Esta conta possui transações vinculadas e não pode ser excluída.');
  }

  const transfRes = await pool.query(
    `SELECT 1 FROM transferencias WHERE usuario_id = $1 AND (conta_origem_id = $2 OR conta_destino_id = $2) LIMIT 1`,
    [uid, contaId]
  );
  if (transfRes.rows.length > 0) {
    throw new Error('Esta conta possui transferências vinculadas e não pode ser excluída.');
  }

  await pool.query(
    `UPDATE contas SET ativo = FALSE WHERE id = $1 AND usuario_id = $2`,
    [contaId, uid]
  );
  return true;
}

async function atualizarCartao(usuarioId, cartaoId, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['nome', 'limite_total', 'dia_fechamento', 'dia_vencimento'];
  if (!camposPermitidos.includes(campo)) return null;
  const res = await pool.query(
    `UPDATE cartoes SET ${campo} = $1 WHERE id = $2 AND usuario_id = $3
     RETURNING id, nome, limite_total::float, dia_fechamento, dia_vencimento`,
    [novoValor, cartaoId, uid]
  );
  return res.rows[0] || null;
}

async function deletarCartao(usuarioId, cartaoId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `DELETE FROM cartoes WHERE id = $1 AND usuario_id = $2 RETURNING nome`,
    [cartaoId, uid]
  );
  return res.rows[0]?.nome || null;
}

// Exclui o cartão e todos os dados associados (recorrências, transações, lembretes)
async function deletarCartaoCompleto(usuarioId, cartaoId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Confirmar que o cartão pertence ao usuário e pegar o nome
    const cartaoRes = await client.query(
      `SELECT id, nome FROM cartoes WHERE id = $1 AND usuario_id = $2`,
      [cartaoId, uid]
    );
    if (cartaoRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const nome = cartaoRes.rows[0].nome;

    // 2. Buscar recorrências da fatura deste cartão
    const recRes = await client.query(
      `SELECT id FROM recorrencias
       WHERE usuario_id = $1 AND descricao = $2`,
      [uid, `Fatura ${nome}`]
    );
    const recIds = recRes.rows.map(r => r.id);

    // 3. Excluir lembretes_enviados das transações vinculadas ao cartão
    await client.query(
      `DELETE FROM lembretes_enviados
       WHERE transacao_id IN (
         SELECT id FROM transacoes WHERE usuario_id = $1 AND cartao_id = $2
       )`,
      [uid, cartaoId]
    );

    // 4. Excluir lembretes_enviados das transações das recorrências da fatura
    if (recIds.length > 0) {
      await client.query(
        `DELETE FROM lembretes_enviados
         WHERE transacao_id IN (
           SELECT id FROM transacoes WHERE usuario_id = $1 AND recorrencia_id = ANY($2::int[])
         )`,
        [uid, recIds]
      );
    }

    // 5. Excluir todas as transações vinculadas ao cartão (compras + fatura)
    await client.query(
      `DELETE FROM transacoes WHERE usuario_id = $1 AND cartao_id = $2`,
      [uid, cartaoId]
    );

    // 6. Excluir transações vinculadas às recorrências da fatura
    if (recIds.length > 0) {
      await client.query(
        `DELETE FROM transacoes WHERE usuario_id = $1 AND recorrencia_id = ANY($2::int[])`,
        [uid, recIds]
      );

      // 7. Excluir as recorrências da fatura
      await client.query(
        `DELETE FROM recorrencias WHERE id = ANY($1::int[]) AND usuario_id = $2`,
        [recIds, uid]
      );
    }

    // 8. Excluir lembretes recorrentes de vencimento deste cartão
    await client.query(
      `DELETE FROM lembretes_recorrentes
       WHERE usuario_id = $1 AND mensagem LIKE $2`,
      [uid, `💳 Vencimento fatura ${nome}%`]
    );

    // 9. Excluir o cartão
    await client.query(
      `DELETE FROM cartoes WHERE id = $1 AND usuario_id = $2`,
      [cartaoId, uid]
    );

    await client.query('COMMIT');
    return nome;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Soma todas as transações pendentes (parcelas futuras incluídas) para mostrar crédito comprometido
async function calcularCreditoComprometido(cartaoId) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes WHERE cartao_id = $1 AND status != 'pago'`,
    [cartaoId]
  );
  // Inclui também as do ciclo atual (status='pago' = incluída na fatura, mas fatura ainda não paga)
  const res2 = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total
     FROM transacoes WHERE cartao_id = $1 AND status = 'pago' AND data >= NOW() - INTERVAL '45 days'`,
    [cartaoId]
  );
  return res.rows[0].total + res2.rows[0].total;
}

async function calcularUsoCartao(cartaoId, diaFechamento) {
  const hoje = new Date();
  const diaHoje = hoje.getDate();
  const fechamento = diaFechamento || 1;
  let inicio;
  if (diaHoje >= fechamento) {
    inicio = new Date(hoje.getFullYear(), hoje.getMonth(), fechamento);
  } else {
    inicio = new Date(hoje.getFullYear(), hoje.getMonth() - 1, fechamento);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const inicioStr = `${inicio.getFullYear()}-${pad(inicio.getMonth() + 1)}-${pad(inicio.getDate())}`;
  const hojeStr = `${hoje.getFullYear()}-${pad(hoje.getMonth() + 1)}-${pad(hoje.getDate())}`;
  const res = await pool.query(
    `SELECT COALESCE(SUM(valor), 0)::float as total, COUNT(*)::int as qtd
     FROM transacoes WHERE cartao_id = $1 AND data >= $2 AND data <= $3`,
    [cartaoId, inicioStr, hojeStr]
  );
  return { total: res.rows[0].total, qtd: res.rows[0].qtd, inicioStr, fimStr: hojeStr };
}

// Projetar faturas futuras de um cartão baseado nas parcelas pendentes por mês
async function projetarFaturasCartao(cartaoId, meses = 12) {
  const res = await pool.query(
    `SELECT valor::float, TO_CHAR(data, 'YYYY-MM') as mes
     FROM transacoes
     WHERE cartao_id = $1 AND status = 'pendente' AND data >= NOW()
     ORDER BY data`,
    [cartaoId]
  );
  const porMes = {};
  for (const row of res.rows) {
    porMes[row.mes] = (porMes[row.mes] || 0) + row.valor;
  }
  return porMes;
}

// ─── Reminders (BullMQ) ──────────────────────────────────────────────────────

async function createReminder(usuarioId, mensagem, runAt) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO reminders (usuario_id, mensagem, run_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [uid, mensagem, runAt]
  );
  return result.rows[0].id;
}

// Claim atômico: muda pending→sending e retorna a linha (ou null se já processado)
async function claimReminder(id) {
  const result = await pool.query(
    `UPDATE reminders
     SET status = 'sending', locked_at = NOW(), attempts = attempts + 1
     WHERE id = $1 AND status = 'pending'
     RETURNING id, usuario_id, mensagem`,
    [id]
  );
  return result.rows[0] || null;
}

async function markReminderSent(id) {
  await pool.query(
    `UPDATE reminders SET status = 'sent', sent_at = NOW() WHERE id = $1`,
    [id]
  );
}

async function markReminderFailed(id, errorMsg) {
  await pool.query(
    `UPDATE reminders SET status = 'failed', last_error = $2 WHERE id = $1`,
    [id, errorMsg]
  );
}

async function cancelReminder(id, usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE reminders SET status = 'canceled'
     WHERE id = $1 AND usuario_id = $2 AND status = 'pending'
     RETURNING id, mensagem`,
    [id, uid]
  );
  return result.rows[0] || null;
}

// Reminders pendentes atrasados (run_at <= NOW() - 30s): para o sweeper re-enfileirar
async function buscarRemindersPendentesAtrasados() {
  const result = await pool.query(
    `SELECT id, usuario_id, mensagem, run_at
     FROM reminders
     WHERE status = 'pending' AND run_at <= NOW() - INTERVAL '30 seconds'
     ORDER BY run_at ASC
     LIMIT 50`
  );
  return result.rows;
}

// Lembretes futuros pendentes de um usuário (para exibição e re-enqueue no startup)
async function buscarRemindersAgendados(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, mensagem,
            TO_CHAR(run_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario
     FROM reminders
     WHERE usuario_id = $1 AND status = 'pending' AND run_at > NOW()
     ORDER BY run_at ASC`,
    [uid]
  );
  return result.rows;
}

// Lembretes (reminders) por período — formato compatível com agenda do painel
async function buscarRemindersPorPeriodo(usuarioId, dataInicio, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);
  if (!dataInicioValida || !dataFimValida) return [];

  const result = await pool.query(
    `SELECT id, mensagem,
            TO_CHAR(run_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') as horario,
            TO_CHAR(run_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') as data_disparo,
            TO_CHAR(run_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') as hora
     FROM reminders
     WHERE usuario_id = $1 AND status = 'pending'
       AND run_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
       AND run_at < (($3::date + interval '1 day')::timestamp AT TIME ZONE 'America/Sao_Paulo')
     ORDER BY run_at ASC`,
    [uid, dataInicioValida, dataFimValida]
  );
  return result.rows;
}

// Todos os lembretes recorrentes ativos (para sweeper + re-enqueue no startup)
async function listarRecorrentesAtivos() {
  const result = await pool.query(
    `SELECT id, usuario_id, mensagem,
            TO_CHAR(horario, 'HH24:MI') as horario,
            frequencia, dia_semana, dia_mes,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
            TO_CHAR(ultimo_envio, 'YYYY-MM-DD') as ultimo_envio
     FROM lembretes_recorrentes
     WHERE ativo = TRUE AND (data_fim IS NULL OR data_fim >= CURRENT_DATE)
     ORDER BY id ASC`
  );
  return result.rows;
}

// Buscar lembrete recorrente por id (para o worker)
async function buscarLembreteRecorrentePorId(id) {
  const result = await pool.query(
    `SELECT id, usuario_id, mensagem,
            TO_CHAR(horario, 'HH24:MI') as horario,
            frequencia, dia_semana, dia_mes,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
            TO_CHAR(ultimo_envio, 'YYYY-MM-DD') as ultimo_envio,
            ativo
     FROM lembretes_recorrentes
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

// Calcula a próxima data de disparo de um lembrete recorrente (pura, sem I/O)
// aposData: Date de referência (geralmente now). Retorna a próxima Date de
// disparo (incluindo hoje se o horário ainda não passou), ou null se expirou.
function calcularProximaOcorrenciaRecorrente(regra, aposData) {
  const ref = new Date(aposData);
  const [h, m] = regra.horario.split(':').map(Number);
  const dataFimObj = regra.data_fim ? new Date(regra.data_fim + 'T23:59:59.000-03:00') : null;

  // Helper: YYYY-MM-DD da data em São Paulo (en-CA dá formato ISO)
  const spFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
  function spDateStr(d) { return spFmt.format(d); }

  // Constrói um Date representando h:m no dia SP de dateRef, com offset -03:00
  function construirSP(spStr) {
    return new Date(`${spStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00.000-03:00`);
  }

  // Dia da semana e dia do mês usando a data SP (evita erros de timezone perto de meia-noite)
  function diaSemanaEmSP(d) {
    const [y, mo, dy] = spDateStr(d).split('-').map(Number);
    return new Date(y, mo - 1, dy).getDay(); // Date local sem TZ para só pegar o dia da semana
  }
  function diaMesEmSP(d) {
    return parseInt(spDateStr(d).split('-')[2]);
  }

  function diaValido(d) {
    if (regra.frequencia === 'diario') return true;
    if (regra.frequencia === 'semanal') return diaSemanaEmSP(d) === regra.dia_semana;
    if (regra.frequencia === 'mensal') return diaMesEmSP(d) === regra.dia_mes;
    return false;
  }

  // 1. Verificar se HOJE (em SP) ainda tem uma ocorrência futura (horário > agora)
  const todaySP = spDateStr(ref);
  const hojeCandidate = construirSP(todaySP);
  if (hojeCandidate > ref && diaValido(hojeCandidate)) {
    if (!dataFimObj || hojeCandidate <= dataFimObj) return hojeCandidate;
  }

  // 2. Iterar dias a partir de amanhã (em SP) para achar o próximo dia válido
  const [refAno, refMes, refDia] = todaySP.split('-').map(Number);
  const cursor = new Date(refAno, refMes - 1, refDia + 1); // date local sem TZ só para iteração

  for (let i = 0; i < 400; i++) {
    const cursorStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2,'0')}-${String(cursor.getDate()).padStart(2,'0')}`;
    const candidato = construirSP(cursorStr);
    if (diaValido(candidato)) {
      if (dataFimObj && candidato > dataFimObj) return null;
      return candidato;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return null;
}

// ─── Feedback ────────────────────────────────────────────────────────────────

async function listarUsuariosFeedback(diasAposAcesso = 0) {
  const result = await pool.query(`
    SELECT DISTINCT ON (u.usuario_id)
      u.usuario_id, u.nome, u.primeiro_contato,
      a.status AS status_assinatura
    FROM usuarios u
    LEFT JOIN assinaturas a ON a.usuario_id = u.usuario_id
    WHERE u.usuario_id NOT LIKE '%@lid'
      AND u.primeiro_contato <= NOW() - INTERVAL '1 day' * $1
    ORDER BY u.usuario_id, u.primeiro_contato DESC
  `, [diasAposAcesso]);
  return result.rows;
}

async function criarFeedbackCampanha(mensagem, filtroDiasAposAcesso, totalDestinatarios) {
  const result = await pool.query(
    `INSERT INTO feedback_campanhas (mensagem, filtro_dias_apos_acesso, total_destinatarios)
     VALUES ($1, $2, $3) RETURNING id`,
    [mensagem, filtroDiasAposAcesso || null, totalDestinatarios]
  );
  return result.rows[0].id;
}

async function registrarDestinatarioFeedback(campanhaId, usuarioId, nomeUsuario) {
  await pool.query(
    `INSERT INTO feedback_respostas (campanha_id, usuario_id, nome_usuario)
     VALUES ($1, $2, $3)
     ON CONFLICT (campanha_id, usuario_id) DO NOTHING`,
    [campanhaId, usuarioId, nomeUsuario || null]
  );
}

async function atualizarProgressoFeedbackCampanha(campanhaId, enviados, erros, finalizado) {
  await pool.query(
    `UPDATE feedback_campanhas SET enviados = $1, erros = $2, finalizado = $3 WHERE id = $4`,
    [enviados, erros, finalizado, campanhaId]
  );
}

async function registrarRespostaFeedback(usuarioId, resposta) {
  const result = await pool.query(
    `UPDATE feedback_respostas
     SET respondido = TRUE, resposta = $1, respondido_em = NOW()
     WHERE usuario_id = $2 AND respondido = FALSE
       AND campanha_id = (
         SELECT campanha_id FROM feedback_respostas
         WHERE usuario_id = $2 AND respondido = FALSE
         ORDER BY enviado_em DESC LIMIT 1
       )
     RETURNING campanha_id`,
    [resposta, usuarioId]
  );
  return result.rows[0]?.campanha_id || null;
}

async function listarFeedbackCampanhas() {
  const result = await pool.query(`
    SELECT fc.*,
      (SELECT COUNT(*) FROM feedback_respostas fr
       WHERE fr.campanha_id = fc.id AND fr.respondido = TRUE) AS total_respostas
    FROM feedback_campanhas fc
    ORDER BY fc.criado_em DESC
  `);
  return result.rows;
}

async function buscarFeedbackCampanha(campanhaId) {
  const campanha = await pool.query(
    `SELECT * FROM feedback_campanhas WHERE id = $1`, [campanhaId]
  );
  const respostas = await pool.query(
    `SELECT * FROM feedback_respostas WHERE campanha_id = $1
     ORDER BY respondido DESC, enviado_em ASC`,
    [campanhaId]
  );
  return { campanha: campanha.rows[0] || null, respostas: respostas.rows };
}

async function buscarFeedbackPendente(usuarioId) {
  const result = await pool.query(
    `SELECT fr.campanha_id, fc.mensagem
     FROM feedback_respostas fr
     JOIN feedback_campanhas fc ON fc.id = fr.campanha_id
     WHERE fr.usuario_id = $1 AND fr.respondido = FALSE
     ORDER BY fr.enviado_em DESC LIMIT 1`,
    [usuarioId]
  );
  return result.rows[0] || null;
}

// ─── Admin Crons ──────────────────────────────────────────────────────────────

async function criarAdminCron(titulo, mensagem, frequencia, horario, regra, regraValor, usuarioIds) {
  const result = await pool.query(
    `INSERT INTO admin_crons (titulo, mensagem, frequencia, horario, regra, regra_valor, usuario_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [titulo, mensagem, frequencia, horario || null, regra, regraValor || null, usuarioIds || null]
  );
  return result.rows[0];
}

async function listarAdminCrons() {
  const result = await pool.query(`SELECT * FROM admin_crons ORDER BY criado_em DESC`);
  return result.rows;
}

async function buscarAdminCron(id) {
  const result = await pool.query(`SELECT * FROM admin_crons WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

async function atualizarAdminCron(id, campos) {
  const sets = [];
  const vals = [];
  let idx = 1;
  for (const [key, val] of Object.entries(campos)) {
    sets.push(`${key} = $${idx}`);
    vals.push(val);
    idx++;
  }
  vals.push(id);
  const result = await pool.query(
    `UPDATE admin_crons SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return result.rows[0] || null;
}

async function excluirAdminCron(id) {
  await pool.query(`DELETE FROM admin_crons WHERE id = $1`, [id]);
}

async function registrarEnvioAdminCron(id, totalEnviados) {
  await pool.query(
    `UPDATE admin_crons SET ultimo_envio = NOW(), total_enviados = total_enviados + $1 WHERE id = $2`,
    [totalEnviados, id]
  );
}

/**
 * Tenta adquirir lock exclusivo na linha da cron (SKIP LOCKED) e cria o log.
 * Retorna o logId se conseguiu, ou null se a cron já está sendo processada.
 */
async function iniciarExecucaoCron(cronId) {
  const pgClient = await pool.connect();
  try {
    await pgClient.query('BEGIN');

    // SKIP LOCKED: se outro processo tiver a linha locked, retorna vazio imediatamente
    const lock = await pgClient.query(
      'SELECT id FROM admin_crons WHERE id = $1 FOR UPDATE SKIP LOCKED',
      [cronId]
    );
    if (lock.rows.length === 0) {
      await pgClient.query('ROLLBACK');
      return null;
    }

    // Verificar se já existe log processando recente (< 10 min) — guarda de segurança extra
    const existing = await pgClient.query(
      `SELECT id FROM admin_crons_log
       WHERE cron_id = $1 AND status = 'processando' AND iniciado_em > NOW() - INTERVAL '10 minutes'`,
      [cronId]
    );
    if (existing.rows.length > 0) {
      await pgClient.query('ROLLBACK');
      return null;
    }

    // Criar log e atualizar ultimo_envio atomicamente (evita re-trigger do verificarCrons)
    const log = await pgClient.query(
      'INSERT INTO admin_crons_log (cron_id) VALUES ($1) RETURNING id',
      [cronId]
    );
    await pgClient.query(
      'UPDATE admin_crons SET ultimo_envio = NOW() WHERE id = $1',
      [cronId]
    );

    await pgClient.query('COMMIT');
    return log.rows[0].id;
  } catch (err) {
    await pgClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    pgClient.release();
  }
}

async function finalizarLogAdminCron(logId, status, total, enviados, erros) {
  await pool.query(
    `UPDATE admin_crons_log
     SET status = $2, total = $3, enviados = $4, erros = $5, finalizado_em = NOW()
     WHERE id = $1`,
    [logId, status, total, enviados, erros]
  );
}

async function buscarLogsPendentes() {
  const result = await pool.query(`
    SELECT l.*, c.id AS cron_id
    FROM admin_crons_log l
    JOIN admin_crons c ON c.id = l.cron_id
    WHERE l.status = 'processando'
      AND l.iniciado_em < NOW() - INTERVAL '10 minutes'
  `);
  return result.rows;
}

async function cancelarLogAdminCron(logId) {
  await pool.query(
    `UPDATE admin_crons_log SET status = 'erro', finalizado_em = NOW() WHERE id = $1`,
    [logId]
  );
}

async function listarUsuariosAtivos(dias) {
  const result = await pool.query(`
    SELECT DISTINCT u.usuario_id, u.nome FROM usuarios u
    JOIN transacoes t ON t.usuario_id = u.usuario_id
    WHERE t.criado_em >= NOW() - MAKE_INTERVAL(days => $1)
      AND u.usuario_id NOT LIKE '%@lid'
  `, [dias]);
  return result.rows;
}

async function listarUsuariosInativos(dias) {
  const result = await pool.query(`
    SELECT u.usuario_id, u.nome FROM usuarios u
    WHERE u.usuario_id NOT LIKE '%@lid'
      AND NOT EXISTS (
        SELECT 1 FROM transacoes t
        WHERE t.usuario_id = u.usuario_id
          AND t.criado_em >= NOW() - MAKE_INTERVAL(days => $1)
      )
  `, [dias]);
  return result.rows;
}

async function buscarUsuariosPorIds(ids) {
  if (!ids || ids.length === 0) return [];
  const result = await pool.query(
    `SELECT usuario_id, nome FROM usuarios WHERE usuario_id = ANY($1)`,
    [ids]
  );
  return result.rows;
}

async function buscarUsuariosParaSelect(q) {
  const result = await pool.query(`
    SELECT u.usuario_id, u.nome FROM usuarios u
    WHERE u.usuario_id NOT LIKE '%@lid'
      AND (u.nome ILIKE $1 OR u.usuario_id ILIKE $1)
    ORDER BY u.nome ASC LIMIT 50
  `, [`%${q}%`]);
  return result.rows;
}

// ─── Reativação (drip campaign para usuários inativos — ver reativacao.js) ────

async function atualizarUltimaInteracao(usuarioId) {
  await pool.query(
    `UPDATE usuarios SET ultima_interacao = NOW() WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function marcarChurned(usuarioId) {
  await pool.query(
    `UPDATE usuarios SET churned = TRUE WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function reativarUsuario(usuarioId) {
  await pool.query(
    `UPDATE usuarios SET churned = FALSE WHERE usuario_id = $1`,
    [usuarioId]
  );
  await pool.query(
    `DELETE FROM reativacao_log WHERE usuario_id = $1`,
    [usuarioId]
  );
}

async function isChurned(usuarioId) {
  const result = await pool.query(
    `SELECT churned FROM usuarios WHERE usuario_id = $1`,
    [usuarioId]
  );
  return result.rows[0]?.churned === true;
}

async function buscarUsuariosParaReativacao(diasInativo) {
  const result = await pool.query(`
    SELECT u.usuario_id, u.nome, u.ultima_interacao,
           EXTRACT(DAY FROM NOW() - COALESCE(u.ultima_interacao, u.primeiro_contato))::int AS dias_inativo
    FROM usuarios u
    WHERE u.usuario_id NOT LIKE '%@lid'
      AND u.churned = FALSE
      AND COALESCE(u.ultima_interacao, u.primeiro_contato) <= NOW() - MAKE_INTERVAL(days => $1)
  `, [diasInativo]);
  return result.rows;
}

async function jaEnviouReativacao(usuarioId, etapa) {
  const result = await pool.query(
    `SELECT 1 FROM reativacao_log WHERE usuario_id = $1 AND etapa = $2 LIMIT 1`,
    [usuarioId, etapa]
  );
  return result.rows.length > 0;
}

async function registrarReativacao(usuarioId, etapa) {
  await pool.query(
    `INSERT INTO reativacao_log (usuario_id, etapa)
     VALUES ($1, $2)
     ON CONFLICT (usuario_id, etapa) DO NOTHING`,
    [usuarioId, etapa]
  );
}

// ─── Google Calendar tokens ──────────────────────────────────────────────────

async function salvarGoogleTokens(usuarioId, tokens) {
  await pool.query(
    `INSERT INTO google_tokens (usuario_id, access_token, refresh_token, expiry_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id) DO UPDATE SET
       access_token = $2, refresh_token = $3, expiry_date = $4, conectado_em = NOW()`,
    [usuarioId, tokens.access_token, tokens.refresh_token, tokens.expiry_date || null]
  );
}

async function buscarGoogleTokens(usuarioId) {
  const r = await pool.query('SELECT * FROM google_tokens WHERE usuario_id = $1', [usuarioId]);
  return r.rows[0] || null;
}

async function removerGoogleTokens(usuarioId) {
  await pool.query('DELETE FROM google_tokens WHERE usuario_id = $1', [usuarioId]);
}

async function salvarGoogleEventId(tabela, id, googleEventId) {
  await pool.query(`UPDATE ${tabela} SET google_event_id = $1 WHERE id = $2`, [googleEventId, id]);
}

async function buscarGoogleEventId(tabela, id) {
  const r = await pool.query(`SELECT google_event_id FROM ${tabela} WHERE id = $1`, [id]);
  return r.rows[0]?.google_event_id || null;
}

// --- Métricas de Crescimento (agente-crescimento) ---

async function contarUsuariosTotal() {
  const r = await pool.query(
    `SELECT COUNT(DISTINCT usuario_id)::int as total FROM usuarios WHERE usuario_id NOT LIKE '%@lid'`
  );
  return r.rows[0]?.total || 0;
}

async function contarUsuariosNovos(dias = 7) {
  const r = await pool.query(
    `SELECT COUNT(*)::int as total FROM usuarios
     WHERE primeiro_contato >= NOW() - MAKE_INTERVAL(days => $1)
       AND usuario_id NOT LIKE '%@lid'`,
    [dias]
  );
  return r.rows[0]?.total || 0;
}

async function contarUsuariosChurned() {
  const r = await pool.query(
    `SELECT COUNT(*)::int as total FROM usuarios WHERE churned = TRUE AND usuario_id NOT LIKE '%@lid'`
  );
  return r.rows[0]?.total || 0;
}

async function metricsAssinaturasPorStatus() {
  const r = await pool.query(
    `SELECT COALESCE(a.status, 'sem_assinatura') as status, COUNT(*)::int as total
     FROM usuarios u
     LEFT JOIN assinaturas a ON a.usuario_id = u.usuario_id
     WHERE u.usuario_id NOT LIKE '%@lid'
     GROUP BY a.status`
  );
  return r.rows;
}

async function metricsTransacoesAgregadas(dias = 30) {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int as total_transacoes,
       COUNT(DISTINCT t.usuario_id)::int as usuarios_transacionando,
       COALESCE(SUM(CASE WHEN t.tipo='despesa' THEN t.valor ELSE 0 END), 0)::float as total_despesas,
       COALESCE(SUM(CASE WHEN t.tipo='receita' THEN t.valor ELSE 0 END), 0)::float as total_receitas,
       COALESCE(AVG(t.valor), 0)::float as valor_medio
     FROM transacoes t
     WHERE t.criado_em >= NOW() - MAKE_INTERVAL(days => $1)`,
    [dias]
  );
  return r.rows[0];
}

async function metricsCategoriasTop(dias = 30, limite = 5) {
  const r = await pool.query(
    `SELECT categoria, COUNT(*)::int as total, COALESCE(SUM(valor), 0)::float as volume
     FROM transacoes
     WHERE criado_em >= NOW() - MAKE_INTERVAL(days => $1)
       AND categoria IS NOT NULL
     GROUP BY categoria
     ORDER BY total DESC
     LIMIT $2`,
    [dias, limite]
  );
  return r.rows;
}

async function metricsEngajamentoUsuarios(dias = 30) {
  const r = await pool.query(
    `SELECT
       COUNT(DISTINCT t.usuario_id)::int as usuarios_ativos,
       COUNT(*)::int as total_transacoes,
       ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT t.usuario_id), 0), 1)::float as media_por_usuario,
       MAX(t.criado_em) as ultima_transacao_global
     FROM transacoes t
     JOIN usuarios u ON u.usuario_id = t.usuario_id
     WHERE t.criado_em >= NOW() - MAKE_INTERVAL(days => $1)
       AND u.usuario_id NOT LIKE '%@lid'`,
    [dias]
  );
  return r.rows[0];
}

async function metricsReativacao() {
  const r = await pool.query(
    `SELECT etapa, COUNT(*)::int as total
     FROM reativacao_log
     WHERE enviado_em >= NOW() - INTERVAL '30 days'
     GROUP BY etapa
     ORDER BY etapa`
  );
  return r.rows;
}

async function metricsUsuariosTopEngajamento(dias = 30, limite = 10) {
  const r = await pool.query(
    `SELECT t.usuario_id, u.nome, COUNT(*)::int as transacoes,
            COALESCE(SUM(t.valor), 0)::float as volume
     FROM transacoes t
     JOIN usuarios u ON u.usuario_id = t.usuario_id
     WHERE t.criado_em >= NOW() - MAKE_INTERVAL(days => $1)
       AND u.usuario_id NOT LIKE '%@lid'
     GROUP BY t.usuario_id, u.nome
     ORDER BY transacoes DESC
     LIMIT $2`,
    [dias, limite]
  );
  return r.rows;
}

async function metricsUsuariosRisco() {
  const r = await pool.query(
    `SELECT u.usuario_id, u.nome,
       EXTRACT(DAY FROM NOW() - COALESCE(u.ultima_interacao, u.primeiro_contato))::int as dias_inativo,
       a.status, a.trial_fim, a.pago_ate
     FROM usuarios u
     LEFT JOIN assinaturas a ON a.usuario_id = u.usuario_id
     WHERE u.usuario_id NOT LIKE '%@lid'
       AND u.churned = FALSE
       AND COALESCE(u.ultima_interacao, u.primeiro_contato) < NOW() - INTERVAL '2 days'
     ORDER BY dias_inativo DESC
     LIMIT 20`
  );
  return r.rows;
}

async function metricsFunilConversao() {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM usuarios WHERE usuario_id NOT LIKE '%@lid')::int as total_registros,
       (SELECT COUNT(*) FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.usuario_id
        WHERE u.usuario_id NOT LIKE '%@lid' AND a.status = 'trial')::int as em_trial,
       (SELECT COUNT(*) FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.usuario_id
        WHERE u.usuario_id NOT LIKE '%@lid' AND a.status = 'ativo')::int as pagantes,
       (SELECT COUNT(*) FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.usuario_id
        WHERE u.usuario_id NOT LIKE '%@lid' AND a.status = 'expirado')::int as expirados,
       (SELECT COUNT(*) FROM usuarios u JOIN assinaturas a ON a.usuario_id = u.usuario_id
        WHERE u.usuario_id NOT LIKE '%@lid' AND a.status = 'graca')::int as graca,
       (SELECT COUNT(*) FROM usuarios WHERE churned = TRUE AND usuario_id NOT LIKE '%@lid')::int as churned`
  );
  return r.rows[0];
}

async function metricsLogsCampanhas(dias = 7) {
  const r = await pool.query(
    `SELECT c.titulo, l.status, l.total, l.enviados, l.erros, l.iniciado_em
     FROM admin_crons_log l
     JOIN admin_crons c ON c.id = l.cron_id
     WHERE l.iniciado_em >= NOW() - MAKE_INTERVAL(days => $1)
     ORDER BY l.iniciado_em DESC
     LIMIT 20`,
    [dias]
  );
  return r.rows;
}

module.exports = {
  pool,
  initTables,
  adicionarTransacao,
  listarTransacoes,
  resumoMensal,
  resumoAnual,
  buscarTransacoesPorDescricao,
  buscarTransacaoPorId,
  atualizarTransacao,
  excluirTransacao,
  atualizarRecorrencia,
  buscarRecorrenciaPorId,
  buscarRecorrenciasPorDescricao,
  desativarRecorrencia,
  listarCategorias,
  listarCategoriasParaIA,
  listarSubcategoriasPorTipo,
  consultarTransacoes,
  consultarTotalTransacoes,
  liquidarTransacao,
  liquidarTransacaoPorId,
  listarPendentes,
  calcularSaldos,
  buscarPendentesParaLembrete,
  buscarPendentesLembradosHoje,
  registrarLembreteEnviado,
  transacaoAindaPendente,
  criarLembreteGeral,
  buscarLembretesParaDisparar,
  listarLembretesGerais,
  cancelarLembreteGeral,
  atualizarLembreteGeral,
  criarLembreteRecorrente,
  atualizarLembreteRecorrente,
  buscarRecorrentesParaDisparar,
  marcarRecorrenteEnviado,
  desativarRecorrentesExpirados,
  listarLembretesRecorrentes,
  listarLembretesRecorrentesSistema,
  cancelarLembreteRecorrente,
  verificarUsuarioNovo,
  registrarUsuario,
  buscarUsuario,
  definirLimite,
  listarLimites,
  removerLimite,
  criarSubcategoria,
  excluirSubcategoria,
  garantirSubcategoria,
  listarCategoriasParaIA,
  verificarLimite,
  limparDadosUsuario,
  buscarLembretesGeraisPorPeriodo,
  buscarLembretesRecorrentesPorMes,
  vincularContato,
  listarContatosCompartilhados,
  obterVinculoSecundario,
  removerContatoCompartilhado,
  resolverUsuarioPrincipal,
  criarUsuarioPainel,
  buscarUsuarioPainelPorUsername,
  buscarUsuarioPainelPorUserId,
  salvarAvatarPainel,
  usernameDisponivel,
  criarCategoria,
  excluirCategoria,
  buscarBudgetCat,
  salvarBudgetCat,
  criarCaixinha,
  listarCaixinhas,
  buscarCaixinhasPorNome,
  atualizarCaixinha,
  excluirCaixinha,
  adicionarSaldoCaixinha,
  criarRecorrencia,
  listarRecorrencias,
  calcularOcorrenciasNoPerodo,
  adicionarTransacaoComRecorrencia,
  criarAssinatura,
  buscarAssinatura,
  buscarAssinaturasPendentes,
  buscarAssinaturaPorOrderNSU,
  atualizarStatusAssinatura,
  ativarAssinatura,
  incrementarAvisosAssinatura,
  salvarLinkAssinatura,
  salvarTransacaoAssinatura,
  atualizarNomeUsuario,
  listarUsuariosNaoPagantes,
  listarUsuariosAdmin,
  pausarUsuario,
  retomarUsuario,
  criarCupom,
  buscarCupom,
  incrementarUsoCupom,
  listarCupons,
  salvarOnboardingEstadoDB,
  buscarOnboardingEstadoDB,
  salvarFluxoAtivoDB,
  buscarFluxoAtivoDB,
  limparFluxoAtivoDB,
  criarCartao,
  listarCartoes,
  buscarCartoesPorNome,
  criarConta,
  listarContas,
  buscarContasPorNome,
  calcularSaldosPorConta,
  criarTransferencia,
  listarTransferencias,
  atualizarConta,
  excluirConta,
  atualizarCartao,
  deletarCartao,
  deletarCartaoCompleto,
  calcularUsoCartao,
  calcularCreditoComprometido,
  projetarFaturasCartao,
  adicionarTransacoesParcelas,
  createReminder,
  claimReminder,
  markReminderSent,
  markReminderFailed,
  cancelReminder,
  buscarRemindersPendentesAtrasados,
  buscarRemindersAgendados,
  listarRecorrentesAtivos,
  buscarLembreteRecorrentePorId,
  calcularProximaOcorrenciaRecorrente,
  listarLimitesComSub,
  salvarLimitesBatch,
  buscarSalarioUsuario,
  verificarLimiteSub,
  listarCategoriasPrincipais,
  inicializarCategoriasPrincipais,
  criarCategoriaPrincipal,
  atualizarCategoriaPrincipal,
  excluirCategoriaPrincipal,
  salvarCategoriasPrincipaisBatch,
  CATEGORIAS_PRINCIPAIS_PADRAO,
  CATEGORIA_PRINCIPAL_RECEITA,
  SUBCATEGORIAS_RECEITA_PADRAO,
  buscarTipoCategoria,
  listarUsuariosFeedback,
  criarFeedbackCampanha,
  registrarDestinatarioFeedback,
  atualizarProgressoFeedbackCampanha,
  registrarRespostaFeedback,
  listarFeedbackCampanhas,
  buscarFeedbackCampanha,
  buscarFeedbackPendente,
  criarAdminCron,
  listarAdminCrons,
  buscarAdminCron,
  atualizarAdminCron,
  excluirAdminCron,
  registrarEnvioAdminCron,
  iniciarExecucaoCron,
  finalizarLogAdminCron,
  buscarLogsPendentes,
  cancelarLogAdminCron,
  listarUsuariosAtivos,
  listarUsuariosInativos,
  buscarUsuariosPorIds,
  buscarUsuariosParaSelect,
  atualizarUltimaInteracao,
  marcarChurned,
  reativarUsuario,
  isChurned,
  buscarUsuariosParaReativacao,
  jaEnviouReativacao,
  registrarReativacao,
  salvarGoogleTokens,
  buscarGoogleTokens,
  removerGoogleTokens,
  salvarGoogleEventId,
  buscarGoogleEventId,
  buscarRemindersPorPeriodo,
  // Métricas de Crescimento
  contarUsuariosTotal,
  contarUsuariosNovos,
  contarUsuariosChurned,
  metricsAssinaturasPorStatus,
  metricsTransacoesAgregadas,
  metricsCategoriasTop,
  metricsEngajamentoUsuarios,
  metricsReativacao,
  metricsUsuariosTopEngajamento,
  metricsUsuariosRisco,
  metricsFunilConversao,
  metricsLogsCampanhas,
};
