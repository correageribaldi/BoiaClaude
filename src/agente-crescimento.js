// ── Agente de Crescimento (CEO Virtual) ─────────────────────────────────────
// Agente de inteligência de negócios que analisa métricas, identifica padrões
// de crescimento/churn e sugere ações concretas para o admin via WhatsApp.
// Inclui briefing diário automático e interação sob demanda.

const cron = require('node-cron');
const db = require('./database');

// Helper: formatarMoeda seguro
function moeda(v) { return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ── Ofertas pendentes (promoções enviadas pelo SEO aguardando resposta) ──────

const ofertasPendentes = new Map();
const OFERTA_TTL = 48 * 60 * 60 * 1000; // 48 horas para aceitar

function registrarOferta(usuarioId, tipo, dias) {
  ofertasPendentes.set(usuarioId, { tipo, dias, expiraEm: Date.now() + OFERTA_TTL });
}

function obterOferta(usuarioId) {
  const o = ofertasPendentes.get(usuarioId);
  if (!o) return null;
  if (Date.now() > o.expiraEm) { ofertasPendentes.delete(usuarioId); return null; }
  return o;
}

function limparOferta(usuarioId) { ofertasPendentes.delete(usuarioId); }

// ── Estado por admin ────────────────────────────────────────────────────────

const estadosCrescimento = new Map();
const TTL = 30 * 60 * 1000; // 30 minutos
const CONTEXT_REFRESH_MS = 10 * 60 * 1000; // 10 minutos

function salvarEstado(adminId, dados) {
  estadosCrescimento.set(adminId, { ...dados, expiraEm: Date.now() + TTL });
}

function obterEstadoCrescimento(adminId) {
  const e = estadosCrescimento.get(adminId);
  if (!e) return null;
  if (Date.now() > e.expiraEm) { estadosCrescimento.delete(adminId); return null; }
  return e;
}

function limparEstadoCrescimento(adminId) { estadosCrescimento.delete(adminId); }

function adminIds() {
  return (process.env.ADMIN_WHATSAPP_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Contexto de métricas ────────────────────────────────────────────────────

async function buildMetricsContext() {
  const [
    totalUsuarios, novos7d, novos30d, churned,
    assinaturas, transacoes7d, transacoes30d,
    engajamento7d, categoriasTop, risco, funil,
    reativacao, campanhas,
  ] = await Promise.all([
    db.contarUsuariosTotal(),
    db.contarUsuariosNovos(7),
    db.contarUsuariosNovos(30),
    db.contarUsuariosChurned(),
    db.metricsAssinaturasPorStatus(),
    db.metricsTransacoesAgregadas(7),
    db.metricsTransacoesAgregadas(30),
    db.metricsEngajamentoUsuarios(7),
    db.metricsCategoriasTop(7, 5),
    db.metricsUsuariosRisco(),
    db.metricsFunilConversao(),
    db.metricsReativacao(),
    db.metricsLogsCampanhas(7),
  ]);

  const statusMap = {};
  for (const s of assinaturas) statusMap[s.status] = s.total;

  const pagantes = statusMap.ativo || 0;
  const mrrEstimado = pagantes * 39; // R$39/mês por assinante

  const text = [
    `MÉTRICAS ATUAIS (gerado ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`,
    '',
    `USUÁRIOS:`,
    `- Total: ${totalUsuarios}`,
    `- Novos (7d): ${novos7d} | Novos (30d): ${novos30d}`,
    `- Churned: ${churned}`,
    `- Em risco (inativos 2-7d): ${risco.length}`,
    '',
    `ENGAJAMENTO (7 dias):`,
    `- Usuários ativos: ${engajamento7d.usuarios_ativos || 0}`,
    `- Transações: ${transacoes7d.total_transacoes || 0}`,
    `- Média por usuário: ${engajamento7d.media_por_usuario || 0}`,
    `- Top categorias: ${categoriasTop.map(c => `${c.categoria}(${c.total})`).join(', ') || 'nenhuma'}`,
    '',
    `TRANSAÇÕES (30 dias):`,
    `- Total: ${transacoes30d.total_transacoes || 0}`,
    `- Despesas: ${moeda(transacoes30d.total_despesas)}`,
    `- Receitas: ${moeda(transacoes30d.total_receitas)}`,
    `- Valor médio: ${moeda(transacoes30d.valor_medio)}`,
    '',
    `RECEITA:`,
    `- Pagantes: ${pagantes}`,
    `- Trial: ${statusMap.trial || 0}`,
    `- Expirados: ${statusMap.expirado || 0}`,
    `- Graça: ${statusMap.graca || 0}`,
    `- MRR estimado: ${moeda(mrrEstimado)}`,
    '',
    `FUNIL:`,
    `- Registros: ${funil.total_registros} → Trial: ${funil.em_trial} → Pagantes: ${funil.pagantes}`,
    `- Taxa conversão: ${funil.total_registros > 0 ? ((funil.pagantes / funil.total_registros) * 100).toFixed(1) : 0}%`,
    '',
    `REATIVAÇÃO (30d):`,
    reativacao.length > 0
      ? reativacao.map(r => `- Etapa ${r.etapa}: ${r.total} envios`).join('\n')
      : '- Nenhum envio recente',
    '',
    `CAMPANHAS (7d):`,
    campanhas.length > 0
      ? campanhas.map(c => `- ${c.titulo}: ${c.enviados}/${c.total} enviados (${c.status})`).join('\n')
      : '- Nenhuma campanha recente',
    '',
    `USUÁRIOS EM RISCO:`,
    risco.length > 0
      ? risco.slice(0, 5).map(u => `- ${u.nome || u.usuario_id}: ${u.dias_inativo}d inativo (${u.status || 'sem assinatura'})`).join('\n')
      : '- Nenhum usuário em risco',
  ].join('\n');

  return { text, dados: { totalUsuarios, novos7d, novos30d, churned, statusMap, transacoes7d, transacoes30d, engajamento7d, categoriasTop, risco, funil, reativacao, campanhas, pagantes, mrrEstimado } };
}

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(contextText) {
  const dataHoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `Você é o CEO Virtual do Cronos, um assessor de crescimento e inteligência de negócios.
Você analisa métricas do app, identifica padrões e sugere ações concretas para crescer.

PERSONALIDADE:
- Estratégico, direto, baseado em dados
- Proativo: identifica problemas e oportunidades antes de ser perguntado
- Fala como um CEO/advisor experiente, não como um bot
- Português brasileiro informal mas profissional

FORMATAÇÃO (WhatsApp):
- Use *negrito* para destaques e _itálico_ para observações
- Emojis estratégicos (📈📉⚠️💰🎯) — não decorativos
- Máximo 20 linhas por resposta
- Listas com bullet points quando apresentar dados

Data de hoje: ${dataHoje}

${contextText}

CAPACIDADES:
Você pode ANALISAR (consultar métricas, funil, churn, engajamento) e também AGIR:
- Enviar mensagem individual para qualquer usuário
- Enviar campanha em massa (por segmento: ativos, inativos, trial, etc.)
- Criar campanha agendada (cron recorrente)
- Ativar assinatura de usuário
- Listar campanhas ativas

REGRAS:
1. Sempre basear sugestões em dados concretos das métricas
2. Usar comparativos quando possível (semana passada vs esta, mês vs mês)
3. Priorizar ações por impacto: retenção > aquisição > monetização
4. Ser específico e quando o admin pedir para executar uma ação, EXECUTE usando as tools disponíveis
5. Quando identificar problemas, sugerir a solução E oferecer executar na hora
6. Se os dados são de base pequena (< 20 usuários), mencionar que tendências podem ser instáveis
7. Use as ferramentas disponíveis para buscar dados adicionais quando necessário
8. Para campanhas em massa, SEMPRE confirme com o admin antes de enviar (mostre o texto e quantos receberão)
9. Responda "sair" ou "voltar" do admin significa encerrar sessão`;
}

// ── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'obter_metricas_usuarios',
      description: 'Obter contagens de usuários: total, novos no período, ativos, inativos, churned',
      parameters: {
        type: 'object',
        properties: {
          periodo_dias: { type: 'integer', description: 'Período em dias para filtrar (padrão: 7)', default: 7 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_metricas_engajamento',
      description: 'Métricas de engajamento: transações por usuário, frequência de interação, última atividade',
      parameters: {
        type: 'object',
        properties: {
          periodo_dias: { type: 'integer', description: 'Período em dias (padrão: 30)', default: 30 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_metricas_receita',
      description: 'Métricas de receita: assinaturas por status (trial/ativo/expirado/graca), MRR estimado',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_metricas_churn',
      description: 'Métricas de churn: total churned, etapas de reativação, usuários em cada estágio',
      parameters: {
        type: 'object',
        properties: {
          periodo_dias: { type: 'integer', description: 'Período em dias (padrão: 30)', default: 30 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_metricas_transacoes',
      description: 'Volume de transações agregado: total, por tipo (receita/despesa), valor médio, categorias mais usadas',
      parameters: {
        type: 'object',
        properties: {
          periodo_dias: { type: 'integer', description: 'Período em dias (padrão: 30)', default: 30 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_crescimento_periodo',
      description: 'Comparar métricas entre dois períodos (semana a semana ou mês a mês): novos usuários, transações, receita',
      parameters: {
        type: 'object',
        properties: {
          tipo_comparacao: { type: 'string', enum: ['semanal', 'mensal'], description: 'Tipo de comparação: semanal (7d vs 7d) ou mensal (30d vs 30d)' },
        },
        required: ['tipo_comparacao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_usuarios_risco',
      description: 'Listar usuários em risco de churn: inativos 2-7 dias, trial expirando, assinatura expirando',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Quantidade máxima de resultados (padrão: 20)', default: 20 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_metricas_campanhas',
      description: 'Resultados das campanhas admin: crons executadas, mensagens enviadas, erros',
      parameters: {
        type: 'object',
        properties: {
          periodo_dias: { type: 'integer', description: 'Período em dias (padrão: 7)', default: 7 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_funil_usuarios',
      description: 'Funil de conversão: registro → trial → pagante, com taxas de conversão em cada etapa',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obter_top_usuarios',
      description: 'Top usuários por engajamento: mais transações, maior volume financeiro',
      parameters: {
        type: 'object',
        properties: {
          limite: { type: 'integer', description: 'Quantidade (padrão: 10)', default: 10 },
          periodo_dias: { type: 'integer', description: 'Período em dias (padrão: 30)', default: 30 },
        },
      },
    },
  },
  // ── Tools de AÇÃO ─────────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'enviar_mensagem_usuario',
      description: 'Enviar mensagem para um usuário específico via WhatsApp. Use {nome} no texto para personalizar com o primeiro nome.',
      parameters: {
        type: 'object',
        properties: {
          usuario_id: { type: 'string', description: 'ID do usuário (ex: 5511999998888@c.us)' },
          mensagem: { type: 'string', description: 'Texto da mensagem (suporta *negrito*, _itálico_, ~tachado~)' },
        },
        required: ['usuario_id', 'mensagem'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_campanha',
      description: 'Enviar mensagem em massa para um grupo de usuários filtrado por regra. Use {nome} para personalizar. Se incluir oferta_dias_gratis, os usuários podem responder "sim" para ganhar dias grátis automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          mensagem: { type: 'string', description: 'Texto da mensagem (suporta {nome} para personalizar)' },
          regra: { type: 'string', enum: ['ativos_x_dias', 'inativos_x_dias', 'nao_pagantes', 'trial', 'expirados', 'graca'], description: 'Regra de segmentação dos destinatários' },
          regra_valor: { type: 'integer', description: 'Valor da regra em dias (ex: 7 para inativos_x_dias=7)' },
          oferta_dias_gratis: { type: 'integer', description: 'Se informado, registra oferta de X dias grátis — usuário responde "sim" e ganha ativação automática' },
        },
        required: ['mensagem', 'regra'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_campanha_agendada',
      description: 'Criar campanha agendada (cron) que envia mensagens automaticamente na frequência definida.',
      parameters: {
        type: 'object',
        properties: {
          titulo: { type: 'string', description: 'Nome da campanha' },
          mensagem: { type: 'string', description: 'Texto da mensagem (suporta {nome})' },
          frequencia: { type: 'string', enum: ['cada_30min', 'cada_1h', 'cada_2h', 'cada_4h', 'cada_6h', 'cada_12h', 'todo_dia', 'cada_2dias', 'cada_3dias', 'semanal'], description: 'Frequência de envio' },
          horario: { type: 'string', description: 'Horário preferido para frequências diárias+ (formato HH:MM, ex: 09:00)' },
          regra: { type: 'string', enum: ['ativos_x_dias', 'inativos_x_dias', 'nao_pagantes', 'trial', 'expirados', 'graca'], description: 'Regra de segmentação' },
          regra_valor: { type: 'integer', description: 'Valor da regra em dias' },
        },
        required: ['titulo', 'mensagem', 'frequencia', 'regra'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ativar_assinatura',
      description: 'Ativar manualmente a assinatura de um usuário por 30 dias.',
      parameters: {
        type: 'object',
        properties: {
          usuario_id: { type: 'string', description: 'ID do usuário (ex: 5511999998888@c.us)' },
        },
        required: ['usuario_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_campanhas_ativas',
      description: 'Listar todas as campanhas agendadas (crons) ativas no sistema.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Executor de tools ───────────────────────────────────────────────────────

async function executeTool(toolName, args) {
  switch (toolName) {

    case 'obter_metricas_usuarios': {
      const dias = args.periodo_dias || 7;
      const [total, novos, churned, ativos, inativos] = await Promise.all([
        db.contarUsuariosTotal(),
        db.contarUsuariosNovos(dias),
        db.contarUsuariosChurned(),
        db.listarUsuariosAtivos(dias),
        db.listarUsuariosInativos(dias),
      ]);
      return { ok: true, msg: 'Métricas de usuários obtidas', data: { total, novos, churned, ativos: ativos.length, inativos: inativos.length, periodo_dias: dias } };
    }

    case 'obter_metricas_engajamento': {
      const dias = args.periodo_dias || 30;
      const [engajamento, topUsuarios] = await Promise.all([
        db.metricsEngajamentoUsuarios(dias),
        db.metricsUsuariosTopEngajamento(dias, 5),
      ]);
      return { ok: true, msg: 'Métricas de engajamento obtidas', data: { ...engajamento, top_usuarios: topUsuarios, periodo_dias: dias } };
    }

    case 'obter_metricas_receita': {
      const [assinaturas, funil] = await Promise.all([
        db.metricsAssinaturasPorStatus(),
        db.metricsFunilConversao(),
      ]);
      const statusMap = {};
      for (const s of assinaturas) statusMap[s.status] = s.total;
      const pagantes = statusMap.ativo || 0;
      return { ok: true, msg: 'Métricas de receita obtidas', data: { assinaturas: statusMap, pagantes, mrr_estimado: pagantes * 39, funil } };
    }

    case 'obter_metricas_churn': {
      const [churned, reativacao, risco] = await Promise.all([
        db.contarUsuariosChurned(),
        db.metricsReativacao(),
        db.metricsUsuariosRisco(),
      ]);
      const total = await db.contarUsuariosTotal();
      const taxaChurn = total > 0 ? ((churned / total) * 100).toFixed(1) : 0;
      return { ok: true, msg: 'Métricas de churn obtidas', data: { churned, total_usuarios: total, taxa_churn_percent: taxaChurn, etapas_reativacao: reativacao, usuarios_risco: risco.length } };
    }

    case 'obter_metricas_transacoes': {
      const dias = args.periodo_dias || 30;
      const [transacoes, categorias] = await Promise.all([
        db.metricsTransacoesAgregadas(dias),
        db.metricsCategoriasTop(dias, 10),
      ]);
      return { ok: true, msg: 'Métricas de transações obtidas', data: { ...transacoes, categorias_top: categorias, periodo_dias: dias } };
    }

    case 'obter_crescimento_periodo': {
      const dias = args.tipo_comparacao === 'semanal' ? 7 : 30;
      const [atual, anterior, novosAtual, novosAnterior] = await Promise.all([
        db.metricsTransacoesAgregadas(dias),
        metricsTransacoesAnterior(dias),
        db.contarUsuariosNovos(dias),
        contarUsuariosNovosAnterior(dias),
      ]);

      function delta(a, b) { return b > 0 ? (((a - b) / b) * 100).toFixed(1) : (a > 0 ? '+100' : '0'); }

      return {
        ok: true,
        msg: `Comparação ${args.tipo_comparacao}`,
        data: {
          periodo: args.tipo_comparacao,
          atual: { transacoes: atual.total_transacoes, despesas: atual.total_despesas, receitas: atual.total_receitas, novos_usuarios: novosAtual },
          anterior: { transacoes: anterior.total_transacoes, despesas: anterior.total_despesas, receitas: anterior.total_receitas, novos_usuarios: novosAnterior },
          variacao: {
            transacoes: `${delta(atual.total_transacoes, anterior.total_transacoes)}%`,
            despesas: `${delta(atual.total_despesas, anterior.total_despesas)}%`,
            receitas: `${delta(atual.total_receitas, anterior.total_receitas)}%`,
            novos_usuarios: `${delta(novosAtual, novosAnterior)}%`,
          },
        },
      };
    }

    case 'listar_usuarios_risco': {
      const risco = await db.metricsUsuariosRisco();
      const limite = args.limite || 20;
      return { ok: true, msg: `${risco.length} usuário(s) em risco`, data: risco.slice(0, limite) };
    }

    case 'obter_metricas_campanhas': {
      const dias = args.periodo_dias || 7;
      const campanhas = await db.metricsLogsCampanhas(dias);
      return { ok: true, msg: `${campanhas.length} campanha(s) no período`, data: campanhas };
    }

    case 'obter_funil_usuarios': {
      const funil = await db.metricsFunilConversao();
      const taxas = {
        registro_para_trial: funil.total_registros > 0 ? ((funil.em_trial / funil.total_registros) * 100).toFixed(1) : 0,
        registro_para_pagante: funil.total_registros > 0 ? ((funil.pagantes / funil.total_registros) * 100).toFixed(1) : 0,
        trial_para_pagante: funil.em_trial > 0 ? ((funil.pagantes / funil.em_trial) * 100).toFixed(1) : 0,
      };
      return { ok: true, msg: 'Funil de conversão obtido', data: { ...funil, taxas } };
    }

    case 'obter_top_usuarios': {
      const dias = args.periodo_dias || 30;
      const limite = args.limite || 10;
      const top = await db.metricsUsuariosTopEngajamento(dias, limite);
      return { ok: true, msg: `Top ${top.length} usuários`, data: top };
    }

    // ── Tools de AÇÃO ─────────────────────────────────────────────────────

    case 'enviar_mensagem_usuario': {
      if (!_whatsappClient) return { ok: false, msg: 'WhatsApp client não disponível' };
      const usuario = await db.buscarUsuario(args.usuario_id);
      const primeiroNome = (usuario?.nome || '').split(' ')[0] || 'amigo(a)';
      const msgFinal = args.mensagem.replace(/\{nome\}/gi, primeiroNome);
      await _whatsappClient.sendMessage(args.usuario_id, msgFinal);
      return { ok: true, msg: `Mensagem enviada para ${primeiroNome} (${args.usuario_id})` };
    }

    case 'enviar_campanha': {
      if (!_whatsappClient) return { ok: false, msg: 'WhatsApp client não disponível' };
      const usuarios = await resolverDestinatarios(args.regra, args.regra_valor);
      if (usuarios.length === 0) return { ok: true, msg: 'Nenhum usuário encontrado com esse filtro' };

      const diasGratis = args.oferta_dias_gratis || 0;
      let enviados = 0;
      let erros = 0;
      for (let i = 0; i < usuarios.length; i++) {
        const u = usuarios[i];
        try {
          const primeiroNome = (u.nome || '').split(' ')[0] || 'amigo(a)';
          const msgFinal = args.mensagem.replace(/\{nome\}/gi, primeiroNome);
          await _whatsappClient.sendMessage(u.usuario_id, msgFinal);
          // Se a campanha inclui oferta de dias grátis, registrar para aceite automático
          if (diasGratis > 0) {
            registrarOferta(u.usuario_id, 'dias_gratis', diasGratis);
          }
          enviados++;
        } catch (err) {
          erros++;
          console.error(`[SEO-CAMPANHA] Erro envio para ${u.usuario_id}:`, err.message);
        }
        if (i < usuarios.length - 1) {
          const delay = Math.floor(5000 + Math.random() * 10000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      return { ok: true, msg: `Campanha finalizada: ${enviados} enviados, ${erros} erros (de ${usuarios.length} destinatários)${diasGratis > 0 ? `. Oferta de ${diasGratis} dias grátis registrada — usuários podem responder "sim" para ativar.` : ''}` };
    }

    case 'criar_campanha_agendada': {
      const cron = await db.criarAdminCron(
        args.titulo, args.mensagem, args.frequencia,
        args.horario || null, args.regra, args.regra_valor || null, null
      );
      return { ok: true, msg: `Campanha "${args.titulo}" criada (ID: ${cron.id}). Frequência: ${args.frequencia}, regra: ${args.regra}` };
    }

    case 'ativar_assinatura': {
      await db.ativarAssinatura(args.usuario_id);
      const assinatura = await db.buscarAssinatura(args.usuario_id);
      if (_whatsappClient) {
        const pagoAte = assinatura?.pago_ate ? new Date(assinatura.pago_ate).toLocaleDateString('pt-BR') : '30 dias';
        await _whatsappClient.sendMessage(args.usuario_id, `✅ *Assinatura ativada!*\n\nSua assinatura do *Cronos* está ativa até *${pagoAte}*. 🚀`);
      }
      return { ok: true, msg: `Assinatura ativada para ${args.usuario_id}` };
    }

    case 'listar_campanhas_ativas': {
      const crons = await db.listarAdminCrons();
      const ativas = crons.filter(c => c.ativo);
      return { ok: true, msg: `${ativas.length} campanha(s) ativa(s)`, data: ativas.map(c => ({ id: c.id, titulo: c.titulo, frequencia: c.frequencia, regra: c.regra, ultimo_envio: c.ultimo_envio })) };
    }

    default:
      return { ok: false, msg: `Tool desconhecida: ${toolName}` };
  }
}

// Helper: resolver destinatários por regra (mesmo padrão do cron-admin.js)
async function resolverDestinatarios(regra, valor) {
  switch (regra) {
    case 'ativos_x_dias':    return db.listarUsuariosAtivos(valor || 7);
    case 'inativos_x_dias':  return db.listarUsuariosInativos(valor || 7);
    case 'nao_pagantes':     return db.listarUsuariosNaoPagantes('todos');
    case 'trial':            return db.listarUsuariosNaoPagantes('trial');
    case 'expirados':        return db.listarUsuariosNaoPagantes('expirado');
    case 'graca':            return db.listarUsuariosNaoPagantes('graca');
    default:                 return [];
  }
}

// Helpers para comparação de períodos (período anterior ao atual)
async function metricsTransacoesAnterior(dias) {
  const r = await db.pool.query(
    `SELECT
       COUNT(*)::int as total_transacoes,
       COALESCE(SUM(CASE WHEN tipo='despesa' THEN valor ELSE 0 END), 0)::float as total_despesas,
       COALESCE(SUM(CASE WHEN tipo='receita' THEN valor ELSE 0 END), 0)::float as total_receitas,
       COALESCE(AVG(valor), 0)::float as valor_medio
     FROM transacoes
     WHERE criado_em >= NOW() - MAKE_INTERVAL(days => $1) * 2
       AND criado_em < NOW() - MAKE_INTERVAL(days => $1)`,
    [dias]
  );
  return r.rows[0];
}

async function contarUsuariosNovosAnterior(dias) {
  const r = await db.pool.query(
    `SELECT COUNT(*)::int as total FROM usuarios
     WHERE primeiro_contato >= NOW() - MAKE_INTERVAL(days => $1) * 2
       AND primeiro_contato < NOW() - MAKE_INTERVAL(days => $1)
       AND usuario_id NOT LIKE '%@lid'`,
    [dias]
  );
  return r.rows[0]?.total || 0;
}

// ── Processamento principal ─────────────────────────────────────────────────

const MAX_TOOL_CALLS_PER_TURN = 8;
const MAX_HISTORY = 30;

async function processarMensagemCrescimento(adminId, texto, chatFn) {
  // Verificar comando de saída
  if (/^(sair|voltar|exit|cancelar)$/i.test(texto.trim())) {
    limparEstadoCrescimento(adminId);
    return { texto: '👋 Sessão de crescimento encerrada. Manda "crescimento" quando quiser voltar!' };
  }

  let estado = obterEstadoCrescimento(adminId);
  const isNovoSessao = !estado;

  // Inicializar ou atualizar contexto
  if (!estado || (Date.now() - (estado.contextBuiltAt || 0)) > CONTEXT_REFRESH_MS) {
    const ctx = await buildMetricsContext();
    const history = estado ? estado.conversationHistory : [];
    estado = {
      conversationHistory: history,
      metricsSnapshot: ctx,
      contextBuiltAt: Date.now(),
    };
  }

  // Se é trigger de ativação, substituir por instrução clara para a IA
  let mensagemUsuario = texto;
  if (isNovoSessao && /^\/?(seo|ceo|crescimento|briefing|metricas|métricas)$/i.test(texto.trim())) {
    mensagemUsuario = 'Me dê um panorama geral de como está o Cronos agora. Analise as métricas, identifique pontos de atenção e sugira 3 ações concretas prioritárias.';
  }

  // Montar mensagens
  const systemMsg = { role: 'system', content: buildSystemPrompt(estado.metricsSnapshot.text) };
  estado.conversationHistory.push({ role: 'user', content: mensagemUsuario });

  // Podar histórico
  while (estado.conversationHistory.length > MAX_HISTORY) {
    estado.conversationHistory.shift();
  }

  const messages = [systemMsg, ...estado.conversationHistory];

  // Loop de function calling
  let iteracoes = 0;

  while (iteracoes < MAX_TOOL_CALLS_PER_TURN) {
    iteracoes++;
    const aiResponse = await chatFn(messages, TOOLS);

    if (!aiResponse) {
      salvarEstado(adminId, estado);
      return { texto: 'Desculpa, tive um problema ao analisar. Tenta de novo?' };
    }

    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      messages.push(aiResponse);

      for (const tc of aiResponse.tool_calls) {
        const toolName = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        try {
          const result = await executeTool(toolName, args);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, msg: `Erro: ${err.message}` }),
          });
        }
      }
      continue;
    }

    // Resposta final
    const respostaTexto = aiResponse.content || '';
    estado.conversationHistory.push({ role: 'assistant', content: respostaTexto });

    while (estado.conversationHistory.length > MAX_HISTORY) {
      estado.conversationHistory.shift();
    }

    salvarEstado(adminId, estado);
    return { texto: respostaTexto };
  }

  salvarEstado(adminId, estado);
  return { texto: 'Análise concluída!' };
}

// ── Briefing diário ─────────────────────────────────────────────────────────

let _whatsappClient = null;

async function executarBriefingDiario() {
  if (!_whatsappClient) {
    console.error('[CRESCIMENTO] Client WhatsApp não disponível para briefing');
    return;
  }

  const admins = adminIds();
  if (admins.length === 0) {
    console.log('[CRESCIMENTO] Nenhum admin configurado, pulando briefing');
    return;
  }

  console.log('[CRESCIMENTO] Gerando briefing diário...');

  try {
    const ctx = await buildMetricsContext();

    // Montar prompt específico para briefing
    const dataHoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const briefingPrompt = [
      {
        role: 'system',
        content: `Você é o CEO Virtual do Cronos. Gere um briefing diário conciso e acionável baseado nas métricas abaixo.

FORMATO OBRIGATÓRIO (WhatsApp):
*BRIEFING DIÁRIO — CRONOS* 📊
_${dataHoje}_

*USUÁRIOS*
[dados de usuários: total, novos, ativos, risco]

*ENGAJAMENTO*
[transações, média por usuário, top categorias]

*RECEITA*
[pagantes, trial, MRR estimado]

*TENDÊNCIA*
[comparação com período anterior se houver dados suficientes]

*AÇÕES SUGERIDAS*
[3 ações CONCRETAS e ESPECÍFICAS baseadas nos dados — não genéricas]

_Responda "crescimento" para conversar comigo sobre estratégia_

REGRAS:
- Máximo 25 linhas
- Ações devem ser específicas com números (ex: "enviar mensagem para os 2 usuários inativos há 5 dias")
- Se base é pequena (<20 users), mencionar brevemente
- Emojis estratégicos, não decorativos`,
      },
      {
        role: 'user',
        content: `Gere o briefing diário com base nestas métricas:\n\n${ctx.text}`,
      },
    ];

    // Chamar IA sem tools (briefing é puramente texto)
    const { chatAgente } = require('./ai');
    const aiResponse = await chatAgente(briefingPrompt, []);

    if (!aiResponse || !aiResponse.content) {
      console.error('[CRESCIMENTO] IA não retornou briefing');
      return;
    }

    const briefing = aiResponse.content;

    // Enviar para cada admin
    for (const adminId of admins) {
      try {
        await _whatsappClient.sendMessage(adminId, briefing);
        console.log(`[CRESCIMENTO] Briefing enviado para ${adminId}`);
      } catch (err) {
        console.error(`[CRESCIMENTO] Erro ao enviar briefing para ${adminId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[CRESCIMENTO] Erro ao gerar briefing:', err.message);
  }
}

// ── Inicialização ───────────────────────────────────────────────────────────

function iniciarAgenteCrescimento(client) {
  _whatsappClient = client;

  // Briefing diário às 08:00 BRT
  cron.schedule('0 8 * * *', () => {
    executarBriefingDiario().catch(err =>
      console.error('[CRESCIMENTO] Erro no cron do briefing:', err.message)
    );
  }, { timezone: 'America/Sao_Paulo' });

  console.log('🧠 Agente de Crescimento iniciado (briefing diário 08:00 BRT)');
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  iniciarAgenteCrescimento,
  processarMensagemCrescimento,
  obterEstadoCrescimento,
  limparEstadoCrescimento,
  estadosCrescimento,
  ofertasPendentes,
  obterOferta,
  limparOferta,
};
