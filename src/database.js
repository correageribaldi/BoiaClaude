const { Pool } = require('pg');
const crypto = require('crypto');
const pluggyCrypto = require('./pluggyCrypto');
const { normalizarEstabelecimento } = require('./estabelecimento');
const { projetarParcelasRestantes } = require('./parcelamento');
const { filtrarRecorrenciasCompativeis, escolherRecorrencia, baldeFechado, janelaEncerradaEm } = require('./recorrencia-match');

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

// ─── Janelas de controle de limite (semana ISO e mês) ────────────────────────
//
// DEFINIÇÃO DE SEMANA: ISO 8601 — segunda a domingo, semana 1 é a que contém a
// primeira quinta-feira do ano. Escolhida por ser previsível (não depende do
// mês, não desliza) e por ser o que qualquer planilha entende. A alternativa
// "semana que começa no dia X do mês" faria a última semana ter 2 a 3 dias, o
// que distorce qualquer comparação de gasto semanal.
//
// Toda a aritmética abaixo é feita sobre 'YYYY-MM-DD' às 12:00 UTC: a data já
// vem resolvida no fuso de São Paulo (dataHojeBR), e o meio-dia dá 12h de
// folga para qualquer ajuste de horário de verão não empurrar o dia.
const MS_POR_DIA = 24 * 60 * 60 * 1000;

function dataISOParaUTC(dataISO) {
  return new Date(`${dataISO}T12:00:00Z`);
}

// 0 = segunda ... 6 = domingo
function diaDaSemanaISO(d) {
  return (d.getUTCDay() + 6) % 7;
}

function inicioSemanaISO(dataISO) {
  const d = dataISOParaUTC(dataISO);
  d.setUTCDate(d.getUTCDate() - diaDaSemanaISO(d));
  return d.toISOString().slice(0, 10);
}

function fimSemanaISO(dataISO) {
  const d = dataISOParaUTC(dataISO);
  d.setUTCDate(d.getUTCDate() - diaDaSemanaISO(d) + 6);
  return d.toISOString().slice(0, 10);
}

// '2026-W32'. O ANO da chave é o ano ISO (o da quinta-feira da semana), que
// pode divergir do ano do calendário na virada — 2025-12-29 é '2026-W01'. É
// justamente o que garante que a semana da virada de ano seja UMA janela só, e
// não duas metades.
function chaveSemanaISO(dataISO) {
  const d = dataISOParaUTC(dataISO);
  d.setUTCDate(d.getUTCDate() - diaDaSemanaISO(d) + 3); // quinta-feira da semana
  const anoISO = d.getUTCFullYear();

  const quintaDaSemana1 = new Date(Date.UTC(anoISO, 0, 4, 12, 0, 0));
  quintaDaSemana1.setUTCDate(quintaDaSemana1.getUTCDate() - diaDaSemanaISO(quintaDaSemana1) + 3);

  const semana = 1 + Math.round((d.getTime() - quintaDaSemana1.getTime()) / (7 * MS_POR_DIA));
  return `${anoISO}-W${String(semana).padStart(2, '0')}`;
}

function inicioMes(dataISO) {
  return `${dataISO.slice(0, 7)}-01`;
}

function fimMes(dataISO) {
  const [ano, mes] = dataISO.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return `${dataISO.slice(0, 7)}-${String(ultimoDia).padStart(2, '0')}`;
}

// Janelas vigentes para uma data de referência (default: hoje em São Paulo).
function janelasDeControle(dataISO = null) {
  const hoje = normalizarDataISO(dataISO) || dataHojeBR();
  return {
    hoje,
    semana: { inicio: inicioSemanaISO(hoje), fim: fimSemanaISO(hoje), chave: chaveSemanaISO(hoje) },
    mes: { inicio: inicioMes(hoje), fim: fimMes(hoje), chave: hoje.slice(0, 7) },
  };
}

// Faixas de alerta — os mesmos degraus usados no WhatsApp e no painel.
// 0 = tranquilo (nada a avisar de forma proativa).
function faixaDeAlerta(percentual) {
  if (percentual >= 100) return 100;
  if (percentual >= 80) return 80;
  if (percentual >= 60) return 60;
  return 0;
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

// Limpeza retroativa IDEMPOTENTE de PROJEÇÕES em duplicata (ver bug descrito
// em initTables, chamada de lá, ANTES do índice único idx_transacoes_projecao_mes).
//
// PERIGO QUE ESTA FUNÇÃO JÁ FOI: a versão anterior particionava por
// (recorrencia_id, mês) sobre TODAS as transações da recorrência e apagava
// toda segunda linha, a cada boot. Aquilo era correto enquanto o modelo era
// "uma transação por mês"; virou destruição de dados no modelo de acumulação,
// onde salário + comissão no mesmo mês são duas entradas legítimas da mesma
// recorrência. A cada restart o usuário perderia a segunda entrada, sem aviso.
//
// Agora o escopo é só `projetada = TRUE`: a duplicata que este projeto precisa
// varrer é a projeção materializada em duplicidade — nunca um lançamento real.
// Para cada (recorrencia_id, mês) mantém a projeção mais antiga (criado_em/id)
// e apaga as demais.
async function limparProjecoesDuplicadas() {
  const result = await pool.query(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY recorrencia_id, date_trunc('month', data::timestamp)
               ORDER BY criado_em ASC, id ASC
             ) AS rn
      FROM transacoes
      WHERE recorrencia_id IS NOT NULL
        AND projetada = TRUE
    )
    DELETE FROM transacoes
    WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
    RETURNING id;
  `);
  if (result.rowCount > 0) {
    console.log(`[DB] limparProjecoesDuplicadas: ${result.rowCount} projeção(ões) duplicada(s) removida(s) (mesma recorrência, mesmo mês)`);
  }
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

  // ─── Limitadores de gasto ───────────────────────────────────────────────────
  //
  // O CONTROLE DE TETO NÃO MORA MAIS EM limites_categoria. Um limitador é um
  // grupo NOMEADO pelo usuário ("Mercado", "Lazer") que junta N subcategorias e
  // tem teto semanal e/ou mensal.
  //
  // Por que a virada: a integração Pluggy cria subcategorias a partir da
  // taxonomia deles, e o usuário terminou com 41 subcategorias ativas (21 só
  // dentro de "Variáveis"). Teto por subcategoria virava uma tela de 41 campos,
  // e a taxonomia não bate com o modelo mental de quem usa — o "Mercado" dele se
  // espalha por Supermercado + Compras; o "Lazer" dele está em Restaurantes e
  // Delivery, que na taxonomia Pluggy ficam sob Variáveis, não sob Lazer.
  // Nomear o grupo e escolher o que entra resolve os dois problemas de uma vez.
  //
  // valor_limite (mensal) CONTINUA em limites_categoria, mas só com o sentido
  // que sempre teve na prática: rateio do orçamento 50/30/20 (o slider do
  // painel grava ali). O teto de gasto saiu de lá — era a mesma coluna servindo
  // a dois conceitos, que é justamente a modelagem que este refactor desfaz.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS limitadores (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      nome TEXT NOT NULL,
      valor_semanal NUMERIC(12,2),
      valor_mensal NUMERIC(12,2),
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_limitadores_usuario
      ON limitadores(usuario_id, ativo);
  `);

  // Nome único por usuário, ignorando caixa — "mercado" e "Mercado" seriam dois
  // tetos para a mesma coisa. Índice PARCIAL (só ativo): excluir um limitador e
  // recriar outro com o mesmo nome depois tem que funcionar.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_limitadores_nome_unico
      ON limitadores(usuario_id, LOWER(nome)) WHERE ativo;
  `);

  // N categorias por limitador.
  //
  // usuario_id é desnormalizado aqui de propósito: é o que permite o índice
  // único abaixo — uma subcategoria pertence a NO MÁXIMO UM limitador. Sem
  // isso, um gasto de R$100 em "Restaurantes" consumiria o teto de "Lazer" E o
  // de "Alimentação" ao mesmo tempo, e a pergunta que a feature existe para
  // responder ("quanto ainda posso gastar?") passaria a ter duas respostas
  // conflitantes, além de render dois alertas para o mesmo gasto. Quem quiser
  // ver a mesma categoria em dois agrupamentos usa o orçamento 50/30/20, que é
  // relatório e admite hierarquia. Restrição escolhida por ser a reversível:
  // liberar depois é dropar o índice; proibir depois exigiria escolher à mão
  // qual limitador fica com cada categoria duplicada.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS limitador_categorias (
      id SERIAL PRIMARY KEY,
      limitador_id INTEGER NOT NULL REFERENCES limitadores(id) ON DELETE CASCADE,
      usuario_id TEXT NOT NULL,
      categoria TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_limitador_categoria_unica
      ON limitador_categorias(usuario_id, categoria);

    CREATE INDEX IF NOT EXISTS idx_limitador_categorias_limitador
      ON limitador_categorias(limitador_id);
  `);

  // Estado do último aviso de estouro, para não repetir o mesmo alerta a cada
  // sincronização da Pluggy (que roda por webhook, várias vezes ao dia).
  //
  // periodo_chave carrega a IDENTIDADE da janela ('2026-W32' para semana ISO,
  // '2026-08' para mês). Virar a semana ou o mês gera uma chave nova, sem linha
  // correspondente, e o alerta volta a poder disparar do zero — o reset é
  // consequência do modelo de dados, não de uma rotina de limpeza que poderia
  // falhar. As linhas velhas ficam como histórico (custo desprezível).
  //
  // Substitui limites_alertas (chaveada por categoria), que nunca chegou a
  // produção — a feature de teto por subcategoria inteira ficou nesta branch.
  // A tabela antiga não é criada nem deletada aqui: em banco de desenvolvimento
  // onde ela existe fica órfã e sem escritor; DROP é decisão do dono.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS limitador_alertas (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      limitador_id INTEGER NOT NULL REFERENCES limitadores(id) ON DELETE CASCADE,
      janela TEXT NOT NULL CHECK(janela IN ('semana', 'mes')),
      periodo_chave TEXT NOT NULL,
      faixa INTEGER NOT NULL DEFAULT 0,
      atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(usuario_id, limitador_id, janela, periodo_chave)
    );

    CREATE INDEX IF NOT EXISTS idx_limitador_alertas_usuario
      ON limitador_alertas(usuario_id, periodo_chave);
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
    WHERE c.usuario_id = t.usuario_id AND c.padrao = TRUE
      AND t.conta_id IS NULL AND t.cartao_id IS NULL;
  `);

  // Correção retroativa (bug de produção, achado ao investigar saldo errado
  // após conexão Pluggy): a migração acima, ANTES de ganhar "AND t.cartao_id
  // IS NULL", grudava conta_id = conta padrão em qualquer transação órfã de
  // conta_id — inclusive as de cartão (que corretamente têm conta_id NULL,
  // só cartao_id preenchido). Toda reinicialização do servidor recontaminava
  // de novo. Idempotente: sem transações nessa condição, é um no-op.
  await pool.query(`
    UPDATE transacoes SET conta_id = NULL
    WHERE cartao_id IS NOT NULL AND conta_id IS NOT NULL;
  `);

  // Migração: origem da recorrência (cartão OU conta). Mora aqui, e não junto do
  // CREATE TABLE recorrencias, porque as FKs exigem que `cartoes` e `contas` já
  // existam — ambas são criadas depois naquele bloco.
  //
  // Sem isso não dá para distinguir "fixa paga no cartão" de "fixa que sai da
  // conta corrente", e a transação materializada pela regra nascia sempre sem
  // origem. Nullable: recorrência antiga (genérica) continua válida com as duas
  // colunas NULL.
  await pool.query(`
    ALTER TABLE recorrencias ADD COLUMN IF NOT EXISTS cartao_id INTEGER REFERENCES cartoes(id);
    ALTER TABLE recorrencias ADD COLUMN IF NOT EXISTS conta_id  INTEGER REFERENCES contas(id);
  `);

  // Invariante de origem, no banco e não só no JS: mesma regra que vale para
  // `transacoes` (cartão preenchido ⇒ conta NULL, e vice-versa). Já houve bug de
  // produção com as duas colunas preenchidas ao mesmo tempo em transacoes —
  // aqui a porta fica fechada desde o começo. CHECK não aceita IF NOT EXISTS,
  // daí o DO block guardado por pg_constraint (idempotente).
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recorrencias_origem_exclusiva'
      ) THEN
        ALTER TABLE recorrencias
          ADD CONSTRAINT recorrencias_origem_exclusiva
          CHECK (cartao_id IS NULL OR conta_id IS NULL);
      END IF;
    END $$;
  `);

  // Colunas para cartão espelho Pluggy: valores REAIS da API (Account.balance
  // e Account.creditData.availableCreditLimit), nunca calculados a partir de
  // transacoes — diferente de calcularUsoCartao (feito para cartão manual,
  // sem relação com o ciclo de fatura real). Nullable: cartão manual nunca
  // preenche essas colunas, continua usando calcularUsoCartao como sempre.
  await pool.query(`
    ALTER TABLE cartoes ADD COLUMN IF NOT EXISTS pluggy_valor_usado NUMERIC(12,2);
    ALTER TABLE cartoes ADD COLUMN IF NOT EXISTS pluggy_disponivel NUMERIC(12,2);
  `);

  // ─── Módulo Pluggy — Open Finance (Marco 1: credenciais por usuário) ─────────
  // client_secret nunca em texto plano — cifrado (AES-256-GCM) em src/pluggyCrypto.js.
  // Uma credencial por usuário (UNIQUE) — recriar é UPDATE, não nova linha.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pluggy_credenciais (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL UNIQUE,
      client_id TEXT NOT NULL,
      client_secret_encrypted TEXT NOT NULL,
      iv TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pluggy_credenciais_usuario ON pluggy_credenciais(usuario_id);
  `);

  // ─── Módulo Pluggy — Open Finance (Marco 2: Items e contas/cartões espelho) ──
  // Um Item pode ter múltiplas Accounts/CreditCards (ex: conta corrente + cartão
  // no mesmo banco) — cada uma vira uma linha própria em contas/cartoes.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pluggy_items (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      item_id TEXT NOT NULL UNIQUE,
      connector_nome TEXT,
      status TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pluggy_items_usuario ON pluggy_items(usuario_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pluggy_contas_map (
      id SERIAL PRIMARY KEY,
      pluggy_item_id INTEGER NOT NULL REFERENCES pluggy_items(id) ON DELETE CASCADE,
      pluggy_account_id TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL CHECK(tipo IN ('conta', 'cartao')),
      cronos_conta_id INTEGER REFERENCES contas(id),
      cronos_cartao_id INTEGER REFERENCES cartoes(id),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (tipo = 'conta' AND cronos_conta_id IS NOT NULL AND cronos_cartao_id IS NULL)
        OR
        (tipo = 'cartao' AND cronos_cartao_id IS NOT NULL AND cronos_conta_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS idx_pluggy_contas_map_item ON pluggy_contas_map(pluggy_item_id);
  `);

  // ─── Módulo Pluggy — posições de investimento (produto INVESTMENTS) ──────────
  //
  // ESTOQUE, não fluxo, e deliberadamente FORA de qualquer cálculo de saldo:
  //
  //  - NÃO entra em calcularSaldos nem em calcularSaldosPorConta. Dinheiro
  //    aplicado não é saldo líquido em conta corrente; somar inflaria o saldo
  //    (mesma classe de bug já corrigida em calcularSaldos, ver comentário lá).
  //    Tabela própria justamente para que nenhuma query de saldo a alcance por
  //    acidente — contas/transacoes continuam sendo a única fonte do saldo.
  //  - NÃO se confunde com a categoria de orçamento "Investimentos", que é
  //    FLUXO (quanto da renda o usuário decide aplicar por mês). Aqui é o
  //    montante acumulado. Conceitos distintos, nunca somados.
  //  - Não há risco de contagem dupla com `contas`: Account.type na Pluggy é
  //    só BANK|CREDIT (investimento não é Account, vem de GET /investments),
  //    então o `else` de conectarItem nunca cria uma conta espelho a partir de
  //    uma posição de investimento.
  //
  // pluggy_item_id é obrigatório para o ciclo de vida: a desativação de ativos
  // que sumiram da API é feita POR ITEM. Sem esse escopo, sincronizar o banco A
  // desativaria os investimentos do banco B (usuário com mais de uma conexão).
  //
  // Ativo que some da API vira ativo = FALSE, nunca DELETE — resgate é
  // histórico, não erro de sincronização.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS investimentos (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      pluggy_item_id INTEGER NOT NULL REFERENCES pluggy_items(id) ON DELETE CASCADE,
      pluggy_investment_id TEXT NOT NULL UNIQUE,
      nome TEXT NOT NULL,
      tipo TEXT,
      subtipo TEXT,
      saldo NUMERIC(14,2) NOT NULL DEFAULT 0,
      valor_aplicado NUMERIC(14,2),
      lucro NUMERIC(14,2),
      taxa NUMERIC(12,4),
      tipo_taxa TEXT,
      rentabilidade_12m NUMERIC(12,4),
      vencimento DATE,
      emissor TEXT,
      instituicao TEXT,
      status TEXT,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_investimentos_usuario ON investimentos(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_investimentos_item ON investimentos(pluggy_item_id);
  `);

  // ─── Módulo Pluggy — Open Finance (Marco 3: webhook e sync de transações) ────
  // webhook_token: 1 por usuário (não por Item) -- precisa existir ANTES do
  // Item ser criado, para ir dentro de options.webhookUrl na geração do Connect
  // Token (só assim a Pluggy já nasce notificando esse Item sem uma chamada
  // POST /webhooks separada). Ver src/pluggy.js (gerarConnectToken).
  await pool.query(`
    ALTER TABLE pluggy_credenciais ADD COLUMN IF NOT EXISTS webhook_token TEXT UNIQUE;
  `);

  // erro_mensagem: detalhe amigável de item/error, para a UI explicar o que
  // aconteceu além do status bruto. ultimo_sync_em: usado como filtro "from"
  // na busca de transações do próximo sync incremental (evita rebuscar os
  // mesmos 365 dias de histórico a cada item/updated).
  await pool.query(`
    ALTER TABLE pluggy_items ADD COLUMN IF NOT EXISTS erro_mensagem TEXT;
    ALTER TABLE pluggy_items ADD COLUMN IF NOT EXISTS ultimo_sync_em TIMESTAMPTZ;
  `);

  // Dedup de transações sincronizadas — UNIQUE em coluna nullable permite
  // múltiplos NULL (transações manuais) sem conflito entre si no Postgres.
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS pluggy_transaction_id TEXT UNIQUE;
  `);

  // categoria_manual: marca que a categoria daquela linha foi escolhida pelo
  // USUÁRIO (painel, WhatsApp ou IA), não pela sincronização. Bug de produção
  // que motiva a coluna: upsertTransacaoPluggy reescrevia categoria a cada
  // re-sync (comportamento correto para valor/status — PENDING→POSTED), o que
  // destruía silenciosamente qualquer correção manual. Com a flag, o re-sync
  // continua atualizando valor/status/data/descrição e só preserva a categoria.
  // DEFAULT FALSE + NOT NULL não reescreve a tabela no PG 11+ (default é
  // guardado no catálogo), então é seguro mesmo com histórico grande.
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS categoria_manual BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  // ─── Aprendizado de categoria por estabelecimento ────────────────────────────
  // "Corrigi uma vez, todo lançamento futuro do mesmo lugar já vem certo."
  // chave_estabelecimento é derivada da descrição por normalizarEstabelecimento
  // (src/estabelecimento.js) — função pura, mesma chave na gravação e na leitura.
  //
  // tipo entra na UNIQUE de propósito: "Transferência enviada|FULANO" e
  // "Transferência Recebida|FULANO" normalizam para a MESMA chave, mas são
  // despesa e receita. Sem o tipo na chave, uma categoria de despesa vazaria
  // para uma receita (e vice-versa) no próximo sync — categoria errada e do
  // tipo errado. Duas linhas para o mesmo nome é o comportamento correto aqui.
  //
  // Sem índice adicional: a UNIQUE já cria um índice com usuario_id na primeira
  // coluna, que atende tanto a consulta por (usuario_id, chave, tipo) quanto
  // qualquer varredura por usuario_id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categoria_aprendida (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      chave_estabelecimento TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('despesa', 'receita')),
      categoria TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (usuario_id, chave_estabelecimento, tipo)
    );
  `);

  // ─── Parcelamento de compra no cartão (Pluggy creditCardMetadata) ───────────
  // parcela_atual/parcela_total: dados estruturados da Pluggy (com fallback
  // pela descrição só em cartão — ver src/parcelamento.js). parcela_grupo:
  // chave heurística que amarra as parcelas da MESMA compra, porque o Open
  // Finance não devolve identificador de compra (confirmado na doc da Pluggy).
  // Todas nullable: transação manual, de conta corrente ou à vista não tem
  // parcelamento nenhum, e NULL aqui significa exatamente isso — sem
  // parcela_grupo a projeção simplesmente não enxerga a linha (feature inerte
  // para o histórico já sincronizado, até a próxima sincronização completa).
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS parcela_atual SMALLINT;
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS parcela_total SMALLINT;
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS parcela_grupo TEXT;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_transacoes_parcela_grupo
      ON transacoes(usuario_id, parcela_grupo)
      WHERE parcela_grupo IS NOT NULL;
  `);

  // ─── Aprendizado de categoria por DOCUMENTO da contraparte ──────────────────
  // A Pluggy entrega CPF/CNPJ de quem pagou/recebeu em praticamente toda
  // transação de conta — identidade muito mais estável que o texto da
  // descrição, que muda de forma a cada lançamento do mesmo prestador.
  //
  // A coluna guarda HASH, nunca o documento: é dado pessoal de TERCEIRO e o
  // produto não precisa do valor, só de saber se é a mesma contraparte. HMAC
  // com a chave mestra da instalação, que vive fora do banco — ver
  // src/contraparte.js para o raciocínio completo (CPF puro tem espaço de
  // busca pequeno demais para um hash sem segredo proteger alguma coisa).
  //
  // Tabela separada de categoria_aprendida, e não uma coluna a mais lá, para
  // não mexer na UNIQUE de uma tabela que já está em produção com dado do
  // usuário — migração aditiva pura, sem janela de risco.
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS contraparte_hash TEXT;
  `);
  // ─── Nome limpo do estabelecimento (Pluggy merchant.businessName) ───────────
  // descricao_exibicao: nome do estabelecimento como a Pluggy conhece, quando
  // ela conhece (cobertura baixa — enriquecimento opcional, nunca requisito).
  // A descrição CRUA continua em `descricao`: é ela que alimenta a chave de
  // aprendizado por estabelecimento e a busca por texto, e perder o texto
  // original do banco seria perder informação que não volta.
  //
  // descricao_manual: mesma ideia de categoria_manual, para o campo descrição.
  // Sem essa marca não dá para cumprir a regra que a feature exige — "nome
  // limpo nunca sobrescreve o que o usuário escreveu" —, porque não haveria
  // como distinguir descrição vinda do banco de descrição digitada por ele.
  await pool.query(`
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS descricao_exibicao TEXT;
    ALTER TABLE transacoes ADD COLUMN IF NOT EXISTS descricao_manual BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categoria_aprendida_documento (
      id SERIAL PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      documento_hash TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('despesa', 'receita')),
      categoria TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (usuario_id, documento_hash, tipo)
    );
  `);

  // ─── Modelo de acumulação: projeção explícita, janela e consolidação ───────
  //
  // Contexto. Até aqui o sistema assumia UMA transação por (recorrência, mês):
  // o índice único idx_transacoes_recorrencia_mes proibia a segunda, e
  // limparRecorrenciasDuplicadas apagava a segunda a cada boot. Isso conteve o
  // bug de materialização em duplicata, mas é incompatível com o que o produto
  // passa a fazer: uma receita recorrente pode chegar em VÁRIAS entradas no
  // mesmo mês (salário + comissão, por exemplo), e todas são legítimas.
  //
  // O que muda: a trava deixa de ser "uma transação por mês" e passa a ser
  // "uma PROJEÇÃO por mês". Para isso a projeção deixa de ser inferida
  // (`pendente` + sem pluggy_transaction_id — que também descreve um
  // lançamento manual do usuário) e vira coluna explícita `projetada`.
  //
  // Cada bloco abaixo é idempotente E tem try/catch próprio: migração que
  // falha loga e o boot segue. Um erro aqui já derrubou produção em loop de
  // restart e não pode se repetir. A ORDEM importa e está comentada em cada
  // etapa.

  // (0) Registro de migrações de uma passada só. Existe por causa do backfill
  // de `projetada`, que é heurístico: rodar a cada boot marcaria como projeção
  // lançamentos manuais pendentes criados DEPOIS da migração, e a limpeza os
  // apagaria. Uma vez aplicado, nunca mais roda.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migracoes_aplicadas (
        nome TEXT PRIMARY KEY,
        aplicada_em TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar migracoes_aplicadas (backfills de uma passada podem repetir):', err.message);
  }

  // (1) Colunas novas em transacoes.
  //   projetada  — esta linha foi materializada por uma regra de recorrência
  //                (não é um fato do extrato). É a chave da trava nova.
  //   observacao — texto livre do usuário, para anotar o que aquela entrada
  //                é ("comissão", "13º"). Nunca escrito pelo sync.
  try {
    await pool.query(`
      ALTER TABLE transacoes
        ADD COLUMN IF NOT EXISTS projetada BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE transacoes
        ADD COLUMN IF NOT EXISTS observacao TEXT;
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar colunas projetada/observacao:', err.message);
  }

  // (2) Backfill de `projetada` para o histórico. Heurística de uma passada só,
  // a mesma que o código usava para inferir projeção antes da coluna existir.
  // Best-effort assumido: um lançamento manual pendente vinculado à mão a uma
  // recorrência (via tornarTransacaoRecorrente) é indistinguível de uma
  // projeção nos dados antigos e será marcado como projeção. Daqui para frente
  // não há ambiguidade — só adicionarTransacaoComRecorrencia marca projetada.
  try {
    const jaAplicada = await pool.query(
      `SELECT 1 FROM migracoes_aplicadas WHERE nome = 'backfill_projetada_2026_08'`
    );
    if (jaAplicada.rows.length === 0) {
      const res = await pool.query(`
        UPDATE transacoes SET projetada = TRUE
        WHERE recorrencia_id IS NOT NULL
          AND pluggy_transaction_id IS NULL
          AND status = 'pendente'
          AND projetada = FALSE
      `);
      await pool.query(
        `INSERT INTO migracoes_aplicadas (nome) VALUES ('backfill_projetada_2026_08')
         ON CONFLICT (nome) DO NOTHING`
      );
      console.log(`[DB] initTables: backfill de transacoes.projetada aplicado (${res.rowCount} linha[s]).`);
    }
  } catch (err) {
    console.error('[DB] initTables: falha no backfill de projetada (boot segue):', err.message);
  }

  // (3) Janela explícita da recorrência. Até aqui a janela de casamento era
  // derivada em código (dia_mes ± 5); agora é dado da regra, editável.
  //
  // O backfill preserva o comportamento atual: [dia_mes - 5, dia_mes + 5],
  // grampeado em [1, 31]. Só preenche onde está NULL, então é idempotente e
  // não desfaz janela que o usuário tenha ajustado. Diferença conhecida e
  // aceita: para dia_mes >= 29 em mês curto, a janela derivada antiga
  // encostava no último dia do mês pelo lado de baixo (fevereiro, dia 23);
  // a explícita fica um ou dois dias mais estreita. Frequência semanal/diária
  // não usa essas colunas — continua no dia da semana (ver recorrencia-match).
  try {
    await pool.query(`
      ALTER TABLE recorrencias
        ADD COLUMN IF NOT EXISTS dia_inicial INTEGER CHECK (dia_inicial BETWEEN 1 AND 31);
      ALTER TABLE recorrencias
        ADD COLUMN IF NOT EXISTS dia_limite INTEGER CHECK (dia_limite BETWEEN 1 AND 31);
    `);
    await pool.query(`
      UPDATE recorrencias
      SET dia_inicial = GREATEST(1, dia_mes - 5),
          dia_limite  = LEAST(31, dia_mes + 5)
      WHERE dia_mes IS NOT NULL
        AND frequencia IN ('mensal', 'anual')
        AND (dia_inicial IS NULL OR dia_limite IS NULL)
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar/backfillar janela das recorrências:', err.message);
  }

  // (3b) Faixa de valor da recorrência — o segundo eixo do casamento, ao lado
  // da janela de dias ("entre R$ 1.500 e R$ 2.500 entre os dias 1 e 5").
  //
  // SEM BACKFILL, de propósito: NULL nos dois lados significa "regra sem
  // faixa", e regra sem faixa se comporta exatamente como antes destas colunas
  // existirem (o balde fecha em recorrencias.valor, nenhum lançamento é
  // eliminado por valor). É o que mantém as regras que já estão no banco
  // intactas — inventar uma faixa para elas mudaria em silêncio o que já casa
  // hoje.
  //
  // SEM CONSTRAINT, também de propósito. A checagem que faria sentido é entre
  // as duas colunas (valor_min <= valor_max), e constraint de tabela não tem
  // ADD ... IF NOT EXISTS: cada boot seguinte tentaria criar de novo e falharia
  // no duplicate_object. A validação mora em normalizarRegraCasamento, e
  // faixaDaRegra (src/recorrencia-match.js) ignora faixa invertida que já
  // esteja gravada. ADD COLUMN de coluna anulável sem default é metadado puro
  // no Postgres — não reescreve a tabela e não trava o boot.
  try {
    await pool.query(`
      ALTER TABLE recorrencias
        ADD COLUMN IF NOT EXISTS valor_min NUMERIC(12,2);
      ALTER TABLE recorrencias
        ADD COLUMN IF NOT EXISTS valor_max NUMERIC(12,2);
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar faixa de valor das recorrências:', err.message);
  }

  // (4) Consolidação: fecha o mês de uma recorrência pelo total REAL que
  // entrou, em vez do valor previsto. Tabela própria (e não uma coluna em
  // recorrencias) porque é um fato POR COMPETÊNCIA, e porque apagar a linha é
  // o desfazer — a ação é reversível por construção.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recorrencias_consolidacoes (
        id SERIAL PRIMARY KEY,
        usuario_id TEXT NOT NULL,
        recorrencia_id INTEGER NOT NULL REFERENCES recorrencias(id) ON DELETE CASCADE,
        competencia TEXT NOT NULL,
        valor_total NUMERIC(12,2) NOT NULL,
        quantidade INTEGER NOT NULL DEFAULT 0,
        consolidado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (recorrencia_id, competencia)
      );
      CREATE INDEX IF NOT EXISTS idx_consolidacoes_usuario
        ON recorrencias_consolidacoes(usuario_id, competencia);
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar recorrencias_consolidacoes:', err.message);
  }

  // (5) Limpeza retroativa — AGORA só de projeções em duplicata. Precisa rodar
  // ANTES da criação do índice (duplicata remanescente faz o CREATE falhar) e
  // DEPOIS do backfill de `projetada` (sem ele não haveria o que comparar).
  // Ver limparProjecoesDuplicadas para o motivo de ela ter deixado de apagar
  // "toda segunda linha do mês".
  try {
    await limparProjecoesDuplicadas();
  } catch (err) {
    console.error('[DB] initTables: falha ao limpar projeções duplicadas (boot segue sem a limpeza):', err.message);
  }

  // (6) Fora a trava antiga. Ela proíbe exatamente o que a acumulação exige:
  // duas transações reais da mesma recorrência no mesmo mês. Enquanto ela
  // existir, a segunda entrada do mês é recusada com 23505 e o vínculo é
  // perdido (upsertTransacaoPluggy degrada para lançamento avulso).
  try {
    await pool.query(`DROP INDEX IF EXISTS idx_transacoes_recorrencia_mes;`);
  } catch (err) {
    console.error('[DB] initTables: falha ao remover idx_transacoes_recorrencia_mes (acumulação fica bloqueada):', err.message);
  }

  // (7) Trava nova: no máximo uma PROJEÇÃO por (recorrência, mês) — que era o
  // bug original — e nenhum limite para lançamentos reais.
  //
  // data::timestamp (não timestamptz) força a sobrecarga IMMUTABLE de
  // date_trunc — obrigatório para entrar em índice. O ON CONFLICT de
  // adicionarTransacaoComRecorrencia precisa citar a MESMA expressão e o MESMO
  // predicado, literalmente, ou o Postgres não reconhece o alvo do conflito.
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transacoes_projecao_mes
        ON transacoes (recorrencia_id, (date_trunc('month', data::timestamp)))
        WHERE recorrencia_id IS NOT NULL AND projetada = TRUE;
    `);
  } catch (err) {
    console.error('[DB] initTables: falha ao criar idx_transacoes_projecao_mes (boot segue sem a trava de índice):', err.message);
  }
}

// ─── Recorrências ────────────────────────────────────────────────────────────

// Origem de um lançamento é exclusiva: ou cartão, ou conta, nunca as duas.
// Regra única para transacoes e recorrencias — cartão vence, porque é a origem
// que muda o comportamento financeiro (compra no cartão não sai da conta na
// hora, sai na fatura).
function normalizarOrigem(cartaoId, contaId) {
  const cartao = cartaoId || null;
  return { cartaoId: cartao, contaId: cartao ? null : (contaId || null) };
}

// normalizarRegraCasamento -> { diaInicial, diaLimite, valorMin, valorMax }
//
// Os dois eixos com que o usuário afina o casamento entre lançamento importado
// e regra: em que faixa de DIAS a ocorrência daquele mês cai, e em que faixa de
// VALOR o mês inteiro pode somar. Ver src/recorrencia-match.js para o uso.
//
// Ausência é resposta legítima e vira NULL: regra sem janela cai no dia_mes ± 5
// derivado em código, e regra sem faixa fecha o balde no próprio valor — o
// comportamento de antes destas colunas existirem. Nenhum dos dois campos é
// obrigatório, e todo caminho que cria recorrência (WhatsApp, painel, API)
// passa por aqui, inclusive os que nem sabem que eles existem.
//
// A janela é gravada só quando os DOIS lados vêm: limitesDaJanela precisa do
// par para valer, e meia janela seria pior que nenhuma (o fallback derivado é
// coerente, meio dado não é).
//
// Inversão (início > limite, mínimo > máximo) é erro de digitação e vira
// exceção em vez de dado gravado: uma faixa invertida não é satisfeita por
// lançamento nenhum, e falhar calado transformaria isso em "esta regra nunca
// mais casa", meses depois, sem pista.
function normalizarRegraCasamento({ diaInicial, diaLimite, valorMin, valorMax, frequencia } = {}) {
  const dia = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
  };
  const dinheiro = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  };

  let inicial = dia(diaInicial);
  let limite = dia(diaLimite);
  if (inicial !== null && limite !== null && inicial > limite) {
    throw new Error('Janela de dias inválida: o dia inicial não pode ser maior que o dia limite');
  }
  // Janela é conceito de mês. Semanal/diária casam pelo dia da semana e
  // ignorariam estas colunas — gravá-las só criaria dado morto e confuso.
  if (inicial === null || limite === null || (frequencia && frequencia !== 'mensal' && frequencia !== 'anual')) {
    inicial = null;
    limite = null;
  }

  const min = dinheiro(valorMin);
  const max = dinheiro(valorMax);
  if (min !== null && max !== null && min > max) {
    throw new Error('Faixa de valor inválida: o mínimo não pode ser maior que o máximo');
  }

  return { diaInicial: inicial, diaLimite: limite, valorMin: min, valorMax: max };
}

// `regra` (último argumento, opcional) carrega janela de dias e faixa de valor
// — ver normalizarRegraCasamento. Objeto em vez de mais quatro posicionais
// porque a lista já tem doze, e os chamadores antigos (agente do WhatsApp,
// importação de extrato) continuam válidos sem tocar em nada: sem o argumento,
// as quatro colunas ficam NULL e a regra se comporta como sempre.
async function criarRecorrencia(usuarioId, tipo, valor, descricao, categoria, frequencia, diaMes, diaSemana, dataInicio, dataFim, cartaoId = null, contaId = null, regra = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const origem = normalizarOrigem(cartaoId, contaId);
  const casamento = normalizarRegraCasamento({ ...regra, frequencia });
  const result = await pool.query(
    `INSERT INTO recorrencias
       (usuario_id, tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, data_fim, cartao_id, conta_id,
        dia_inicial, dia_limite, valor_min, valor_max)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [uid, tipo, valor, descricao, categoria || 'Outros', frequencia,
     diaMes || null, diaSemana || null,
     dataInicio || dataHojeBR(), dataFim || null,
     origem.cartaoId, origem.contaId,
     casamento.diaInicial, casamento.diaLimite, casamento.valorMin, casamento.valorMax]
  );
  return result.rows[0].id;
}

async function listarRecorrencias(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, tipo, valor::float, descricao, categoria, frequencia,
            dia_mes, dia_semana, cartao_id, conta_id,
            dia_inicial, dia_limite,
            valor_min::float AS valor_min, valor_max::float AS valor_max,
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
          // Origem herdada da regra: quem materializa a ocorrência precisa saber
          // se o lançamento nasce no cartão ou na conta (regra antiga é genérica
          // e traz os dois NULL).
          cartao_id:      regra.cartao_id || null,
          conta_id:       regra.conta_id  || null,
          status:         'projetado',
        });
      }
      d.setDate(d.getDate() + 1);
    }
  }
  return ocorrencias;
}

// Cria transação com vínculo à regra de recorrência.
// A origem (cartaoId/contaId) vem da regra — ver normalizarOrigem: cartão e
// conta são mutuamente exclusivos, senão o lançamento entraria duas vezes no
// saldo (uma direto na conta, outra pela fatura).
//
// `projetada` diz se a linha é uma PROJEÇÃO (o sistema materializando a
// ocorrência de uma regra) ou um lançamento real que por acaso nasce vinculado
// à regra (onboarding declarando o que já aconteceu, "pular ocorrência",
// confirmação do usuário). O default é FALSE de propósito: um chamador novo
// que esqueça o parâmetro cria um lançamento real a mais — visível e
// corrigível — em vez de disputar em silêncio o slot único da projeção com
// ON CONFLICT DO NOTHING, que engoliria a linha sem erro nenhum.
async function adicionarTransacaoComRecorrencia(usuarioId, tipo, valor, descricao, categoria, data, status, recorrenciaId, cartaoId = null, contaId = null, projetada = false) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const origem = normalizarOrigem(cartaoId, contaId);
  // ON CONFLICT contra idx_transacoes_projecao_mes (recorrencia_id + mês, só
  // para projetada = TRUE): esta função é chamada em laço por
  // GET /api/transactions (materialização de projeções) e pode ser acionada de
  // novo para a mesma ocorrência por requisições concorrentes/repetidas. Sem o
  // DO NOTHING o INSERT falharia com 23505 e o laço quebraria no meio.
  //
  // O predicado do ON CONFLICT repete o do índice palavra por palavra — é
  // assim que o Postgres identifica qual índice arbitra o conflito. Como a
  // trava só existe para projeção, uma inserção real (projetada = FALSE) não
  // tem alvo de conflito e precisa de um INSERT sem a cláusula: duas entradas
  // reais no mesmo mês são exatamente o que a acumulação permite.
  const result = projetada
    ? await pool.query(
      `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status, recorrencia_id, cartao_id, conta_id, projetada, numero_usuario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE,
         (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
       ON CONFLICT (recorrencia_id, (date_trunc('month', data::timestamp)))
         WHERE recorrencia_id IS NOT NULL AND projetada = TRUE
       DO NOTHING
       RETURNING id, numero_usuario`,
      [uid, tipo, valor, descricao, categoria || 'Outros',
       data || dataHojeBR(), status || 'pago', recorrenciaId || null,
       origem.cartaoId, origem.contaId]
    )
    : await pool.query(
      `INSERT INTO transacoes (usuario_id, tipo, valor, descricao, categoria, data, status, recorrencia_id, cartao_id, conta_id, projetada, numero_usuario)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE,
         (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
       RETURNING id, numero_usuario`,
      [uid, tipo, valor, descricao, categoria || 'Outros',
       data || dataHojeBR(), status || 'pago', recorrenciaId || null,
       origem.cartaoId, origem.contaId]
    );
  if (result.rows.length === 0) {
    // Já existe PROJEÇÃO daquela recorrência neste mês — não é erro, é o caso
    // normal que a trava do banco existe para cobrir.
    return { lastInsertRowid: null, dbId: null, duplicado: true };
  }
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
  // evitando double-counting com o pagamento da fatura (que é uma despesa separada).
  // Exclusão precisa ser SIMÉTRICA entre receita e despesa — bug de produção (mesma
  // classe do fix em calcularSaldos): "(cartao_id IS NULL OR tipo = 'receita')" deixava
  // QUALQUER receita passar, mesmo com cartao_id preenchido (ex: receita pendente
  // sincronizada no cartão pela Pluggy) — inflava o widget "Receitas" do dashboard.
  const totaisResult = await pool.query(
    `SELECT
       tipo,
       status,
       SUM(valor)::float as total,
       COUNT(*)::int as quantidade
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
       AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
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
       AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
     GROUP BY categoria, tipo
     ORDER BY total DESC`,
    [uid, inicioMes, fimMes]
  );

  // Compra de cartão nunca está "em atraso" — quem vence é a fatura, não a
  // compra individual (data = data da compra, não data de pagamento). Mesma
  // exclusão simétrica usada em totaisResult/catResult acima e em calcularSaldos.
  const atrasadasResult = await pool.query(
    `SELECT tipo, COUNT(*)::int as quantidade, SUM(valor)::float as total
     FROM transacoes
     WHERE usuario_id = $1
       AND status = 'pendente'
       AND data >= $2 AND data <= $3
       AND data < CURRENT_DATE
       AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
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
      // SOMA, não existência: com acumulação, ter uma entrada não quer dizer
      // que o mês está satisfeito — pode ter chegado metade. Projeções entram
      // na soma de propósito, porque elas já aparecem em `totais` como
      // lançadas; somá-las aqui é o que zera a projeção extra.
      const existRes = await pool.query(
        `SELECT recorrencia_id, SUM(valor)::float AS total FROM transacoes
         WHERE usuario_id = $1
           AND recorrencia_id = ANY($2::int[])
           AND TO_CHAR(data, 'YYYY-MM') = $3
         GROUP BY recorrencia_id`,
        [uid, ids, anoMes]
      );
      const somaPorRegra = new Map(existRes.rows.map(row => [row.recorrencia_id, row.total]));
      const consolidadas = new Set(
        (await listarConsolidacoesNoPeriodo(uid, anoMes, anoMes)).map(c => c.recorrencia_id)
      );
      const porId = new Map(regras.map(r => [r.id, r]));
      const hoje = dataHojeBR();

      for (const o of ocorrencias) {
        const falta = faltaDaOcorrencia(
          o, porId.get(o.recorrencia_id), somaPorRegra.get(o.recorrencia_id) || 0,
          { consolidado: consolidadas.has(o.recorrencia_id), hoje }
        );
        if (falta <= 0) continue;

        // Adicionar à lista de totais como pendente
        const existingTotais = totais.find(t => t.tipo === o.tipo && t.status === 'pendente');
        if (existingTotais) {
          existingTotais.total += falta;
          existingTotais.quantidade += 1;
        } else {
          totais.push({ tipo: o.tipo, status: 'pendente', total: falta, quantidade: 1 });
        }

        // Adicionar à lista por categoria
        const catEx = porCategoria.find(c => c.tipo === o.tipo && c.categoria === (o.categoria || 'Outros'));
        if (catEx) {
          catEx.total += falta;
          catEx.quantidade += 1;
        } else {
          porCategoria.push({ tipo: o.tipo, categoria: o.categoria || 'Outros', total: falta, quantidade: 1 });
        }

        // Se data já passou → atrasada
        if (o.data < hoje) {
          const atrasadaEx = atrasadas.find(at => at.tipo === o.tipo);
          if (atrasadaEx) {
            atrasadaEx.total += falta;
            atrasadaEx.quantidade += 1;
          } else {
            atrasadas.push({ tipo: o.tipo, quantidade: 1, total: falta });
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

// Ponto único de edição de campo de transação — usado pelo painel
// (src/webserver.js: PUT /api/transactions/:id), pelo fluxo WhatsApp
// (src/handlers.js: aplicarEdicaoTx) e pelo function calling da IA
// (src/agente-financeiro.js). Por isso a marcação de categoria manual mora
// aqui: qualquer caminho de edição fica protegido do re-sync sem duplicar regra.
async function atualizarTransacao(usuarioId, numeroUsuario, campo, novoValor) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const camposPermitidos = ['valor', 'data', 'descricao', 'categoria', 'conta_id', 'observacao'];
  if (!camposPermitidos.includes(campo)) throw new Error(`Campo inválido: ${campo}`);

  // Literal fixo, não interpolação de entrada — campo já passou pelo whitelist
  // acima (mesma proteção que o `SET ${campo}` existente).
  //
  // descricao_manual existe pelo mesmo motivo de categoria_manual: sem a marca,
  // o re-sync (e o nome limpo vindo de merchant.businessName) não teria como
  // saber que aquele texto foi escrito pelo usuário e o sobrescreveria.
  const marcarManual = campo === 'categoria' ? ', categoria_manual = TRUE'
    : campo === 'descricao' ? ', descricao_manual = TRUE'
    : '';

  // Origem exclusiva (ver normalizarOrigem): lançamento de cartão nunca recebe
  // conta_id. Sem esse CASE, editar uma compra no cartão pelo painel gravava a
  // conta padrão junto do cartão — as duas colunas preenchidas, que é a
  // condição exata do bug de saldo em dobro já corrigido retroativamente em
  // initTables. Também literal fixo, sem interpolação de entrada.
  const setClause = campo === 'conta_id'
    ? 'conta_id = CASE WHEN cartao_id IS NULL THEN $1::int ELSE NULL END'
    : `${campo} = $1${marcarManual}`;

  const result = await pool.query(
    `UPDATE transacoes SET ${setClause}
     WHERE numero_usuario = $2 AND usuario_id = $3
     RETURNING numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, cartao_id, conta_id, contraparte_hash`,
    [novoValor, numeroUsuario, uid]
  );
  const atualizada = result.rows[0] || null;

  // Aprendizado por estabelecimento: corrigir uma vez vale para os PRÓXIMOS
  // lançamentos do mesmo lugar (ver registrarCategoriaAprendida). Nunca derruba
  // a edição em si — se o aprendizado falhar, a transação já foi atualizada e
  // era isso que o usuário pediu.
  //
  // Os dois aprendizados são gravados quando a transação tem documento da
  // contraparte: o textual continua cobrindo os lançamentos sem paymentData
  // (compra no cartão, por exemplo), e o por documento cobre o mesmo prestador
  // quando ele aparece com outra descrição. Um não substitui o outro.
  if (atualizada && campo === 'categoria') {
    try {
      await registrarCategoriaAprendida(uid, atualizada.descricao, atualizada.tipo, atualizada.categoria);
    } catch (err) {
      console.error('[DB] Falha ao registrar categoria aprendida (edição preservada):', err.message);
    }
    if (atualizada.contraparte_hash) {
      try {
        await registrarCategoriaAprendidaDocumento(uid, atualizada.contraparte_hash, atualizada.tipo, atualizada.categoria);
      } catch (err) {
        console.error('[DB] Falha ao registrar categoria aprendida por documento (edição preservada):', err.message);
      }
    }
  }

  // contraparte_hash é detalhe interno do aprendizado — não vai para a resposta
  // da API nem para a tela. Quem chama recebe exatamente os campos de antes.
  if (atualizada) delete atualizada.contraparte_hash;

  return atualizada;
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
            cartao_id, conta_id,
            TO_CHAR(data_inicio, 'YYYY-MM-DD') as data_inicio,
            TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim
     FROM recorrencias
     WHERE id = $1 AND usuario_id = $2 AND ativo = TRUE`,
    [recorrenciaId, uid]
  );
  return result.rows[0] || null;
}

// Transforma um lançamento JÁ EXISTENTE em regra de recorrência.
//
// Decisão: a regra criada só PROJETA, nunca materializa as ocorrências futuras.
// É o comportamento que o resto do sistema já assume — lembretes.js materializa
// só a ocorrência de HOJE, e /api/transactions materializa só o MÊS CORRENTE.
// Materializar 6, 12 ou infinitos meses à frente criaria lançamentos que o
// usuário nunca fez: entrariam no saldo, virariam "atrasadas" quando a data
// passasse sem pagamento, e o desfazer (desativarRecorrencia) só apaga as
// pendentes — as que ficassem pagas por engano sobreviveriam.
//
// Vincular a transação de origem à regra (transacoes.recorrencia_id) não é só
// rastreabilidade: é o supressor de dupla contagem. Enquanto existir transação
// com aquele recorrencia_id naquele YYYY-MM, a projeção da mesma regra para o
// mesmo mês não é somada de novo (ver resumoMensal, calcularSaldos e
// projetarProximosMeses).
//
// `opcoes` aceita, além de frequencia/vezes, a janela de dias e a faixa de
// valor da regra (diaInicial, diaLimite, valorMin, valorMax) — os dois eixos
// com que o próximo lançamento importado vai reconhecer esta recorrência. São
// opcionais: sem eles a regra nasce com o comportamento derivado de sempre.
async function tornarTransacaoRecorrente(usuarioId, numeroUsuario, opcoes = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const frequencia = opcoes.frequencia === 'semanal' ? 'semanal' : 'mensal';
  const vezes = (opcoes.vezes === null || opcoes.vezes === undefined || opcoes.vezes === '')
    ? null
    : parseInt(opcoes.vezes, 10);
  if (vezes !== null && (!Number.isFinite(vezes) || vezes < 2)) {
    throw new Error('Número de repetições inválido (mínimo 2)');
  }
  // Janela e faixa validadas ANTES de abrir a transação: erro de preenchimento
  // não precisa de conexão nem de BEGIN para ser recusado.
  const casamento = normalizarRegraCasamento({ ...opcoes, frequencia });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: sem isso, dois cliques no botão criariam duas regras para o
    // mesmo lançamento (a segunda passaria pelo teste de recorrencia_id antes
    // de a primeira gravar) e o mês seria contado em dobro.
    const txRes = await client.query(
      `SELECT id, tipo, valor::float, descricao, categoria,
              TO_CHAR(data, 'YYYY-MM-DD') as data, recorrencia_id, cartao_id, conta_id
       FROM transacoes
       WHERE numero_usuario = $1 AND usuario_id = $2
       FOR UPDATE`,
      [numeroUsuario, uid]
    );
    const tx = txRes.rows[0];
    if (!tx) {
      await client.query('ROLLBACK');
      return { erro: 'nao_encontrada' };
    }
    if (tx.recorrencia_id) {
      await client.query('ROLLBACK');
      return { erro: 'ja_recorrente', recorrencia_id: tx.recorrencia_id };
    }

    const base = new Date(tx.data + 'T12:00:00');
    const diaMes    = frequencia === 'mensal'  ? base.getDate() : null;
    const diaSemana = frequencia === 'semanal' ? base.getDay()  : null;

    // "X vezes" conta o próprio lançamento como a primeira ocorrência — mesma
    // semântica do modal de nova transação (nova-tx-rec-duracao-bar).
    // O overflow do setMonth (31/03 + 1 mês → 01/05) só empurra data_fim para
    // frente, nunca para trás, então não corta ocorrência prevista.
    let dataFim = null;
    if (vezes !== null) {
      const fim = new Date(base);
      if (frequencia === 'mensal') fim.setMonth(fim.getMonth() + (vezes - 1));
      else fim.setDate(fim.getDate() + (vezes - 1) * 7);
      dataFim = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-${String(fim.getDate()).padStart(2, '0')}`;
    }

    const origem = normalizarOrigem(tx.cartao_id, tx.conta_id);
    const recRes = await client.query(
      `INSERT INTO recorrencias
         (usuario_id, tipo, valor, descricao, categoria, frequencia, dia_mes, dia_semana, data_inicio, data_fim, cartao_id, conta_id,
          dia_inicial, dia_limite, valor_min, valor_max)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [uid, tx.tipo, tx.valor, tx.descricao, tx.categoria || 'Outros', frequencia,
       diaMes, diaSemana, tx.data, dataFim, origem.cartaoId, origem.contaId,
       casamento.diaInicial, casamento.diaLimite, casamento.valorMin, casamento.valorMax]
    );
    const recorrenciaId = recRes.rows[0].id;

    await client.query(
      `UPDATE transacoes SET recorrencia_id = $1 WHERE id = $2 AND usuario_id = $3`,
      [recorrenciaId, tx.id, uid]
    );

    await client.query('COMMIT');
    return {
      recorrencia_id: recorrenciaId,
      tipo:        tx.tipo,
      valor:       tx.valor,
      descricao:   tx.descricao,
      categoria:   tx.categoria,
      frequencia,
      dia_mes:     diaMes,
      dia_semana:  diaSemana,
      data_inicio: tx.data,
      data_fim:    dataFim,
      cartao_id:   origem.cartaoId,
      conta_id:    origem.contaId,
      dia_inicial: casamento.diaInicial,
      dia_limite:  casamento.diaLimite,
      valor_min:   casamento.valorMin,
      valor_max:   casamento.valorMax,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão já perdida */ }
    throw err;
  } finally {
    client.release();
  }
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
  // Só apaga o que o PRÓPRIO sistema projetou. Uma pendente vinda da Pluggy
  // (compra de cartão ainda não fechada, por exemplo) é fato consumado no
  // extrato do usuário: desativar a regra significa "pare de projetar", nunca
  // "apague o que já aconteceu". Sem o pluggy_transaction_id IS NULL o
  // lançamento real sumiria da tela e o sync incremental não o traria de
  // volta — a janela dele só busca transações novas.
  await pool.query(
    `DELETE FROM transacoes
     WHERE recorrencia_id = $1 AND usuario_id = $2
       AND status = 'pendente'
       AND pluggy_transaction_id IS NULL`,
    [recorrenciaId, uid]
  );
}

// ─── Consolidação de um mês de recorrência ───────────────────────────────────
//
// O QUE É: o usuário declara que aquele mês daquela recorrência está encerrado
// pelo que REALMENTE entrou, e não pelo valor previsto na regra. Nasce do caso
// em que o previsto é R$ 1.850 e o mês fechou com R$ 1.500 + R$ 350, ou com
// R$ 1.500 e mais nada.
//
// EFEITO CONCRETO NO BANCO, e nada além disto:
//   1. grava uma linha em recorrencias_consolidacoes com a SOMA REAL das
//      entradas daquele mês (projeções não entram na soma) e a quantidade;
//   2. apaga as projeções remanescentes do mês — o mês está fechado, uma
//      projeção pendurada ali contaria valor que não vai entrar;
//   3. nada mais. Não altera as transações reais, não mexe em recorrencias.valor.
//
// EFEITO NA PREVISÃO: enquanto existir a linha de consolidação, aquele mês
// daquela recorrência não recebe projeção nenhuma (nem cheia nem parcial) nos
// cálculos de saldo, resumo e previsão, e novas entradas da Pluggy não entram
// mais no balde — viram lançamentos avulsos. Os MESES SEGUINTES seguem
// projetando recorrencias.valor normalmente: consolidar setembro não redefine
// o previsto de outubro. Se o valor da regra mudou de fato, quem muda é o
// usuário, editando a regra — o sistema não reescreve a expectativa futura por
// conta de um mês atípico.
//
// REVERSÍVEL: sim, e é por isso que é tabela e não flag espalhada nas
// transações. desconsolidarRecorrenciaMes apaga a linha e o mês volta a
// acumular e a projetar. O que a reversão NÃO desfaz são as projeções apagadas
// no passo 2 — elas eram estimativa, e o painel materializa de novo na
// próxima visita se o mês ainda estiver sem entrada real.
async function consolidarRecorrenciaMes(usuarioId, recorrenciaId, competencia) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  if (!/^\d{4}-\d{2}$/.test(String(competencia || ''))) {
    throw new Error('Competência inválida (esperado YYYY-MM)');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const regraRes = await client.query(
      `SELECT id FROM recorrencias WHERE id = $1 AND usuario_id = $2`,
      [recorrenciaId, uid]
    );
    if (regraRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { erro: 'nao_encontrada' };
    }

    const somaRes = await client.query(
      `SELECT COALESCE(SUM(valor), 0)::float AS total, COUNT(*)::int AS quantidade
       FROM transacoes
       WHERE usuario_id = $1 AND recorrencia_id = $2
         AND projetada = FALSE
         AND TO_CHAR(data, 'YYYY-MM') = $3`,
      [uid, recorrenciaId, competencia]
    );
    const { total, quantidade } = somaRes.rows[0];

    const projRes = await client.query(
      `DELETE FROM transacoes
       WHERE usuario_id = $1 AND recorrencia_id = $2
         AND projetada = TRUE
         AND TO_CHAR(data, 'YYYY-MM') = $3`,
      [uid, recorrenciaId, competencia]
    );

    // Reconsolidar o mesmo mês é atualizar o total, não empilhar linha nova.
    await client.query(
      `INSERT INTO recorrencias_consolidacoes (usuario_id, recorrencia_id, competencia, valor_total, quantidade)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (recorrencia_id, competencia)
       DO UPDATE SET valor_total = EXCLUDED.valor_total,
                     quantidade = EXCLUDED.quantidade,
                     consolidado_em = NOW()`,
      [uid, recorrenciaId, competencia, total, quantidade]
    );

    await client.query('COMMIT');
    return {
      recorrencia_id: recorrenciaId,
      competencia,
      valor_total: total,
      quantidade,
      projecoes_removidas: projRes.rowCount,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão já perdida */ }
    throw err;
  } finally {
    client.release();
  }
}

async function desconsolidarRecorrenciaMes(usuarioId, recorrenciaId, competencia) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `DELETE FROM recorrencias_consolidacoes
     WHERE usuario_id = $1 AND recorrencia_id = $2 AND competencia = $3`,
    [uid, recorrenciaId, competencia]
  );
  return { desfeita: res.rowCount > 0 };
}

// Consolidações que tocam um período, como chaves "recorrencia_id|YYYY-MM" —
// formato direto de consumo por quem projeta (ver faltaDaOcorrencia).
async function listarConsolidacoesNoPeriodo(usuarioId, dataInicio, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT recorrencia_id, competencia, valor_total::float AS valor_total
     FROM recorrencias_consolidacoes
     WHERE usuario_id = $1
       AND competencia >= $2 AND competencia <= $3`,
    [uid, String(dataInicio).slice(0, 7), String(dataFim).slice(0, 7)]
  );
  return res.rows;
}

// faltaDaOcorrencia -> quanto daquela ocorrência ainda se espera receber/pagar
//
// Substitui o antigo "já tem transação no mês? então não projeta nada". Com
// acumulação, ter UMA entrada não significa que o mês está satisfeito: o
// previsto pode ter chegado pela metade. Projetar o previsto cheio contaria
// duas vezes; projetar zero esconde o que ainda falta. A conta certa é a
// diferença.
//
// Casos, nesta ordem:
//   consolidado          -> 0   (usuário fechou o mês; o que entrou é o que foi)
//   nada entrou          -> previsto  (comportamento de sempre, inclusive o
//                                      alerta de "atrasada" quando a data passa)
//   soma >= previsto     -> 0
//   parcial, janela aberta -> previsto - soma
//   parcial, janela fechada -> 0  (o resto não vem mais)
//
// Repare que só o caso parcial é novo. Mês sem nenhuma entrada e mês já
// coberto continuam se comportando exatamente como antes.
function faltaDaOcorrencia(ocorrencia, regra, somaReal, opcoes = {}) {
  const { consolidado = false, hoje = dataHojeBR() } = opcoes;
  if (consolidado) return 0;

  const previsto = Number(ocorrencia.valor) || 0;
  const soma = Number(somaReal) || 0;
  if (soma <= 0) return previsto;
  if (soma >= previsto) return 0;

  const mesOcorrencia = String(ocorrencia.data).slice(0, 7);
  const mesHoje = String(hoje).slice(0, 7);
  if (mesOcorrencia < mesHoje) return 0;
  if (mesOcorrencia > mesHoje) return previsto - soma;
  return janelaEncerradaEm(regra, hoje) ? 0 : previsto - soma;
}

// buscarEstadosBaldeMes -> Map<recorrencia_id, estado> com o balde de TODAS as
// regras do usuário num mês, numa ÚNICA consulta agregada.
//
// Existe para o painel web: a lista de recorrências precisa mostrar, por
// regra, quanto já entrou de verdade contra o previsto. Chamar
// buscarEstadoBalde (linha ~6106) uma vez por regra vira N+1 assim que o
// usuário tem várias recorrências cadastradas — aqui é uma query de soma
// agregada com ANY($ids) mais a mesma travessia de ocorrências que
// resumoMensal/calcularSaldos/projetarProximosMeses já fazem. Não reimplementa
// "quanto falta": delega para faltaDaOcorrencia, a mesma função que essas três
// já usam.
//
// Recebe `regras` já carregadas (em vez de buscar de novo) porque quem chama
// — o GET /api/recorrencias — já precisa da lista completa para outra coisa;
// evita duas idas ao banco pela mesma tabela na mesma requisição.
//
// `falta` vem null quando a regra não tem nenhuma ocorrência prevista na
// competência pedida (ex.: regra criada depois daquele mês, ou frequência
// semanal que não cai naquele mês) — sem ocorrência não há o que projetar, e
// null distingue esse caso de "falta zero porque já foi satisfeito".
async function buscarEstadosBaldeMes(usuarioId, competencia, regras) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const comp = /^\d{4}-\d{2}$/.test(String(competencia || '')) ? competencia : dataHojeBR().slice(0, 7);

  const listaRegras = regras || await listarRecorrencias(uid);
  const estados = new Map();
  if (listaRegras.length === 0) return estados;

  const ids = listaRegras.map(r => r.id);

  // Soma e contagem de lançamentos REAIS do mês, por regra — mesmo filtro
  // (projetada = FALSE) usado em consolidarRecorrenciaMes e buscarEstadoBalde:
  // projeção não é dinheiro que entrou.
  const somaRes = await pool.query(
    `SELECT recorrencia_id,
            COALESCE(SUM(valor) FILTER (WHERE projetada = FALSE), 0)::float AS soma_real,
            COUNT(*) FILTER (WHERE projetada = FALSE)::int AS qtd_real
     FROM transacoes
     WHERE usuario_id = $1
       AND recorrencia_id = ANY($2::int[])
       AND TO_CHAR(data, 'YYYY-MM') = $3
     GROUP BY recorrencia_id`,
    [uid, ids, comp]
  );
  const somaPorRegra = new Map(somaRes.rows.map(r => [r.recorrencia_id, { somaReal: r.soma_real, qtdReal: r.qtd_real }]));

  const consolidadas = new Set(
    (await listarConsolidacoesNoPeriodo(uid, comp, comp)).map(c => c.recorrencia_id)
  );

  const [ano, mes] = comp.split('-').map(Number);
  const inicioMesObj = new Date(ano, mes - 1, 1);
  const fimMesObj = new Date(ano, mes, 0);
  const ocorrencias = calcularOcorrenciasNoPerodo(listaRegras, inicioMesObj, fimMesObj);
  const hoje = dataHojeBR();
  const porId = new Map(listaRegras.map(r => [r.id, r]));

  // Soma o previsto e a falta de todas as ocorrências da regra na competência
  // — cobre frequência semanal/diária, que pode disparar mais de uma vez no
  // mês; mensal/anual têm só uma.
  const previstoPorRegra = new Map();
  const faltaPorRegra = new Map();
  for (const o of ocorrencias) {
    const soma = (somaPorRegra.get(o.recorrencia_id) || {}).somaReal || 0;
    const falta = faltaDaOcorrencia(
      o, porId.get(o.recorrencia_id), soma,
      { consolidado: consolidadas.has(o.recorrencia_id), hoje }
    );
    previstoPorRegra.set(o.recorrencia_id, (previstoPorRegra.get(o.recorrencia_id) || 0) + (Number(o.valor) || 0));
    faltaPorRegra.set(o.recorrencia_id, (faltaPorRegra.get(o.recorrencia_id) || 0) + falta);
  }

  for (const id of ids) {
    const base = somaPorRegra.get(id) || { somaReal: 0, qtdReal: 0 };
    estados.set(id, {
      competencia: comp,
      somaReal: base.somaReal,
      qtdReal: base.qtdReal,
      previsto: previstoPorRegra.has(id) ? previstoPorRegra.get(id) : null,
      falta: faltaPorRegra.has(id) ? faltaPorRegra.get(id) : null,
      consolidado: consolidadas.has(id),
    });
  }
  return estados;
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
  const { tipo, categoria, dataInicio, dataFim, descricao, status, limite, recorrente, contaId, cartaoId } = filtros;
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);

  if (dataInicio && !dataInicioValida) {
    console.warn(`[DB] consultarTransacoes ignorou dataInicio invalida: "${dataInicio}" (uid=${uid})`);
  }
  if (dataFim && !dataFimValida) {
    console.warn(`[DB] consultarTransacoes ignorou dataFim invalida: "${dataFim}" (uid=${uid})`);
  }

  // descricao_exibida: nome limpo do estabelecimento quando existe, texto cru
  // do banco quando não. Descrição editada pelo usuário (descricao_manual)
  // vence sempre — o enriquecimento nunca pode apagar o que ele escreveu. O
  // campo `descricao` continua sendo devolvido cru: é ele que o modal de
  // edição carrega e o que a busca por texto casa.
  let query = `
    SELECT numero_usuario as id, tipo, valor::float, descricao, categoria, TO_CHAR(data, 'YYYY-MM-DD') as data, status, recorrencia_id, cartao_id, conta_id,
           parcela_atual, parcela_total, observacao, projetada,
           CASE WHEN descricao_manual THEN descricao
                ELSE COALESCE(NULLIF(descricao_exibicao, ''), descricao) END AS descricao_exibida
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
  // Filtro de origem: lançamento de cartão sempre tem cartao_id preenchido e
  // conta_id NULL; lançamento de conta é o inverso (nunca os dois juntos).
  if (contaId) {
    query += ` AND conta_id = $${idx++}`;
    params.push(contaId);
  }
  if (cartaoId) {
    query += ` AND cartao_id = $${idx++}`;
    params.push(cartaoId);
  }

  query += ` ORDER BY data DESC, id DESC LIMIT $${idx}`;
  params.push(limite || 20);

  const result = await pool.query(query, params);
  return result.rows;
}

// Usada por GET /api/transactions para decidir quais ocorrências projetadas
// já têm transação real (e não devem ser materializadas de novo). Query
// ENXUTA, e de propósito SEM qualquer filtro de tipo/conta/cartão/status —
// bug de produção corrigido aqui: reusar a lista já filtrada da própria
// requisição fazia o endpoint materializar a mesma recorrência de novo a
// cada combinação de filtro aberta no painel (idsComTransacao ficava vazio
// sempre que havia filtro, porque a recorrência não passava no filtro).
async function listarRecorrenciaIdsNoPeriodo(usuarioId, dataInicio, dataFim) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const dataInicioValida = normalizarDataISO(dataInicio);
  const dataFimValida = normalizarDataISO(dataFim);
  const result = await pool.query(
    `SELECT recorrencia_id, TO_CHAR(data, 'YYYY-MM-DD') as data
     FROM transacoes
     WHERE usuario_id = $1 AND recorrencia_id IS NOT NULL
       AND data >= $2 AND data <= $3`,
    [uid, dataInicioValida, dataFimValida]
  );
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
  // Compras no cartão (cartao_id IS NOT NULL) são excluídas: não saem da conta corrente diretamente.
  // Exclusão precisa ser SIMÉTRICA entre receita e despesa — bug de produção (achado ao investigar
  // saldo inflado após conexão Pluggy): só a CASE de despesa tinha a exclusão de cartão, então
  // receita lançada com cartao_id preenchido (ex: estorno/refund que a Pluggy sincroniza no cartão)
  // entrava no total sem a despesa correspondente sair — saldo inflado no valor dessas receitas.
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pago' AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %') THEN valor ELSE 0 END), 0)::float as receitas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'despesa' AND status = 'pago' AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %') THEN valor ELSE 0 END), 0)::float as despesas_pagas,
       COALESCE(SUM(CASE WHEN tipo = 'receita' AND status = 'pendente'
         AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
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
      // Mesma troca de "existe?" por "quanto falta?" de resumoMensal: o saldo
      // previsto de um mês que recebeu R$ 1.500 de R$ 1.850 ainda espera
      // R$ 350, não R$ 0 nem R$ 1.850.
      const existRes = await pool.query(
        `SELECT recorrencia_id, SUM(valor)::float AS total FROM transacoes
         WHERE usuario_id = $1
           AND recorrencia_id = ANY($2::int[])
           AND TO_CHAR(data, 'YYYY-MM') = $3
         GROUP BY recorrencia_id`,
        [uid, ids, anoMes]
      );
      const somaPorRegra = new Map(existRes.rows.map(row => [row.recorrencia_id, row.total]));
      const consolidadas = new Set(
        (await listarConsolidacoesNoPeriodo(uid, anoMes, anoMes)).map(c => c.recorrencia_id)
      );
      const porId = new Map(regras.map(r => [r.id, r]));
      for (const o of ocorrencias) {
        const falta = faltaDaOcorrencia(
          o, porId.get(o.recorrencia_id), somaPorRegra.get(o.recorrencia_id) || 0,
          { consolidado: consolidadas.has(o.recorrencia_id), hoje: dataHojeBR() }
        );
        if (falta <= 0) continue;
        if (o.tipo === 'receita') receitasRecorrentes += falta;
        else despesasRecorrentes += falta;
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
  };
}

// Patrimônio consolidado, DELIBERADAMENTE fora de calcularSaldos.
//
// Duas razões para ser função separada, e não mais um campo do retorno acima:
//
//  1. calcularSaldos responde "quanto tenho em conta". Patrimônio responde
//     "quanto eu valho". Misturar as duas perguntas foi o que fez o campo
//     `patrimonio` antigo (saldo + caixinhas) circular sem descontar a dívida
//     do cartão — superestimava o patrimônio de quem tinha fatura aberta.
//  2. mantém calcularSaldos sem NENHUMA referência a `investimentos`, que é a
//     garantia testada de que dinheiro aplicado não infla o saldo em conta.
//
// Devolve sempre os componentes, nunca só o total: quem exibe é obrigado a
// mostrar a composição. Reserva manual e investimento sincronizado podem ser o
// mesmo dinheiro (caixinha de banco é lastreada em CDB, e não há chave para
// deduplicar) — itemizar deixa a sobreposição visível para o usuário julgar,
// em vez de escondê-la dentro de um número só.
// saldosPrecomputados evita recalcular calcularSaldos quando quem chama já o
// tem em mãos (o fluxo de "saldo" no WhatsApp exibe os dois juntos).
async function calcularPatrimonio(usuarioId, saldosPrecomputados = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const saldos = saldosPrecomputados || await module.exports.calcularSaldos(uid);

  const invRes = await pool.query(
    `SELECT COALESCE(SUM(saldo), 0)::float as total
     FROM investimentos WHERE usuario_id = $1 AND ativo = TRUE`,
    [uid]
  );
  const investimentos = invRes.rows[0].total;

  // Dívida de cartão vem de obterUsoCartao — único ponto que decide Pluggy
  // (valor real da API) vs manual (ciclo de fatura). Recriar esse cálculo aqui
  // reintroduziria o bug que levou à consolidação daquela função.
  const cartoes = await module.exports.listarCartoes(uid);
  let faturaCartao = 0;
  for (const cartao of cartoes) {
    const uso = await module.exports.obterUsoCartao(cartao);
    if (typeof uso?.valorUsado === 'number') faturaCartao += uso.valorUsado;
  }

  const saldoContas = saldos.saldoAtual;
  const reservas = saldos.totalCaixinhas;

  return {
    saldoContas,
    reservas,
    investimentos,
    faturaCartao,
    total: saldoContas + reservas + investimentos - faturaCartao,
  };
}

// Projeção mês a mês para o card de previsão do painel.
//
// Não reimplementa matemática de data: usa calcularOcorrenciasNoPerodo (regras
// recorrentes) e projetarFaturasCartao (parcelas pendentes viram fatura), os
// mesmos motores que já rodam no mês corrente.
//
// Composição de cada mês, e por que cada parte não conta duas vezes:
//
//  1. LANÇADAS — transações que já existem no banco no mês (pagas e pendentes),
//     inclusive parcelas futuras. Filtro `cartao_id IS NULL OR descricao ILIKE
//     'Fatura %'`: compra no cartão não sai da conta na data da compra, sai na
//     fatura. É o mesmo filtro de resumoMensal e calcularSaldos.
//  2. FIXAS — ocorrências das regras recorrentes no mês, MENOS as que já viraram
//     transação naquele mês (chave recorrencia_id + YYYY-MM). Sem esse corte, a
//     parcela pendente futura já materializada com recorrencia_id seria somada
//     duas vezes: uma como lançada, outra como projetada.
//  3. FATURAS DE CARTÃO — projetarFaturasCartao soma as parcelas pendentes do
//     cartão por mês. Não colide com (1) porque essas parcelas foram excluídas
//     lá pelo filtro de cartão; e o cartão/mês que já tem transação "Fatura %"
//     é pulado, senão a fatura entraria por (1) e por (3).
//     Ocorrência de recorrência ainda NÃO materializada nunca está aqui — (3) só
//     enxerga transação existente — então (2) e (3) são disjuntos por construção.
//  4. PARCELAS FUTURAS AINDA NÃO LANÇADAS — parcelas de compra no cartão que o
//     banco ainda não enviou. Existem porque a Pluggy tem dois comportamentos,
//     conforme a instituição: uns bancos mandam todas as parcelas logo após a
//     compra (e aí elas já entram por (3), como transação pendente futura),
//     outros criam uma por vez a cada fatura fechada (e aí a previsão ficaria
//     cega para meses que já têm compromisso assumido). O corte é o mesmo de
//     (2): projeta a parcela que falta MENOS a que já virou transação — no
//     banco que manda tudo, a maior parcela conhecida já é a última e (4) soma
//     zero sozinho. Ver src/parcelamento.js:projetarParcelasRestantes.
//
// Limitação herdada de projetarFaturasCartao: ela só olha `data >= NOW()`, então
// a fatura projetada do mês corrente ignora compras já feitas neste mês. Mesmo
// comportamento do saldoPrevisao de calcularSaldos — consistente com o resto do
// painel.
async function projetarProximosMeses(usuarioId, meses = 6) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const qtd = Math.min(Math.max(parseInt(meses, 10) || 6, 1), 24);

  const pad = (n) => String(n).padStart(2, '0');
  const [anoBase, mesBase] = dataHojeBR().split('-').map(Number);

  // new Date(ano, mes-1+i, 1) resolve a virada de ano sozinho (dez → jan/+1).
  const janela = [];
  for (let i = 0; i < qtd; i++) {
    const d = new Date(anoBase, mesBase - 1 + i, 1);
    const ano = d.getFullYear();
    const mes = d.getMonth() + 1;
    const ultimoDia = new Date(ano, mes, 0).getDate();
    janela.push({
      ano,
      mes,
      chave:     `${ano}-${pad(mes)}`,
      inicio:    `${ano}-${pad(mes)}-01`,
      fim:       `${ano}-${pad(mes)}-${pad(ultimoDia)}`,
      inicioObj: new Date(ano, mes - 1, 1),
      fimObj:    new Date(ano, mes, 0),
      receitas:  { fixas: 0, lancadas: 0, total: 0 },
      despesas:  { fixas: 0, lancadas: 0, faturasCartao: 0, parcelas: 0, total: 0 },
      saldo:     0,
    });
  }
  const porChave = new Map(janela.map(m => [m.chave, m]));
  const inicioJanela = janela[0].inicio;
  const fimJanela    = janela[janela.length - 1].fim;

  // ── (1) Lançadas ───────────────────────────────────────────────────────────
  const lancadasRes = await pool.query(
    `SELECT TO_CHAR(data, 'YYYY-MM') as chave, tipo, SUM(valor)::float as total
     FROM transacoes
     WHERE usuario_id = $1
       AND data >= $2 AND data <= $3
       AND (cartao_id IS NULL OR descricao ILIKE 'Fatura %')
     GROUP BY chave, tipo`,
    [uid, inicioJanela, fimJanela]
  );
  for (const row of lancadasRes.rows) {
    const m = porChave.get(row.chave);
    if (!m) continue;
    if (row.tipo === 'receita') m.receitas.lancadas += row.total;
    else m.despesas.lancadas += row.total;
  }

  // ── (2) Fixas (recorrências) ───────────────────────────────────────────────
  const regras = await listarRecorrencias(uid);
  if (regras.length > 0) {
    const ocorrencias = calcularOcorrenciasNoPerodo(regras, janela[0].inicioObj, janela[janela.length - 1].fimObj);
    if (ocorrencias.length > 0) {
      const ids = [...new Set(ocorrencias.map(o => o.recorrencia_id))];
      const existRes = await pool.query(
        `SELECT recorrencia_id, TO_CHAR(data, 'YYYY-MM') as chave, SUM(valor)::float AS total
         FROM transacoes
         WHERE usuario_id = $1
           AND recorrencia_id = ANY($2::int[])
           AND data >= $3 AND data <= $4
         GROUP BY recorrencia_id, chave`,
        [uid, ids, inicioJanela, fimJanela]
      );
      // Soma por (recorrência, mês). O que já entrou é contado em LANÇADAS
      // (bloco 1 acima); FIXAS só carrega o que falta para o previsto — é
      // assim que o mês parcial fecha certo em vez de contar duas vezes ou
      // sumir com a diferença.
      const somaPorChave = new Map(existRes.rows.map(r => [`${r.recorrencia_id}|${r.chave}`, r.total]));
      const consolidadas = new Set(
        (await listarConsolidacoesNoPeriodo(uid, inicioJanela, fimJanela))
          .map(c => `${c.recorrencia_id}|${c.competencia}`)
      );
      const porId = new Map(regras.map(r => [r.id, r]));
      const hojeISO = dataHojeBR();

      for (const o of ocorrencias) {
        const chave = o.data.substring(0, 7);
        const m = porChave.get(chave);
        if (!m) continue;
        const falta = faltaDaOcorrencia(
          o, porId.get(o.recorrencia_id), somaPorChave.get(`${o.recorrencia_id}|${chave}`) || 0,
          { consolidado: consolidadas.has(`${o.recorrencia_id}|${chave}`), hoje: hojeISO }
        );
        if (falta <= 0) continue;
        if (o.tipo === 'receita') m.receitas.fixas += falta;
        else m.despesas.fixas += falta;
      }
    }
  }

  // ── (3) Faturas de cartão projetadas ───────────────────────────────────────
  const cartoesRes = await pool.query(
    `SELECT id FROM cartoes WHERE usuario_id = $1`, [uid]
  );
  if (cartoesRes.rows.length > 0) {
    const cartaoIds = cartoesRes.rows.map(c => c.id);
    const faturasRes = await pool.query(
      `SELECT DISTINCT cartao_id, TO_CHAR(data, 'YYYY-MM') as chave
       FROM transacoes
       WHERE usuario_id = $1
         AND cartao_id = ANY($2::int[])
         AND descricao ILIKE 'Fatura %'
         AND data >= $3 AND data <= $4`,
      [uid, cartaoIds, inicioJanela, fimJanela]
    );
    const faturaJaLancada = new Set(faturasRes.rows.map(r => `${r.cartao_id}|${r.chave}`));

    for (const cartaoId of cartaoIds) {
      const projMap = await projetarFaturasCartao(cartaoId, qtd);
      for (const m of janela) {
        if (faturaJaLancada.has(`${cartaoId}|${m.chave}`)) continue;
        const valor = projMap[m.chave];
        if (valor && valor > 0) m.despesas.faturasCartao += valor;
      }
    }

    // ── (4) Parcelas futuras que o banco ainda não lançou ────────────────────
    // Só entram as linhas com parcela_grupo gravado (sincronização a partir do
    // Marco de parcelamento). Histórico sincronizado antes disso tem NULL e
    // fica de fora — a projeção não inventa nada sobre dado que não tem, e uma
    // sincronização completa preenche retroativamente.
    //
    // Janela de busca até 24 meses para trás da janela exibida: parcelamento
    // longo (24x é o teto usual no Brasil) precisa da parcela conhecida mais
    // recente, que pode ser anterior ao mês corrente. Parcela cujo mês já
    // passou é descartada dentro de projetarParcelasRestantes.
    const parcelasRes = await pool.query(
      `SELECT cartao_id, parcela_grupo, parcela_atual, parcela_total, valor::float,
              TO_CHAR(data, 'YYYY-MM') as chave
       FROM transacoes
       WHERE usuario_id = $1
         AND cartao_id = ANY($2::int[])
         AND parcela_grupo IS NOT NULL
         AND parcela_atual IS NOT NULL
         AND parcela_total IS NOT NULL
         AND data >= ($3::date - INTERVAL '24 months')`,
      [uid, cartaoIds, inicioJanela]
    );

    const parcelasProjetadas = projetarParcelasRestantes(parcelasRes.rows, {
      chavesJanela: janela.map(m => m.chave),
      mesAtual: janela[0].chave,
      faturaJaLancada,
    });
    for (const m of janela) {
      const valor = parcelasProjetadas[m.chave];
      if (valor && valor > 0) m.despesas.parcelas += valor;
    }
  }

  const arredondar = (n) => Math.round(n * 100) / 100;
  for (const m of janela) {
    m.receitas.fixas    = arredondar(m.receitas.fixas);
    m.receitas.lancadas = arredondar(m.receitas.lancadas);
    m.receitas.total    = arredondar(m.receitas.fixas + m.receitas.lancadas);
    m.despesas.fixas         = arredondar(m.despesas.fixas);
    m.despesas.lancadas      = arredondar(m.despesas.lancadas);
    m.despesas.faturasCartao = arredondar(m.despesas.faturasCartao);
    m.despesas.parcelas      = arredondar(m.despesas.parcelas);
    m.despesas.total         = arredondar(m.despesas.fixas + m.despesas.lancadas + m.despesas.faturasCartao + m.despesas.parcelas);
    m.saldo = arredondar(m.receitas.total - m.despesas.total);
    delete m.inicioObj;
    delete m.fimObj;
  }

  return {
    meses: janela,
    totalRecorrencias: regras.length,
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
               AND t.cartao_id IS NULL
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
       AND (t.cartao_id IS NULL OR t.descricao ILIKE 'Fatura %')
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
  // limitador_categorias e limitador_alertas saem por CASCADE de limitadores.
  await pool.query('DELETE FROM limitadores WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM caixinhas WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM contatos_compartilhados WHERE usuario_principal_id = $1 OR contato_id = $1', [uid]);
  await pool.query('DELETE FROM transferencias WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM contas WHERE usuario_id = $1', [uid]);
  await pool.query('DELETE FROM usuarios WHERE usuario_id = $1', [uid]);
  return true;
}

// Define a fatia de ORÇAMENTO de uma categoria (principal ou subcategoria) —
// o rateio 50/30/20, que é o único sentido de valor_limite desde que o teto de
// gasto virou limitador (ver a migração de `limitadores` em initTables).
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
      subMap[r.parent].push({
        categoria: r.categoria,
        valor_limite: r.valor_limite,
      });
    }
  }

  const principais = Object.values(principaisMap);
  for (const p of principais) {
    p.subs = subMap[p.categoria] || [];
  }
  return principais;
}

// Salvar o rateio de orçamento em batch (tela 50/30/20 do painel).
//
// Só mexe em valor_limite: teto de gasto é outro conceito e mora em
// `limitadores`. Enquanto os dois dividiam esta coluna, salvar o rateio
// silenciosamente redefinia tetos que o usuário tinha digitado noutra tela.
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

// ─── Consumo de limite por janela (semana ISO + mês) ─────────────────────────
//
// DECISÃO — status pendente CONTA no consumo. A soma inclui 'pago' e
// 'pendente' porque as duas coisas já são compromisso assumido: despesa
// lançada como "a pagar" no WhatsApp e transação PENDING vinda da Pluggy
// (mapearStatusTransacaoPluggy) são gasto que já aconteceu, só não liquidou.
// Ignorá-las faria o teto avisar tarde demais — exatamente o oposto do que o
// controle serve. Preserva também o comportamento anterior desta função, que
// já somava tudo.
//
// DECISÃO — transferência entre contas NÃO entra: mora na tabela
// transferencias, não em transacoes, então o filtro tipo='despesa' já a exclui
// por construção. (Ressalva conhecida: transação de transferência vinda da
// Pluggy é gravada em transacoes como despesa/receita genérica — cai numa
// categoria sem teto e por isso não dispara alerta, mas contaminaria o total
// se o usuário criasse um teto para essa categoria genérica.)
function montarJanela(limite, gastos) {
  if (!limite || limite <= 0) return null;
  const percentual = Math.round((gastos / limite) * 100);
  return {
    limite,
    gastos,
    restante: limite - gastos,
    percentual,
    faixa: faixaDeAlerta(percentual),
  };
}

// ─── CRUD de limitadores ─────────────────────────────────────────────────────

// Lista os limitadores do usuário com as categorias de cada um (sem consumo).
// Uma query para os limitadores e uma para as categorias — não é N+1: são duas
// no total, independentemente de quantos limitadores existam.
async function listarLimitadores(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const [limitadores, categorias] = await Promise.all([
    pool.query(
      `SELECT id, nome, valor_semanal::float, valor_mensal::float
       FROM limitadores
       WHERE usuario_id = $1 AND ativo = TRUE
       ORDER BY nome`,
      [uid]
    ),
    pool.query(
      `SELECT lc.limitador_id, lc.categoria
       FROM limitador_categorias lc
       JOIN limitadores l ON l.id = lc.limitador_id
       WHERE lc.usuario_id = $1 AND l.ativo = TRUE
       ORDER BY lc.categoria`,
      [uid]
    ),
  ]);

  const porLimitador = new Map();
  for (const c of categorias.rows) {
    if (!porLimitador.has(c.limitador_id)) porLimitador.set(c.limitador_id, []);
    porLimitador.get(c.limitador_id).push(c.categoria);
  }

  return limitadores.rows.map((l) => ({ ...l, categorias: porLimitador.get(l.id) || [] }));
}

// Categorias já ocupadas por OUTRO limitador — a validação da regra "uma
// categoria, um limitador". Devolve [{ categoria, limitador }] para a mensagem
// de erro poder dizer ONDE a categoria já está, e não só que deu conflito.
async function categoriasEmOutroLimitador(uid, categorias, limitadorIdIgnorado = null) {
  if (!categorias || categorias.length === 0) return [];
  const result = await pool.query(
    `SELECT lc.categoria, l.nome AS limitador
     FROM limitador_categorias lc
     JOIN limitadores l ON l.id = lc.limitador_id
     WHERE lc.usuario_id = $1
       AND l.ativo = TRUE
       AND lc.categoria = ANY($2::text[])
       AND ($3::int IS NULL OR lc.limitador_id <> $3)`,
    [uid, categorias, limitadorIdIgnorado]
  );
  return result.rows;
}

// Normaliza o payload vindo do painel / do WhatsApp. Teto ausente, 0, vazio ou
// negativo vira NULL = "não controlo essa janela" — a mesma convenção nas duas
// pontas, para não existir "0 significa uma coisa aqui e outra ali".
function normalizarTeto(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

// Cria ou atualiza um limitador junto com sua lista de categorias.
//
// Categorias são substituídas por inteiro (DELETE + INSERT) e não sincronizadas
// item a item: a lista é pequena (dezenas no pior caso) e "o que está na tela é
// o que fica gravado" é mais fácil de garantir do que um diff.
//
// Tudo numa transação: um limitador que gravou o nome novo mas manteve as
// categorias antigas seria pior do que a gravação inteira falhar.
async function salvarLimitador(usuarioId, dados) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const nome = (dados.nome || '').trim();
  if (!nome) return { ok: false, erro: 'nome_obrigatorio' };

  const categorias = [...new Set((dados.categorias || []).map((c) => (c || '').trim()).filter(Boolean))];
  if (categorias.length === 0) return { ok: false, erro: 'sem_categorias' };

  const semanal = normalizarTeto(dados.valor_semanal);
  const mensal = normalizarTeto(dados.valor_mensal);
  if (semanal === null && mensal === null) return { ok: false, erro: 'sem_teto' };

  const id = dados.id ? Number(dados.id) : null;

  const conflitos = await categoriasEmOutroLimitador(uid, categorias, id);
  if (conflitos.length > 0) return { ok: false, erro: 'categoria_em_uso', conflitos };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let limitadorId = id;
    if (limitadorId) {
      const upd = await client.query(
        `UPDATE limitadores SET nome = $3, valor_semanal = $4, valor_mensal = $5
         WHERE id = $2 AND usuario_id = $1 AND ativo = TRUE
         RETURNING id`,
        [uid, limitadorId, nome, semanal, mensal]
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, erro: 'nao_encontrado' };
      }
    } else {
      const ins = await client.query(
        `INSERT INTO limitadores (usuario_id, nome, valor_semanal, valor_mensal)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [uid, nome, semanal, mensal]
      );
      limitadorId = ins.rows[0].id;
    }

    await client.query('DELETE FROM limitador_categorias WHERE limitador_id = $1', [limitadorId]);
    await client.query(
      `INSERT INTO limitador_categorias (limitador_id, usuario_id, categoria)
       SELECT $1, $2, cat FROM UNNEST($3::text[]) AS cat`,
      [limitadorId, uid, categorias]
    );

    await client.query('COMMIT');
    return { ok: true, id: limitadorId, nome, valor_semanal: semanal, valor_mensal: mensal, categorias };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique_violation: só pode ser o índice de nome (o de categoria já
    // foi checado acima com mensagem melhor).
    if (err.code === '23505') return { ok: false, erro: 'nome_duplicado' };
    throw err;
  } finally {
    client.release();
  }
}

// Desativa o limitador e SOLTA suas categorias.
//
// O DELETE das categorias não é opcional: elas carregam o índice único que
// impede a mesma categoria em dois limitadores, e uma linha presa a um
// limitador inativo bloquearia o usuário de usar aquela categoria de novo — um
// limitador excluído continuaria mandando no sistema.
async function excluirLimitador(usuarioId, limitadorId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `UPDATE limitadores SET ativo = FALSE
     WHERE id = $2 AND usuario_id = $1 AND ativo = TRUE
     RETURNING nome`,
    [uid, Number(limitadorId)]
  );
  if (result.rowCount === 0) return null;
  await pool.query('DELETE FROM limitador_categorias WHERE limitador_id = $1', [Number(limitadorId)]);
  return result.rows[0].nome;
}

// Busca um limitador pelo nome (case/acento-insensível), para o WhatsApp poder
// dizer "limitar mercado em 500" sem o usuário saber o id.
async function buscarLimitadorPorNome(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const alvo = normalizarCategoriaParaComparacao(nome);
  if (!alvo) return null;
  const todos = await listarLimitadores(uid);
  return todos.find((l) => normalizarCategoriaParaComparacao(l.nome) === alvo) || null;
}

// ─── Consumo por limitador ───────────────────────────────────────────────────

// Consumo de TODOS os limitadores do usuário nas duas janelas, em uma query só.
//
// A soma percorre TODAS as categorias do grupo: é o ponto inteiro do modelo —
// "Mercado" pode ser Supermercado + Compras + Alimentos e bebidas, e o teto vale
// para o conjunto, não para cada uma.
//
// Uma query única (e não uma por limitador): o painel chama isso a cada carga do
// dashboard, e o aviso pós-sync também.
async function listarConsumoLimitadores(usuarioId, opcoes = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const janelas = janelasDeControle(opcoes.dataRef || null);

  const result = await pool.query(
    `SELECT l.id,
            l.nome,
            l.valor_semanal::float AS semanal,
            l.valor_mensal::float AS mensal,
            COALESCE(ARRAY_AGG(DISTINCT lc.categoria), '{}') AS categorias,
            COALESCE(SUM(t.valor) FILTER (WHERE t.data >= $2 AND t.data <= $3), 0)::float AS gastos_semana,
            COALESCE(SUM(t.valor) FILTER (WHERE t.data >= $4 AND t.data <= $5), 0)::float AS gastos_mes
     FROM limitadores l
     JOIN limitador_categorias lc ON lc.limitador_id = l.id
     LEFT JOIN transacoes t
       ON t.usuario_id = l.usuario_id
      AND t.tipo = 'despesa'
      AND t.categoria = lc.categoria
      AND t.data >= LEAST($2::date, $4::date)
      AND t.data <= GREATEST($3::date, $5::date)
     WHERE l.usuario_id = $1
       AND l.ativo = TRUE
       AND (l.valor_semanal > 0 OR l.valor_mensal > 0)
     GROUP BY l.id, l.nome, l.valor_semanal, l.valor_mensal
     ORDER BY l.nome`,
    [uid, janelas.semana.inicio, janelas.semana.fim, janelas.mes.inicio, janelas.mes.fim]
  );

  return result.rows.map((r) => {
    const semana = montarJanela(r.semanal, r.gastos_semana);
    const mes = montarJanela(r.mensal, r.gastos_mes);
    if (semana) Object.assign(semana, janelas.semana);
    if (mes) Object.assign(mes, janelas.mes);
    return { id: r.id, limitador: r.nome, categorias: r.categorias || [], semana, mes };
  });
}

// Consumo do limitador que contém uma categoria. Null quando a categoria não
// está em limitador nenhum (o caso comum: são 41 subcategorias e poucos
// limitadores) ou quando o limitador não tem nenhum teto definido.
//
// O SELECT parte de limitador_categorias, e não de limitadores: é a categoria
// da transação recém-lançada que traz o grupo, não o contrário.
async function verificarLimitadorDaCategoria(usuarioId, categoria, opcoes = {}) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const janelas = janelasDeControle(opcoes.dataRef || null);

  const alvo = await pool.query(
    `SELECT l.id, l.nome, l.valor_semanal::float AS semanal, l.valor_mensal::float AS mensal
     FROM limitador_categorias lc
     JOIN limitadores l ON l.id = lc.limitador_id
     WHERE lc.usuario_id = $1 AND lc.categoria = $2 AND l.ativo = TRUE`,
    [uid, categoria]
  );
  if (alvo.rows.length === 0) return null;

  const { id, nome, semanal, mensal } = alvo.rows[0];
  if ((!semanal || semanal <= 0) && (!mensal || mensal <= 0)) return null;

  // O gasto é o do GRUPO inteiro: a transação em "Supermercado" consome o mesmo
  // teto que a de "Compras", se as duas estão no limitador "Mercado".
  const gastosResult = await pool.query(
    `SELECT
       COALESCE(SUM(t.valor) FILTER (WHERE t.data >= $3 AND t.data <= $4), 0)::float AS gastos_semana,
       COALESCE(SUM(t.valor) FILTER (WHERE t.data >= $5 AND t.data <= $6), 0)::float AS gastos_mes
     FROM transacoes t
     WHERE t.usuario_id = $1
       AND t.tipo = 'despesa'
       AND t.categoria IN (SELECT categoria FROM limitador_categorias WHERE limitador_id = $2)
       AND t.data >= LEAST($3::date, $5::date)
       AND t.data <= GREATEST($4::date, $6::date)`,
    [uid, id, janelas.semana.inicio, janelas.semana.fim, janelas.mes.inicio, janelas.mes.fim]
  );
  const { gastos_semana: gastosSemana, gastos_mes: gastosMes } = gastosResult.rows[0];

  const semana = montarJanela(semanal, gastosSemana);
  const mes = montarJanela(mensal, gastosMes);
  if (semana) Object.assign(semana, janelas.semana);
  if (mes) Object.assign(mes, janelas.mes);

  return { id, limitador: nome, semana, mes };
}

// Marca a faixa avisada para (usuário, limitador, janela, período) e responde
// se ela SUBIU — só nesse caso vale mandar aviso proativo.
//
// A decisão é do banco, não da aplicação: o UPDATE só acontece com
// "WHERE faixa < EXCLUDED.faixa", então dois syncs simultâneos do mesmo Item
// (webhook + botão do painel) não conseguem avisar duas vezes a mesma faixa.
// rowCount = 0 significa "já estava nesse nível ou acima" → cala a boca.
async function registrarFaixaAlertada(usuarioId, limitadorId, janela, periodoChave, faixa) {
  if (!faixa || faixa <= 0) return false;
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO limitador_alertas (usuario_id, limitador_id, janela, periodo_chave, faixa)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (usuario_id, limitador_id, janela, periodo_chave)
     DO UPDATE SET faixa = EXCLUDED.faixa, atualizado_em = NOW()
     WHERE limitador_alertas.faixa < EXCLUDED.faixa
     RETURNING id`,
    [uid, limitadorId, janela, periodoChave, faixa]
  );
  return result.rowCount > 0;
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
    `SELECT id, nome, limite_total::float, dia_fechamento, dia_vencimento,
            pluggy_valor_usado::float, pluggy_disponivel::float
     FROM cartoes WHERE usuario_id = $1 ORDER BY nome`,
    [uid]
  );
  return res.rows;
}

async function buscarCartoesPorNome(usuarioId, nome) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, nome, limite_total::float, dia_fechamento, dia_vencimento,
            pluggy_valor_usado::float, pluggy_disponivel::float
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

// Uso real de um cartão, seja ele Pluggy (dado real da API, gravado em
// pluggy_valor_usado/pluggy_disponivel por sincronizarItem) ou manual (calculado
// a partir do ciclo de fatura via calcularUsoCartao). Único ponto de decisão —
// endpoint do painel (/api/cartoes/uso) e tools do agente de WhatsApp (uso_cartao,
// listar_cartoes, buildFinancialContext) devem sempre passar por aqui, nunca
// chamar calcularUsoCartao diretamente para um cartão que pode ser Pluggy.
// `cartao` precisa vir de listarCartoes/buscarCartoesPorNome (colunas
// pluggy_valor_usado/pluggy_disponivel selecionadas).
async function obterUsoCartao(cartao) {
  if (cartao.pluggy_valor_usado !== null && cartao.pluggy_valor_usado !== undefined) {
    const disponivel = (cartao.pluggy_disponivel !== null && cartao.pluggy_disponivel !== undefined)
      ? cartao.pluggy_disponivel
      : (cartao.limite_total !== null && cartao.limite_total !== undefined
        ? cartao.limite_total - cartao.pluggy_valor_usado
        : null);
    return {
      origem: 'pluggy',
      valorUsado: cartao.pluggy_valor_usado,
      limiteTotal: cartao.limite_total,
      disponivel,
      qtd: null,
    };
  }
  // Chamada via module.exports (não a referência local) para que testes que
  // mockam db.calcularUsoCartao continuem funcionando normalmente.
  const uso = await module.exports.calcularUsoCartao(cartao.id, cartao.dia_fechamento);
  const limiteTotal = cartao.limite_total;
  const disponivel = (limiteTotal !== null && limiteTotal !== undefined) ? limiteTotal - uso.total : null;
  return {
    origem: 'manual',
    valorUsado: uso.total,
    limiteTotal,
    disponivel,
    qtd: uso.qtd,
    inicioStr: uso.inicioStr,
    fimStr: uso.fimStr,
  };
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

// ─── Credenciais Pluggy — Open Finance (Marco 1) ──────────────────────────────
// client_secret é cifrado antes de gravar e decifrado só no momento de uso
// (buscarCredencialPluggy é para uso interno do backend — nunca expor via API).

async function salvarCredencialPluggy(usuarioId, clientId, clientSecret) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const { iv, valorCifrado } = pluggyCrypto.encriptar(clientSecret);
  const result = await pool.query(
    `INSERT INTO pluggy_credenciais (usuario_id, client_id, client_secret_encrypted, iv, atualizado_em)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (usuario_id) DO UPDATE
       SET client_id = EXCLUDED.client_id,
           client_secret_encrypted = EXCLUDED.client_secret_encrypted,
           iv = EXCLUDED.iv,
           atualizado_em = NOW()
     RETURNING id`,
    [uid, clientId, valorCifrado, iv]
  );
  return result.rows[0]?.id || null;
}

// Uso interno apenas (jobs de sync, geração de API Key) — nunca expor o retorno via rota HTTP.
async function buscarCredencialPluggy(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT client_id, client_secret_encrypted, iv
     FROM pluggy_credenciais WHERE usuario_id = $1`,
    [uid]
  );
  if (result.rows.length === 0) return null;
  const { client_id, client_secret_encrypted, iv } = result.rows[0];
  return {
    clientId: client_id,
    clientSecret: pluggyCrypto.decriptar(client_secret_encrypted, iv),
  };
}

async function usuarioTemCredencialPluggy(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT 1 FROM pluggy_credenciais WHERE usuario_id = $1`,
    [uid]
  );
  return result.rows.length > 0;
}

async function removerCredencialPluggy(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `DELETE FROM pluggy_credenciais WHERE usuario_id = $1`,
    [uid]
  );
  return result.rowCount > 0;
}

// ─── Items e contas/cartões espelho Pluggy (Marco 2) ──────────────────────────

async function salvarPluggyItem(usuarioId, itemId, connectorNome, status) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `INSERT INTO pluggy_items (usuario_id, item_id, connector_nome, status, atualizado_em)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (item_id) DO UPDATE
       SET connector_nome = EXCLUDED.connector_nome,
           status = EXCLUDED.status,
           atualizado_em = NOW()
     RETURNING id`,
    [uid, itemId, connectorNome || null, status || null]
  );
  return result.rows[0].id;
}

async function listarPluggyItems(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const result = await pool.query(
    `SELECT id, item_id, connector_nome, status, erro_mensagem, ultimo_sync_em, criado_em, atualizado_em
     FROM pluggy_items WHERE usuario_id = $1 ORDER BY criado_em DESC`,
    [uid]
  );
  return result.rows;
}

// Retorna o primeiro nome disponível entre nomeBase, "nomeBase (2)", "nomeBase (3)"...
// dado um conjunto de nomes já em uso. Comparação exata (case-sensitive), mesmo
// critério do UNIQUE(usuario_id, nome) em contas. Função pura — sem I/O — para
// ser testável isoladamente.
function proximoNomeDisponivel(nomeBase, nomesEmUso) {
  const usados = new Set(nomesEmUso);
  if (!usados.has(nomeBase)) return nomeBase;
  let n = 2;
  while (usados.has(`${nomeBase} (${n})`)) n++;
  return `${nomeBase} (${n})`;
}

// criarContaPluggy / criarCartaoPluggy: criam a conta/cartão espelho de uma
// Account/CreditCard da Pluggy, com saldo_inicial=0 (Marco 2 não sincroniza
// transações — saldo real só fica correto depois do Marco 3 popular
// transacoes; calcularSaldosPorConta já soma isso automaticamente).
//
// Idempotentes por pluggy_account_id: se o mesmo Account já foi mapeado antes
// (reprocessamento do mesmo callback, duplo clique etc), reaproveita a conta/
// cartão existente em vez de criar duplicata.

async function criarContaPluggy(usuarioId, pluggyItemDbId, pluggyAccountId, nomeSugerido, tipo = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const existenteRes = await pool.query(
    `SELECT c.id, c.nome, c.tipo, c.saldo_inicial::float, c.ativo, c.padrao
     FROM pluggy_contas_map m
     JOIN contas c ON c.id = m.cronos_conta_id
     WHERE m.pluggy_account_id = $1`,
    [pluggyAccountId]
  );
  if (existenteRes.rows.length > 0) return existenteRes.rows[0];

  const nomesRes = await pool.query(`SELECT nome FROM contas WHERE usuario_id = $1`, [uid]);
  const nome = proximoNomeDisponivel(nomeSugerido, nomesRes.rows.map(r => r.nome));

  const contaRes = await pool.query(
    `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial)
     VALUES ($1, $2, $3, 0)
     RETURNING id, nome, tipo, saldo_inicial::float, ativo, padrao`,
    [uid, nome, tipo || null]
  );
  const conta = contaRes.rows[0];

  await pool.query(
    `INSERT INTO pluggy_contas_map (pluggy_item_id, pluggy_account_id, tipo, cronos_conta_id)
     VALUES ($1, $2, 'conta', $3)`,
    [pluggyItemDbId, pluggyAccountId, conta.id]
  );

  return conta;
}

async function criarCartaoPluggy(usuarioId, pluggyItemDbId, pluggyAccountId, nomeSugerido, limiteTotal = null) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const existenteRes = await pool.query(
    `SELECT c.id, c.nome, c.limite_total::float, c.dia_fechamento, c.dia_vencimento
     FROM pluggy_contas_map m
     JOIN cartoes c ON c.id = m.cronos_cartao_id
     WHERE m.pluggy_account_id = $1`,
    [pluggyAccountId]
  );
  if (existenteRes.rows.length > 0) return existenteRes.rows[0];

  const nomesRes = await pool.query(`SELECT nome FROM cartoes WHERE usuario_id = $1`, [uid]);
  const nome = proximoNomeDisponivel(nomeSugerido, nomesRes.rows.map(r => r.nome));

  // Bug de produção corrigido: cartão criado na conexão inicial nunca
  // populava limite_total (ficava NULL) — o valor real (Account.creditData.
  // creditLimit) só chegava a partir daqui, se algum chamador passasse.
  const cartaoRes = await pool.query(
    `INSERT INTO cartoes (usuario_id, nome, limite_total)
     VALUES ($1, $2, $3)
     RETURNING id, nome, limite_total::float, dia_fechamento, dia_vencimento`,
    [uid, nome, limiteTotal]
  );
  const cartao = cartaoRes.rows[0];

  await pool.query(
    `INSERT INTO pluggy_contas_map (pluggy_item_id, pluggy_account_id, tipo, cronos_cartao_id)
     VALUES ($1, $2, 'cartao', $3)`,
    [pluggyItemDbId, pluggyAccountId, cartao.id]
  );

  return cartao;
}

// ─── Webhook e sincronização de transações Pluggy (Marco 3) ───────────────────

// webhook_token é 1 por usuário (não por Item) — gerado sob demanda na
// primeira vez que for necessário (ao gerar um Connect Token). Alta entropia
// (24 bytes) porque é o único mecanismo de autenticação do endpoint de
// webhook — sem ele, qualquer requisição é rejeitada com 401 sem processar.
async function obterOuCriarWebhookTokenPluggy(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT webhook_token FROM pluggy_credenciais WHERE usuario_id = $1`,
    [uid]
  );
  if (res.rows.length === 0) {
    throw new Error('Nenhuma credencial Pluggy configurada para este usuário.');
  }
  if (res.rows[0].webhook_token) return res.rows[0].webhook_token;

  const token = crypto.randomBytes(24).toString('hex');
  await pool.query(
    `UPDATE pluggy_credenciais SET webhook_token = $2 WHERE usuario_id = $1`,
    [uid, token]
  );
  return token;
}

// Uso interno do endpoint público de webhook — resolve o token da URL para o
// usuário dono, sem confiar em nenhum outro dado do payload para autenticação.
async function buscarUsuarioIdPorWebhookToken(token) {
  if (!token) return null;
  const res = await pool.query(
    `SELECT usuario_id FROM pluggy_credenciais WHERE webhook_token = $1`,
    [token]
  );
  return res.rows[0]?.usuario_id || null;
}

async function buscarPluggyItemPorItemId(itemId) {
  const res = await pool.query(
    `SELECT id, usuario_id, status, ultimo_sync_em
     FROM pluggy_items WHERE item_id = $1`,
    [itemId]
  );
  return res.rows[0] || null;
}

// Uso do endpoint de sincronização manual — filtra por usuário na própria
// query (não busca sem filtro e compara depois em JS), para não deixar
// margem a um usuário autenticado sincronizar o Item de outro só por saber o
// item_id (IDOR). Resolve pelo usuário principal antes de comparar, mesmo
// mecanismo de contas compartilhadas usado no resto do arquivo.
async function buscarPluggyItemDoUsuario(usuarioId, itemId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, usuario_id, status, ultimo_sync_em
     FROM pluggy_items WHERE item_id = $1 AND usuario_id = $2`,
    [itemId, uid]
  );
  return res.rows[0] || null;
}

// status gravado é o valor bruto retornado pela Pluggy (ex: "UPDATED",
// "LOGIN_ERROR") — a tradução para rótulo em português acontece só na UI
// (public/js/app.js, PLUGGY_STATUS_LABEL), não aqui.
async function atualizarStatusPluggyItem(itemId, status, erroMensagem = null) {
  const res = await pool.query(
    `UPDATE pluggy_items SET status = $2, erro_mensagem = $3, atualizado_em = NOW()
     WHERE item_id = $1 RETURNING id`,
    [itemId, status || null, erroMensagem]
  );
  return res.rows[0]?.id || null;
}

async function marcarPluggyItemSincronizado(pluggyItemDbId) {
  await pool.query(
    `UPDATE pluggy_items SET ultimo_sync_em = NOW() WHERE id = $1`,
    [pluggyItemDbId]
  );
}

async function listarContasMapPorItem(pluggyItemDbId) {
  const res = await pool.query(
    `SELECT pluggy_account_id, tipo, cronos_conta_id, cronos_cartao_id
     FROM pluggy_contas_map WHERE pluggy_item_id = $1`,
    [pluggyItemDbId]
  );
  return res.rows;
}

async function buscarMapeamentoContaPorAccountId(pluggyAccountId) {
  const res = await pool.query(
    `SELECT tipo, cronos_conta_id, cronos_cartao_id FROM pluggy_contas_map WHERE pluggy_account_id = $1`,
    [pluggyAccountId]
  );
  return res.rows[0] || null;
}

const CATEGORIA_GENERICA_PLUGGY_POR_TIPO = {
  despesa: 'Outros',
  receita: 'Outras Receitas',
};

// Garante (cria se faltar) uma categoria principal com o tipo CERTO. Diferente
// de criarCategoriaPrincipal (grava sempre tipo='despesa', o default do
// schema, quando a coluna não é especificada no INSERT — armadilha real se
// usada para criar "Receitas") — usada pela auto-criação de subcategoria a
// partir da Pluggy, onde o usuário pode não ter mais essa principal (ex:
// excluiu "Investimentos" antes de conectar o banco). Idempotente.
async function garantirCategoriaPrincipal(usuarioIdResolvido, nome, tipo) {
  const existe = await pool.query(
    `SELECT id FROM categorias_principais WHERE usuario_id = $1 AND nome = $2 AND ativo = TRUE`,
    [usuarioIdResolvido, nome]
  );
  if (existe.rows.length > 0) return;

  const padrao = CATEGORIAS_PRINCIPAIS_PADRAO.find((c) => c.nome === nome);
  const ehReceita = nome === CATEGORIA_PRINCIPAL_RECEITA.nome;
  const percentual = padrao ? padrao.percentual : (ehReceita ? CATEGORIA_PRINCIPAL_RECEITA.percentual : 0);
  const ordem = padrao ? padrao.ordem : (ehReceita ? CATEGORIA_PRINCIPAL_RECEITA.ordem : 99);

  await pool.query(
    `INSERT INTO categorias_principais (usuario_id, nome, percentual, ordem, tipo)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (usuario_id, nome) DO UPDATE SET ativo = TRUE`,
    [usuarioIdResolvido, nome, percentual, ordem, tipo]
  );
}

// ─── Aprendizado de categoria por estabelecimento ────────────────────────────
//
// Ideia: o usuário corrige a categoria de UM lançamento e todo lançamento
// FUTURO do mesmo estabelecimento já nasce naquela categoria. Não há
// reprocessamento retroativo das transações antigas ao corrigir uma — só o
// lançamento editado muda naquele momento (comportamento menos surpreendente:
// uma edição no painel nunca reescreve dezenas de linhas que o usuário não
// estava olhando). O histórico só é recategorizado quando o usuário pede
// explicitamente uma re-sincronização completa.
//
// tipo faz parte da chave — ver o comentário da tabela em initTables.

// Grava/atualiza o aprendizado. Retorna a chave usada (útil em teste e log) ou
// null quando a descrição não permite derivar uma chave confiável.
async function registrarCategoriaAprendida(usuarioId, descricao, tipo, categoria) {
  const chave = normalizarEstabelecimento(descricao);
  if (!chave || !categoria) return null;

  const uid = await resolverUsuarioPrincipal(usuarioId);
  const tipoChave = tipo === 'receita' ? 'receita' : 'despesa';

  await pool.query(
    `INSERT INTO categoria_aprendida (usuario_id, chave_estabelecimento, tipo, categoria)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id, chave_estabelecimento, tipo)
     DO UPDATE SET categoria = EXCLUDED.categoria, atualizado_em = NOW()`,
    [uid, chave, tipoChave, categoria]
  );

  return chave;
}

// Variante que recebe o usuário JÁ resolvido — usada dentro do laço de sync
// (uma transação por iteração), onde resolver a identidade de novo a cada
// chamada seria uma consulta a mais por transação sem ganho nenhum.
async function buscarCategoriaAprendidaResolvida(uid, descricao, tipo) {
  const chave = normalizarEstabelecimento(descricao);
  if (!chave) return null;

  const res = await pool.query(
    `SELECT categoria FROM categoria_aprendida
     WHERE usuario_id = $1 AND chave_estabelecimento = $2 AND tipo = $3`,
    [uid, chave, tipo === 'receita' ? 'receita' : 'despesa']
  );
  return res.rows[0]?.categoria || null;
}

async function buscarCategoriaAprendida(usuarioId, descricao, tipo) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  return buscarCategoriaAprendidaResolvida(uid, descricao, tipo);
}

// ─── Aprendizado por DOCUMENTO da contraparte (CPF/CNPJ hasheado) ────────────
//
// Mesma ideia do aprendizado por texto, com uma chave melhor: o hash do
// documento de quem pagou/recebeu. Vale mais que a chave textual porque o
// mesmo prestador aparece com descrições diferentes a cada lançamento, e o
// documento é o mesmo sempre.
//
// `documentoHash` já chega hasheado de src/contraparte.js — esta camada nunca
// vê, grava nem loga o documento em si. hash nulo (sem paymentData, sem chave
// mestra configurada) simplesmente não aprende nem consulta.

async function registrarCategoriaAprendidaDocumento(usuarioId, documentoHash, tipo, categoria) {
  if (!documentoHash || !categoria) return null;

  const uid = await resolverUsuarioPrincipal(usuarioId);
  const tipoChave = tipo === 'receita' ? 'receita' : 'despesa';

  await pool.query(
    `INSERT INTO categoria_aprendida_documento (usuario_id, documento_hash, tipo, categoria)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (usuario_id, documento_hash, tipo)
     DO UPDATE SET categoria = EXCLUDED.categoria, atualizado_em = NOW()`,
    [uid, documentoHash, tipoChave, categoria]
  );

  return documentoHash;
}

// Variante com o usuário JÁ resolvido — mesmo motivo de
// buscarCategoriaAprendidaResolvida (chamada dentro do laço de sync).
async function buscarCategoriaAprendidaDocumentoResolvida(uid, documentoHash, tipo) {
  if (!documentoHash) return null;

  const res = await pool.query(
    `SELECT categoria FROM categoria_aprendida_documento
     WHERE usuario_id = $1 AND documento_hash = $2 AND tipo = $3`,
    [uid, documentoHash, tipo === 'receita' ? 'receita' : 'despesa']
  );
  return res.rows[0]?.categoria || null;
}

async function buscarCategoriaAprendidaDocumento(usuarioId, documentoHash, tipo) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  return buscarCategoriaAprendidaDocumentoResolvida(uid, documentoHash, tipo);
}

// Resolve a categoria de uma transação Pluggy para o Cronos:
// 0a. Aprendizado por DOCUMENTO da contraparte (CPF/CNPJ hasheado) — a chave
//    mais forte que existe aqui: o mesmo prestador muda de descrição a cada
//    lançamento, mas não muda de documento. Por isso vem ANTES da chave
//    textual; quando as duas discordam, a do documento é a que reflete "eu já
//    disse quem é essa pessoa/empresa".
// 0b. Aprendizado do próprio usuário para aquele estabelecimento (ver acima) —
//    tem prioridade sobre tudo que vem da Pluggy, inclusive quando ela não
//    manda categoria nenhuma (que é exatamente o caso das transações que
//    caíram em "Outros").
// 1. Match EXATO (case/acento-insensível) contra uma subcategoria já
//    cadastrada do usuário — ver resolverCategoriaPluggyPorTaxonomia. Tem que
//    vir ANTES do fuzzy: senão "Compras" batendo ao mesmo tempo em "Compras" E
//    "Compras online" cai na regra de ambiguidade do passo 2 e devolve o
//    genérico, mesmo havendo correspondência óbvia (bug de produção, Marco 1).
// 2. Sem match exato: tenta casar com uma subcategoria já cadastrada do
//    usuário (fuzzy via ILIKE, mesmo padrão de buscarContasPorNome),
//    respeitando o tipo despesa/receita — evita duplicar se o usuário já tem
//    "Restaurantes", por exemplo.
// 3. Sem match (exato nem fuzzy) e com categoriaPrincipalDestino conhecida
//    (decisão do Federico, reverte a postura anterior deste módulo): cria a
//    subcategoria automaticamente com o nome traduzido da Pluggy, vinculada a
//    essa principal (garantirCategoriaPrincipal + garantirSubcategoria, ambas
//    já idempotentes). categoriaPrincipalDestino vem null para transferências
//    (grupos Pluggy 04/05 — o Cronos já tem tabela transferencias própria,
//    não misturar) ou categoryId desconhecido — ver
//    src/pluggy.js:categoriaPrincipalParaGrupoRaiz.
// 4. Sem match e sem categoriaPrincipalDestino (ou sem categoria vinda da
//    Pluggy — category exige plano Pro, pode vir null), ou match fuzzy
//    AMBÍGUO (>1 resultado, nenhum exato — criar mais uma variação só
//    pioraria a ambiguidade): fallback genérico já usado no fluxo manual
//    (CATEGORIA_GENERICA_POR_TIPO em src/agente-financeiro.js).
// descricao: descrição CRUA da transação (a mesma que vai ser gravada), usada
// só para consultar o aprendizado. contraparteHash: hash do CPF/CNPJ do outro
// lado (ver src/contraparte.js) — nunca o documento. Últimos parâmetros e
// opcionais para não mexer nos call sites que não têm essa informação.
async function resolverCategoriaPluggy(usuarioId, categoriaPluggy, tipo, categoriaPrincipalDestino = null, descricao = null, contraparteHash = null) {
  const generica = CATEGORIA_GENERICA_PLUGGY_POR_TIPO[tipo] || 'Outros';

  // Sem nada para consultar aprendizado (nem descrição, nem documento) e sem
  // categoria da Pluggy: não há o que decidir, cai no genérico sem tocar no banco.
  if (!descricao && !categoriaPluggy && !contraparteHash) return generica;

  const uid = await resolverUsuarioPrincipal(usuarioId);

  // (0a) Aprendizado por documento — chave mais confiável, vem primeiro.
  if (contraparteHash) {
    const porDocumento = await buscarCategoriaAprendidaDocumentoResolvida(uid, contraparteHash, tipo);
    if (porDocumento) return porDocumento;
  }

  // (0b) Aprendizado por texto — consultado ANTES do early return de categoria
  // ausente de propósito: transação sem categoria na Pluggy é justamente a que
  // mais se beneficia de "eu já disse o que é esse lugar".
  if (descricao) {
    const aprendida = await buscarCategoriaAprendidaResolvida(uid, descricao, tipo);
    if (aprendida) return aprendida;
  }

  if (!categoriaPluggy) return generica;

  return resolverCategoriaPluggyPorTaxonomia(uid, categoriaPluggy, tipo, categoriaPrincipalDestino, generica);
}

// Normaliza para comparação de match EXATO de categoria: minúsculas + remove
// diacríticos via NFD (mesmo idioma de src/estabelecimento.js:47), sem as
// demais regras de normalizarEstabelecimento (remoção de prefixo de gateway,
// sufixo de parcela etc. — aqui só comparamos duas strings curtas de
// categoria, não descrições de transação).
// RegExp via construtor (não regex literal) de propósito: evita depender de
// como o editor/arquivo salva o caractere combinante em bytes, mesma
// preocupação do comentário em src/estabelecimento.js:43-45.
const REGEX_DIACRITICOS_NFD = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizarCategoriaParaComparacao(texto) {
  return (texto || '').normalize('NFD').replace(REGEX_DIACRITICOS_NFD, '').trim().toLowerCase();
}

// Passos (1) match exato / (2) match fuzzy / (3) auto-criação / (4) fallback,
// com o usuário já resolvido. Separado de resolverCategoriaPluggy só para não
// resolver a identidade duas vezes quando o aprendizado já resolveu.
async function resolverCategoriaPluggyPorTaxonomia(uid, categoriaPluggy, tipo, categoriaPrincipalDestino, generica) {
  // (1) Match EXATO (case/acento-insensível) tem prioridade sobre o fuzzy, e
  // precisa de query própria: ILIKE do Postgres ignora caixa mas NÃO
  // diacríticos, então "Farmacia" (vindo traduzido da Pluggy) não bateria em
  // "%Farmacia%" contra a subcategoria "Farmácia" do usuário. Trazer todas as
  // candidatas e comparar normalizado em JS resolve os dois casos (caixa e
  // acento) com uma comparação simples e testável, sem depender da extensão
  // unaccent do Postgres (pode nem estar instalada no servidor).
  //
  // Sem esse passo, categoria "Compras" batendo ao mesmo tempo em "Compras" E
  // "Compras online" via ILIKE cai direto na regra de ambiguidade abaixo e
  // devolve o genérico "Outros", mesmo havendo uma correspondência exata
  // óbvia — bug confirmado em produção (re-sync rebaixou transações que
  // estavam certas em "Compras").
  const candidatas = await pool.query(
    `SELECT categoria FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
       AND (tipo = $2 OR tipo = 'ambos' OR tipo IS NULL)`,
    [uid, tipo]
  );
  const alvo = normalizarCategoriaParaComparacao(categoriaPluggy);
  const exata = candidatas.rows.find((r) => normalizarCategoriaParaComparacao(r.categoria) === alvo);
  if (exata) return exata.categoria;

  // (2) Sem match exato: fuzzy de sempre (ILIKE, mesmo padrão de
  // buscarContasPorNome).
  const res = await pool.query(
    `SELECT categoria FROM limites_categoria
     WHERE usuario_id = $1 AND ativo = TRUE
       AND (tipo = $2 OR tipo = 'ambos' OR tipo IS NULL)
       AND categoria ILIKE $3
     LIMIT 2`,
    [uid, tipo, `%${categoriaPluggy}%`]
  );

  if (res.rows.length === 1) return res.rows[0].categoria;

  // >1 matches: ambíguo demais para decidir sozinho — cai no fallback sem
  // criar nada (criar mais uma variação parecida só pioraria a ambiguidade).
  if (res.rows.length > 1) return generica;

  // 0 matches: nada parecido ainda — cria subcategoria nova se soubermos a
  // categoria principal de destino (null para transferências/categoryId
  // desconhecido, ver src/pluggy.js:categoriaPrincipalParaGrupoRaiz).
  if (categoriaPrincipalDestino) {
    const tipoPrincipal = tipo === 'receita' ? 'receita' : 'despesa';
    await garantirCategoriaPrincipal(uid, categoriaPrincipalDestino, tipoPrincipal);
    await garantirSubcategoria(uid, categoriaPluggy, categoriaPrincipalDestino, tipo);
    return categoriaPluggy;
  }

  return generica;
}

// ─── Vínculo automático: transação da Pluggy × regra de recorrência ─────────
//
// Ver src/recorrencia-match.js para o critério e o porquê dele. Aqui mora só o
// I/O: buscar candidatas, checar o mês e decidir o que fazer com uma projeção
// já materializada.
//
// A query corta por tipo + vigência; descrição, janela e faixa ficam para o
// módulo puro. Nenhum corte por valor no SQL: a acumulação existe justamente
// para o caso em que a entrada vale menos que o previsto, e o único lado da
// faixa que elimina (o teto) precisa da soma do mês para valer direito.
const DATA_ISO_ESTRITA = /^\d{4}-\d{2}-\d{2}$/;

async function buscarRecorrenciasCandidatas(uid, { tipo, data }) {
  const res = await pool.query(
    `SELECT id, tipo, valor::float AS valor, descricao, frequencia, dia_mes, dia_semana,
            dia_inicial, dia_limite,
            valor_min::float AS valor_min, valor_max::float AS valor_max,
            TO_CHAR(data_inicio, 'YYYY-MM-DD') AS data_inicio,
            TO_CHAR(data_fim,    'YYYY-MM-DD') AS data_fim
     FROM recorrencias
     WHERE usuario_id = $1
       AND ativo = TRUE
       AND tipo = $2
       AND data_inicio <= $3::date
       AND (data_fim IS NULL OR data_fim >= $3::date)`,
    [uid, tipo, data]
  );
  return res.rows;
}

// Soma real do mês de VÁRIAS regras de uma vez -> Map<recorrencia_id, soma>.
//
// Só é chamada no caminho ambíguo (mais de uma regra casando com o mesmo
// lançamento), que é raro: no caminho comum de uma candidata só, o estado do
// balde já vem de buscarEstadoBalde e uma query a mais seria desperdício em
// todo sync. Agregada em vez de uma consulta por candidata pelo mesmo motivo
// de buscarEstadosBaldeMes — o laço de sincronização não pode virar N+1.
async function buscarSomasReaisMes(uid, recorrenciaIds, data) {
  if (!recorrenciaIds || recorrenciaIds.length === 0) return new Map();
  const res = await pool.query(
    `SELECT recorrencia_id,
            COALESCE(SUM(valor) FILTER (WHERE projetada = FALSE), 0)::float AS soma_real
     FROM transacoes
     WHERE usuario_id = $1
       AND recorrencia_id = ANY($2::int[])
       AND date_trunc('month', data::timestamp) = date_trunc('month', $3::date::timestamp)
     GROUP BY recorrencia_id`,
    [uid, recorrenciaIds, data]
  );
  return new Map(res.rows.map((r) => [r.recorrencia_id, r.soma_real]));
}

// Estado do balde de uma recorrência num mês: quanto já entrou de verdade
// (projeções não contam — elas são a estimativa que o real substitui) e quais
// projeções ainda ocupam o mês.
async function buscarEstadoBalde(uid, recorrenciaId, data) {
  const res = await pool.query(
    `SELECT
       COALESCE(SUM(valor) FILTER (WHERE projetada = FALSE), 0)::float AS soma_real,
       COUNT(*) FILTER (WHERE projetada = FALSE)::int AS qtd_real,
       COALESCE(ARRAY_AGG(id) FILTER (WHERE projetada = TRUE), '{}')::int[] AS projecoes
     FROM transacoes
     WHERE usuario_id = $1
       AND recorrencia_id = $2
       AND date_trunc('month', data::timestamp) = date_trunc('month', $3::date::timestamp)`,
    [uid, recorrenciaId, data]
  );
  const linha = res.rows[0] || {};
  const consolidado = await pool.query(
    `SELECT 1 FROM recorrencias_consolidacoes
     WHERE recorrencia_id = $1 AND competencia = $2 LIMIT 1`,
    [recorrenciaId, String(data).slice(0, 7)]
  );
  return {
    somaReal: linha.soma_real || 0,
    qtdReal: linha.qtd_real || 0,
    projecoes: linha.projecoes || [],
    consolidado: consolidado.rows.length > 0,
  };
}

// resolverVinculoRecorrencia -> { recorrenciaId, absorver: id[] }
//
// recorrenciaId null = grava como sempre gravou, lançamento avulso. É o
// fallback de TODO caminho duvidoso — ambiguidade, balde fechado, descrição
// sem chave confiável. Não vincular deixa um avulso na tela, que o usuário
// enxerga e corrige; vincular errado reescreve o histórico em silêncio.
//
// `absorver` são as PROJEÇÕES (projetada = TRUE) que ocupam o mês daquela
// recorrência e precisam SAIR quando a primeira entrada real chega: a projeção
// é a estimativa do mês inteiro, e mantê-la ao lado do dinheiro que entrou
// contaria o valor duas vezes. A partir da segunda entrada não há mais
// projeção para absorver — aí é acumulação pura.
async function resolverVinculoRecorrencia(uid, { tipo, valor, descricao, data }) {
  const semVinculo = { recorrenciaId: null, absorver: [] };

  if (!DATA_ISO_ESTRITA.test(String(data || ''))) return semVinculo;
  // Sem chave de estabelecimento não há como comparar descrição — corta antes
  // de ir ao banco.
  if (!normalizarEstabelecimento(descricao)) return semVinculo;

  const candidatas = await buscarRecorrenciasCandidatas(uid, { tipo, data });
  if (candidatas.length === 0) return semVinculo;

  const compativeis = filtrarRecorrenciasCompativeis(candidatas, { tipo, valor, descricao, data });
  if (compativeis.length === 0) return semVinculo;

  // Mais de uma regra casando: a faixa de valor desempata (ver
  // escolherRecorrencia). Só aqui a soma do mês de cada candidata é buscada —
  // no caminho de uma candidata só ela não muda decisão nenhuma.
  let escolha = { regra: compativeis[0], motivo: 'unica' };
  if (compativeis.length > 1) {
    const somaPorRegra = await buscarSomasReaisMes(uid, compativeis.map(r => r.id), data);
    escolha = escolherRecorrencia(compativeis, { valor }, { somaPorRegra });
  }

  // Ambiguidade que a faixa não resolveu: duas regras com a MESMA origem, a
  // MESMA janela e ambas comportando o lançamento. Não há critério técnico para
  // escolher — escolher seria sorteio. O desempate é do usuário, dando faixa a
  // uma delas ou reorganizando as regras. Log sem a descrição (contém nome de
  // contraparte); os ids bastam para investigar.
  if (!escolha.regra) {
    console.warn(
      `[DB] Pluggy × recorrência: ${compativeis.length} regras casam com o mesmo lançamento ` +
      `(${data}, ${tipo}) — ids [${compativeis.map(r => r.id).join(', ')}]. ` +
      `Nenhum vínculo criado (ambíguo).`
    );
    return semVinculo;
  }

  const regra = escolha.regra;
  if (escolha.motivo !== 'unica') {
    console.log(
      `[DB] Pluggy × recorrência: ${compativeis.length} candidatas em ${data} (${tipo}) — ` +
      `desempate por ${escolha.motivo} escolheu a regra #${regra.id}.`
    );
  }
  const balde = await buscarEstadoBalde(uid, regra.id, data);

  // Balde fechado = a acumulação daquele mês acabou, por teto alcançado, por
  // janela vencida ou por consolidação do usuário. A entrada que chega depois
  // não pertence à recorrência: vira avulso.
  //
  // `valorPrevisto: regra.valor` é o teto de regra SEM faixa. Com faixa, quem
  // manda é `valor_max` e baldeFechado ignora este argumento (ver tetoDoBalde)
  // — é o que mantém o balde aberto depois de alcançar o previsto, esperando a
  // parte que ainda pode vir dentro da faixa.
  if (baldeFechado({
    valorPrevisto: regra.valor,
    somaReal: balde.somaReal,
    regra,
    data,
    consolidado: balde.consolidado,
  })) {
    console.log(
      `[DB] Pluggy × recorrência #${regra.id}: balde de ${String(data).slice(0, 7)} já fechado ` +
      `(${balde.qtdReal} entrada[s], consolidado=${balde.consolidado}) — lançamento entra como avulso.`
    );
    return semVinculo;
  }

  return { recorrenciaId: regra.id, absorver: balde.projecoes };
}

// Dedup por pluggy_transaction_id: UPDATE se já existe (valor/status/categoria
// podem mudar entre syncs — ex: fatura que estava PENDING vira POSTED), INSERT
// se é nova. Mesmo padrão de numero_usuario via subquery de adicionarTransacao
// (linha ~875).
//
// Exceção da categoria: se categoria_manual = TRUE, o usuário já corrigiu essa
// linha à mão — valor/status/data continuam sendo atualizados normalmente (o
// banco é a fonte da verdade para eles), mas a categoria fica como está. Sem
// isso, todo re-sync desfazia a correção em silêncio.
//
// Mesma exceção para a descrição, via CASE no próprio UPDATE (decidido no
// banco, sem ler a flag antes — não abre janela de corrida entre a leitura e a
// escrita): descrição escrita pelo usuário não é sobrescrita pelo texto do
// banco. descricao_exibicao é dado derivado (merchant.businessName) e é sempre
// atualizado, com COALESCE para não apagar um nome já conhecido quando a
// Pluggy não devolve merchant naquele sync.
//
// No INSERT (só nele) a transação também tenta se vincular a uma regra de
// recorrência — ver resolverVinculoRecorrencia logo acima. É o que impede o
// painel de materializar um projetado por cima do dinheiro que a Pluggy já
// trouxe.
async function upsertTransacaoPluggy(usuarioId, dados) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const {
    pluggyTransactionId, tipo, valor, descricao, categoria, data, status, contaId, cartaoId,
    parcelaAtual = null, parcelaTotal = null, parcelaGrupo = null,
    contraparteHash = null, descricaoExibicao = null,
  } = dados;

  const existente = await pool.query(
    `SELECT id, categoria_manual FROM transacoes WHERE pluggy_transaction_id = $1`,
    [pluggyTransactionId]
  );

  if (existente.rows.length > 0) {
    if (existente.rows[0].categoria_manual) {
      await pool.query(
        `UPDATE transacoes
         SET valor = $2, descricao = CASE WHEN descricao_manual THEN descricao ELSE $3 END,
             data = $4, status = $5,
             parcela_atual = $6, parcela_total = $7, parcela_grupo = $8,
             contraparte_hash = COALESCE($9, contraparte_hash),
             descricao_exibicao = COALESCE($10, descricao_exibicao)
         WHERE pluggy_transaction_id = $1`,
        [pluggyTransactionId, valor, descricao, data, status, parcelaAtual, parcelaTotal, parcelaGrupo, contraparteHash, descricaoExibicao]
      );
    } else {
      await pool.query(
        `UPDATE transacoes
         SET valor = $2, descricao = CASE WHEN descricao_manual THEN descricao ELSE $3 END,
             categoria = $4, data = $5, status = $6,
             parcela_atual = $7, parcela_total = $8, parcela_grupo = $9,
             contraparte_hash = COALESCE($10, contraparte_hash),
             descricao_exibicao = COALESCE($11, descricao_exibicao)
         WHERE pluggy_transaction_id = $1`,
        [pluggyTransactionId, valor, descricao, categoria, data, status, parcelaAtual, parcelaTotal, parcelaGrupo, contraparteHash, descricaoExibicao]
      );
    }
    return { id: existente.rows[0].id, novo: false };
  }

  // Transação NOVA: é aqui, e só aqui, que o vínculo com recorrência é
  // decidido. No UPDATE acima o vínculo já existe (ou já foi recusado) e
  // reavaliar a cada re-sync só criaria vaivém.
  //
  // Todo o bloco degrada para "grava sem vínculo" em qualquer falha: este
  // código roda dentro do laço de sincronização, e uma recorrência mal casada
  // (ou um banco sem a coluna) não pode derrubar a importação inteira.
  let recorrenciaId = null;
  let absorver = [];
  try {
    const vinculo = await resolverVinculoRecorrencia(uid, { tipo, valor, descricao, data });
    recorrenciaId = vinculo.recorrenciaId;
    absorver = vinculo.absorver;
  } catch (err) {
    console.error('[DB] upsertTransacaoPluggy: falha ao avaliar vínculo de recorrência (segue sem vínculo):', err.message);
  }

  if (recorrenciaId && absorver.length > 0) {
    try {
      // Predicado repetido no DELETE (não só na leitura): fecha a janela entre
      // consultar e apagar. `projetada = TRUE` é a marca explícita — nunca
      // apaga lançamento real, nem quando ele está pendente.
      const del = await pool.query(
        `DELETE FROM transacoes
         WHERE id = ANY($1::int[])
           AND usuario_id = $2
           AND recorrencia_id = $3
           AND projetada = TRUE`,
        [absorver, uid, recorrenciaId]
      );
      console.log(`[DB] Pluggy × recorrência #${recorrenciaId}: ${del.rowCount} projeção(ões) absorvida(s) pelo lançamento real de ${data}.`);
    } catch (err) {
      // Não conseguiu limpar o mês: vincular agora estouraria o índice único.
      console.error(`[DB] Pluggy × recorrência #${recorrenciaId}: falha ao absorver projeção (segue sem vínculo):`, err.message);
      recorrenciaId = null;
    }
  }

  const inserir = (vinculoId) => pool.query(
    `INSERT INTO transacoes
       (usuario_id, tipo, valor, descricao, categoria, data, status, conta_id, cartao_id, pluggy_transaction_id,
        recorrencia_id, parcela_atual, parcela_total, parcela_grupo, contraparte_hash, descricao_exibicao, numero_usuario)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       (SELECT COALESCE(MAX(numero_usuario), 0) + 1 FROM transacoes WHERE usuario_id = $1))
     RETURNING id`,
    [uid, tipo, valor, descricao, categoria || 'Outros', data, status, contaId || null, cartaoId || null, pluggyTransactionId,
     vinculoId, parcelaAtual, parcelaTotal, parcelaGrupo, contraparteHash, descricaoExibicao]
  );

  try {
    const res = await inserir(recorrenciaId);
    return { id: res.rows[0].id, novo: true, recorrenciaId };
  } catch (err) {
    // 23505 = unique_violation. No modelo de acumulação o INSERT real não tem
    // índice que o proíba — este ramo cobre o caso em que a migração que
    // derruba idx_transacoes_recorrencia_mes falhou e a trava antiga ainda
    // está de pé no banco. A transação da Pluggy precisa entrar de qualquer
    // jeito: perder o vínculo é aceitável, perder o lançamento não.
    if (recorrenciaId && err.code === '23505') {
      console.error(`[DB] Pluggy × recorrência #${recorrenciaId}: INSERT vinculado recusado pelo banco (trava antiga ainda ativa?) — transação gravada sem vínculo.`);
      const res = await inserir(null);
      return { id: res.rows[0].id, novo: true, recorrenciaId: null };
    }
    throw err;
  }
}

async function removerTransacoesPluggyPorIds(pluggyTransactionIds) {
  if (!pluggyTransactionIds?.length) return 0;
  const res = await pool.query(
    `DELETE FROM transacoes WHERE pluggy_transaction_id = ANY($1::text[])`,
    [pluggyTransactionIds]
  );
  return res.rowCount;
}

// Recalibra saldo_inicial de uma conta espelho Pluggy para que
// calcularSaldosPorConta volte a bater com o saldo real reportado pela
// Pluggy (Account.balance) — a Pluggy só traz uma janela de histórico (até
// 365 dias), não desde a abertura da conta, então a soma das transações
// importadas sozinha não fecha com o saldo real (gap descoberto em produção:
// saldo_inicial=0 fixo, decisão do Marco 2, subestimava o saldo real do
// Federico na diferença do histórico não trazido).
//
// Fórmula espelha EXATAMENTE calcularSaldosPorConta (linha ~1508) menos o
// próprio saldo_inicial — inclui transferências para não ficar sutilmente
// errada se o usuário transferir manualmente de/para essa conta. Roda a cada
// sync bem-sucedido de conta bancária (idempotente — recalcula do zero,
// nunca acumula: sempre converge para o mesmo balance real, não importa
// quantas vezes rodar).
async function calibrarSaldoInicialConta(usuarioId, contaId, balanceReal) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const res = await pool.query(
    `SELECT (
       COALESCE((
         SELECT SUM(CASE WHEN tipo = 'receita' THEN valor ELSE -valor END)
         FROM transacoes
         WHERE usuario_id = $1 AND conta_id = $2 AND status = 'pago' AND cartao_id IS NULL
       ), 0)
       + COALESCE((SELECT SUM(valor) FROM transferencias WHERE usuario_id = $1 AND conta_destino_id = $2), 0)
       - COALESCE((SELECT SUM(valor) FROM transferencias WHERE usuario_id = $1 AND conta_origem_id = $2), 0)
     )::float AS liquido`,
    [uid, contaId]
  );
  const liquido = res.rows[0].liquido;
  const novoSaldoInicial = Number(balanceReal) - liquido;

  await pool.query(
    `UPDATE contas SET saldo_inicial = $2 WHERE id = $1 AND usuario_id = $3`,
    [contaId, novoSaldoInicial, uid]
  );

  return novoSaldoInicial;
}

// ─── Posições de investimento (produto INVESTMENTS da Pluggy) ────────────────
//
// Nenhuma função desta seção é chamada por calcularSaldos/calcularSaldosPorConta,
// e isso é intencional — ver o comentário da tabela `investimentos` em initTables.

// Upsert por pluggy_investment_id: o saldo de um ativo muda a cada sync, então a
// mesma posição precisa ser ATUALIZADA, nunca reinserida. Sem a chave única, um
// re-sync duplicaria as 78 posições e dobraria o total investido na tela.
// Ressuscita (ativo = TRUE) uma posição que havia sumido e voltou.
async function upsertInvestimentoPluggy(usuarioId, pluggyItemDbId, dados) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const {
    pluggyInvestmentId, nome, tipo = null, subtipo = null, saldo = 0,
    valorAplicado = null, lucro = null, taxa = null, tipoTaxa = null,
    rentabilidade12m = null, vencimento = null, emissor = null,
    instituicao = null, status = null,
  } = dados;

  const res = await pool.query(
    `INSERT INTO investimentos
       (usuario_id, pluggy_item_id, pluggy_investment_id, nome, tipo, subtipo, saldo,
        valor_aplicado, lucro, taxa, tipo_taxa, rentabilidade_12m, vencimento,
        emissor, instituicao, status, ativo, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, TRUE, NOW())
     ON CONFLICT (pluggy_investment_id) DO UPDATE SET
       nome = EXCLUDED.nome,
       tipo = EXCLUDED.tipo,
       subtipo = EXCLUDED.subtipo,
       saldo = EXCLUDED.saldo,
       valor_aplicado = EXCLUDED.valor_aplicado,
       lucro = EXCLUDED.lucro,
       taxa = EXCLUDED.taxa,
       tipo_taxa = EXCLUDED.tipo_taxa,
       rentabilidade_12m = EXCLUDED.rentabilidade_12m,
       vencimento = EXCLUDED.vencimento,
       emissor = EXCLUDED.emissor,
       instituicao = EXCLUDED.instituicao,
       status = EXCLUDED.status,
       ativo = TRUE,
       atualizado_em = NOW()
     RETURNING id, (xmax = 0) AS novo`,
    [uid, pluggyItemDbId, pluggyInvestmentId, nome, tipo, subtipo, saldo,
     valorAplicado, lucro, taxa, tipoTaxa, rentabilidade12m, vencimento,
     emissor, instituicao, status]
  );

  return { id: res.rows[0].id, novo: res.rows[0].novo };
}

// Ativo que sumiu da API vira inativo — resgate/vencimento é histórico legítimo,
// não erro de sync, então nunca DELETE.
//
// O escopo por pluggy_item_id é obrigatório: sem ele, sincronizar o banco A
// desativaria as posições do banco B do mesmo usuário. Lista vazia desativa tudo
// do item (= ANY('{}') é falso, logo NOT ... é verdadeiro para todas as linhas),
// que é o comportamento correto quando o usuário resgatou tudo naquele banco.
async function desativarInvestimentosAusentes(pluggyItemDbId, idsPresentes) {
  const res = await pool.query(
    `UPDATE investimentos
     SET ativo = FALSE, atualizado_em = NOW()
     WHERE pluggy_item_id = $1
       AND ativo = TRUE
       AND NOT (pluggy_investment_id = ANY($2::text[]))
     RETURNING id`,
    [pluggyItemDbId, idsPresentes || []]
  );
  return res.rowCount;
}

async function listarInvestimentos(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  const res = await pool.query(
    `SELECT id, pluggy_investment_id, nome, tipo, subtipo, saldo::float,
            valor_aplicado::float, lucro::float, taxa::float, tipo_taxa,
            rentabilidade_12m::float, TO_CHAR(vencimento, 'YYYY-MM-DD') AS vencimento,
            emissor, instituicao, status
     FROM investimentos
     WHERE usuario_id = $1 AND ativo = TRUE
     ORDER BY saldo DESC, nome ASC`,
    [uid]
  );
  return res.rows;
}

// Agregação para o painel/WhatsApp. Com dezenas de posições (o caso real tem 78
// CDBs), listar ativo a ativo não informa nada — o que informa é o total, a
// composição por tipo e a concentração por emissor (risco de crédito).
async function resumoInvestimentos(usuarioId) {
  const uid = await resolverUsuarioPrincipal(usuarioId);

  const totaisRes = await pool.query(
    `SELECT
       COALESCE(SUM(saldo), 0)::float           AS total,
       COALESCE(SUM(valor_aplicado), 0)::float  AS total_aplicado,
       COALESCE(SUM(lucro), 0)::float           AS total_lucro,
       COUNT(*)::int                            AS quantidade
     FROM investimentos
     WHERE usuario_id = $1 AND ativo = TRUE`,
    [uid]
  );

  const porTipoRes = await pool.query(
    `SELECT COALESCE(tipo, 'OUTROS') AS tipo,
            COALESCE(SUM(saldo), 0)::float AS total,
            COUNT(*)::int AS quantidade
     FROM investimentos
     WHERE usuario_id = $1 AND ativo = TRUE
     GROUP BY COALESCE(tipo, 'OUTROS')
     ORDER BY total DESC`,
    [uid]
  );

  const porEmissorRes = await pool.query(
    `SELECT COALESCE(emissor, instituicao, 'Não informado') AS emissor,
            COALESCE(SUM(saldo), 0)::float AS total,
            COUNT(*)::int AS quantidade
     FROM investimentos
     WHERE usuario_id = $1 AND ativo = TRUE
     GROUP BY COALESCE(emissor, instituicao, 'Não informado')
     ORDER BY total DESC`,
    [uid]
  );

  const t = totaisRes.rows[0];
  return {
    total: t.total,
    totalAplicado: t.total_aplicado,
    totalLucro: t.total_lucro,
    quantidade: t.quantidade,
    porTipo: porTipoRes.rows,
    porEmissor: porEmissorRes.rows,
  };
}

// Atualiza limite/usado/disponível de um cartão espelho Pluggy com os valores
// REAIS da API (Account.balance, Account.creditData.creditLimit/
// availableCreditLimit) — nunca calculados a partir de transacoes. Chamado a
// cada sync bem-sucedido de uma Account tipo CREDIT (mesmo raciocínio de
// calibrarSaldoInicialConta: idempotente, recalcula do zero, sempre converge).
// limiteTotal usa COALESCE para não apagar um valor já existente se a API não
// trouxer creditLimit numa chamada específica; valorUsado/disponivel são
// sempre sobrescritos (só existem quando vêm da Pluggy, não há "manual" a
// preservar).
async function atualizarCartaoPluggyDados(usuarioId, cartaoId, { limiteTotal, valorUsado, disponivel }) {
  const uid = await resolverUsuarioPrincipal(usuarioId);
  await pool.query(
    `UPDATE cartoes
     SET limite_total = COALESCE($2, limite_total),
         pluggy_valor_usado = $3,
         pluggy_disponivel = $4
     WHERE id = $1 AND usuario_id = $5`,
    [cartaoId, limiteTotal, valorUsado, disponivel, uid]
  );
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
  listarRecorrenciaIdsNoPeriodo,
  limparProjecoesDuplicadas,
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
  normalizarRegraCasamento,
  listarRecorrencias,
  calcularOcorrenciasNoPerodo,
  adicionarTransacaoComRecorrencia,
  tornarTransacaoRecorrente,
  projetarProximosMeses,
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
  obterUsoCartao,
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
  listarLimitadores,
  salvarLimitador,
  excluirLimitador,
  buscarLimitadorPorNome,
  verificarLimitadorDaCategoria,
  listarConsumoLimitadores,
  registrarFaixaAlertada,
  janelasDeControle,
  inicioSemanaISO,
  fimSemanaISO,
  chaveSemanaISO,
  faixaDeAlerta,
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
  // Credenciais Pluggy (Marco 1)
  salvarCredencialPluggy,
  buscarCredencialPluggy,
  usuarioTemCredencialPluggy,
  removerCredencialPluggy,
  // Items e contas/cartões espelho Pluggy (Marco 2)
  salvarPluggyItem,
  listarPluggyItems,
  proximoNomeDisponivel,
  criarContaPluggy,
  criarCartaoPluggy,
  // Webhook e sincronização de transações Pluggy (Marco 3)
  obterOuCriarWebhookTokenPluggy,
  buscarUsuarioIdPorWebhookToken,
  buscarPluggyItemPorItemId,
  buscarPluggyItemDoUsuario,
  atualizarStatusPluggyItem,
  marcarPluggyItemSincronizado,
  listarContasMapPorItem,
  buscarMapeamentoContaPorAccountId,
  resolverCategoriaPluggy,
  registrarCategoriaAprendida,
  buscarCategoriaAprendida,
  registrarCategoriaAprendidaDocumento,
  buscarCategoriaAprendidaDocumento,
  garantirCategoriaPrincipal,
  upsertTransacaoPluggy,
  resolverVinculoRecorrencia,
  consolidarRecorrenciaMes,
  desconsolidarRecorrenciaMes,
  listarConsolidacoesNoPeriodo,
  faltaDaOcorrencia,
  buscarEstadosBaldeMes,
  removerTransacoesPluggyPorIds,
  calibrarSaldoInicialConta,
  atualizarCartaoPluggyDados,
  calcularPatrimonio,
  upsertInvestimentoPluggy,
  desativarInvestimentosAusentes,
  listarInvestimentos,
  resumoInvestimentos,
};
