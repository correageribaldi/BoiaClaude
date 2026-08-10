// ── Agente Financeiro Inteligente ─────────────────────────────────────────────
// Módulo principal do agente conversacional que substitui o interpretarMensagem
// como camada de interação via OpenAI function calling.
// Todas as ações delegam para funções existentes em database.js, charts.js, etc.

const db = require('./database');
const charts = require('./charts');
const fmt = require('./formatters');
const limites = require('./limites');
const search = require('./search');

// Importação lazy para evitar dependência circular (handlers.js importa agente-financeiro.js)
function getHandlers() {
  return require('./handlers');
}

// Helper: formatarMoeda seguro (trata null/undefined)
function moeda(v) { return fmt.formatarMoeda(Number(v) || 0); }

// ── Estado por usuário ───────────────────────────────────────────────────────

const agenteEstados = new Map();
const TTL = 30 * 60 * 1000; // 30 minutos
const CONTEXT_REFRESH_MS = 5 * 60 * 1000; // 5 minutos

function salvarEstado(usuarioId, dados) {
  agenteEstados.set(usuarioId, { ...dados, expiraEm: Date.now() + TTL });
}

function obterEstado(usuarioId) {
  const e = agenteEstados.get(usuarioId);
  if (!e) return null;
  if (Date.now() > e.expiraEm) { agenteEstados.delete(usuarioId); return null; }
  return e;
}

function limparEstado(usuarioId) { agenteEstados.delete(usuarioId); }

// ── Contexto financeiro ──────────────────────────────────────────────────────

async function buildFinancialContext(usuarioId) {
  // limitadores (e não "limites") para não sombrear o módulo ./limites
  const [saldos, resumo, limitadores, recorrencias, cartoes, caixinhas, usuario, categoriasDespesa, categoriasReceita] =
    await Promise.all([
      db.calcularSaldos(usuarioId),
      db.resumoMensal(usuarioId),
      db.listarLimitadores(usuarioId),
      db.listarRecorrencias(usuarioId),
      db.listarCartoes(usuarioId),
      db.listarCaixinhas(usuarioId),
      db.buscarUsuario(usuarioId),
      db.listarCategoriasParaIA(usuarioId, 'despesa'),
      db.listarCategoriasParaIA(usuarioId, 'receita'),
    ]);

  const lines = [];
  const nome = usuario?.nome || 'Usuário';
  lines.push(`Nome do usuário: ${nome}`);
  lines.push(`Saldo atual: ${moeda(saldos.saldoAtual)}`);
  lines.push(`Receitas mês: ${moeda(saldos.receitas)} (pendentes: ${moeda(saldos.receitasPendentes)})`);
  lines.push(`Despesas mês: ${moeda(saldos.despesas)} (pendentes: ${moeda(saldos.despesasPendentes)})`);

  if (cartoes.length > 0) {
    const cartoesInfo = [];
    for (const c of cartoes) {
      const uso = await db.obterUsoCartao(c);
      cartoesInfo.push(`${c.nome} (limite ${moeda(c.limite_total)}, usado ${moeda(uso.valorUsado)}, disponível ${uso.disponivel !== null ? moeda(uso.disponivel) : 'desconhecido'})`);
    }
    lines.push(`Cartões: ${cartoesInfo.join(' | ')}`);
  }

  if (caixinhas.length > 0) {
    const cxInfo = caixinhas.map(cx =>
      `${cx.nome} ${moeda(cx.saldo)}${cx.meta ? '/' + moeda(cx.meta) : ''}`
    );
    lines.push(`Caixinhas: ${cxInfo.join(' | ')}`);
  }

  // As categorias de cada limitador vão junto: sem elas a IA não sabe se
  // "gastei no Angeloni" cai dentro de algum teto já existente.
  if (limitadores.length > 0) {
    const desc = limitadores.slice(0, 10).map((l) => {
      const tetos = [
        l.valor_semanal > 0 ? `${moeda(l.valor_semanal)}/sem` : null,
        l.valor_mensal > 0 ? `${moeda(l.valor_mensal)}/mês` : null,
      ].filter(Boolean).join(' + ') || 'sem teto';
      return `${l.nome} [${tetos}] = ${l.categorias.join(' + ')}`;
    });
    lines.push(`Limitadores: ${desc.join(' | ')}`);
  }

  if (recorrencias.length > 0) {
    const recInfo = recorrencias.slice(0, 8).map(r =>
      `${r.descricao} ${moeda(r.valor)} (${r.tipo}, dia ${r.dia_mes || r.dia_semana || '-'})`
    );
    lines.push(`Recorrências: ${recInfo.join(' | ')}`);
  }

  lines.push(`Categorias de despesa disponíveis: ${categoriasDespesa}`);
  lines.push(`Categorias de receita disponíveis: ${categoriasReceita}`);

  return { text: lines.join('\n'), nome, categoriasDespesa, categoriasReceita };
}

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(contextText) {
  const agora = new Date();
  const diaSemana = agora.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'America/Sao_Paulo' });
  const data = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const horaAtual = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  const dataHoje = `${diaSemana}, ${data}`;

  return `Você é o Cronos, assistente financeiro pessoal e assessor do dia a dia do usuário.
Você conversa via WhatsApp, conhece todas as finanças do usuário e pode executar ações.

PERSONALIDADE:
- Amigável, direto, em português brasileiro informal
- Proativo: identifica oportunidades e problemas sem ser perguntado
- Educador: ensina o usuário a usar as funcionalidades quando percebe que ele não conhece
- Respostas curtas e objetivas (é WhatsApp, não email)
- Use emojis com moderação

Data e hora atual: ${dataHoje}, ${horaAtual} (horário de Brasília)

CONTEXTO FINANCEIRO ATUAL:
${contextText}

REGRAS IMPORTANTES:
1. Para registrar despesas/receitas, chame a tool registrar_transacao IMEDIATAMENTE sem dizer nada antes. NÃO escreva "vou registrar" ou "um momento" — apenas chame a tool direto. Sua resposta de texto deve vir DEPOIS que a tool retornar o resultado, confirmando o registro.
2. Para ações mais impactantes (criar/remover limites, recorrências, excluir transações), DESCREVA o que vai fazer e peça confirmação antes de executar. Aguarde o usuário responder "sim" antes de chamar a tool.
3. Quando gerar gráficos, envie junto com uma breve análise.
4. Se o usuário mandar algo que não tem a ver com finanças, responda normalmente e tente conectar com funcionalidades do Cronos quando fizer sentido.
5. Se perceber que o usuário nunca usou uma funcionalidade relevante, sugira naturalmente.
6. Respostas máx 15 linhas — é WhatsApp, não email.
7. Valores monetários SEMPRE em formato brasileiro: R$ 1.234,56
8. Quando o campo "categoria" for necessário, use SEMPRE uma subcategoria existente da lista de categorias disponíveis. Se nenhuma se encaixa, crie uma nova descritiva (ex: "iFood", "Uber"). REGRA IMPORTANTE: se tipo=despesa, a categoria DEVE vir da lista de categorias de despesa. Se tipo=receita, a categoria DEVE vir da lista de categorias de receita. Nunca aplique categoria de um tipo ao outro (ex: nunca use "Alimentação" para uma receita, nem "Salário" para uma despesa).
9. Para datas relativas: "hoje" = data de hoje, "ontem" = dia anterior, "amanhã" = dia seguinte. Converta para YYYY-MM-DD.
10. Se o usuário disser "resetar", "começar do zero" ou "limpar tudo", NÃO execute — responda que ele precisa digitar o comando diretamente.
11. Quando a tool retornar resultado, apresente de forma amigável e formatada para WhatsApp (negrito com *, itálico com _).
12. Para criar conta (corrente, poupança, carteira, investimento), listar contas ou ver saldo de uma conta específica, chame as tools criar_conta, listar_contas ou saldo_conta IMEDIATAMENTE — não pedem confirmação. Se o usuário disser algo como "quero criar uma conta" sem informar o nome, chame criar_conta mesmo assim sem o parâmetro nome; a tool já devolve a pergunta pedindo o nome. A resposta da tool já vem pronta e formatada — repasse o texto dela ao usuário como sua resposta final, sem reescrever o conteúdo.
13. Para mover dinheiro entre contas do próprio usuário (ex: "transferir 100 da conta corrente pra poupança", "mover 50 reais pra carteira", "passar 200 do Nubank pra poupança"), chame a tool transferir IMEDIATAMENTE — não pede confirmação. Se faltar valor, conta de origem ou conta de destino, chame mesmo assim com o que tiver informado; a tool já pergunta o que falta. Transferência NÃO é despesa nem receita — nunca use registrar_transacao para isso. Saldo negativo na conta de origem após a transferência é permitido, não bloqueie nem avise sobre isso.
14. REGRA CRÍTICA — nunca invente ou calcule um total somando itens de lista: para perguntas de TOTAL/QUANTO GASTEI/QUANTO RECEBI/RESUMO de um período (mês, ano, semana), chame SEMPRE resumo_mensal ou resumo_anual — essas tools já retornam os valores agregados corretos do banco. A tool consultar_transacoes serve APENAS para listar lançamentos específicos (ex: "quais foram minhas compras no mercado", "me mostra os gastos com Uber"); ela pode retornar só uma PÁGINA dos resultados (campo "truncado": true quando há mais registros do que os exibidos em "data"). NUNCA some manualmente os valores do array "data" de consultar_transacoes para apresentar um total ao usuário — se precisar do total do período consultado, use o campo "totalGeral" que a própria tool retorna (soma de TODOS os registros do período, não só os exibidos), ou prefira resumo_mensal/resumo_anual. Apresentar um subtotal de página como se fosse o total do período é um erro grave neste app financeiro.`;
}

// ── Tool definitions (OpenAI function calling) ───────────────────────────────

const TOOLS = [
  // ── Transações ──
  {
    type: 'function', function: {
      name: 'registrar_transacao',
      description: 'Registrar uma despesa ou receita',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['despesa', 'receita'], description: 'Tipo da transação' },
          valor: { type: 'number', description: 'Valor da transação (total, positivo)' },
          descricao: { type: 'string', description: 'Descrição do lançamento' },
          categoria: { type: 'string', description: 'Subcategoria (da lista de categorias disponíveis)' },
          data: { type: 'string', description: 'Data no formato YYYY-MM-DD ou null para hoje', nullable: true },
          status: { type: 'string', enum: ['pago', 'pendente'], description: 'Se já foi pago ou é pendente' },
          cartao_nome: { type: 'string', description: 'Nome do cartão de crédito se aplicável', nullable: true },
          conta_nome: { type: 'string', description: 'Nome da conta (corrente, poupança, carteira) SOMENTE se o usuário mencionar explicitamente. Não inventar/assumir.', nullable: true },
          parcelas: { type: 'integer', description: 'Número de parcelas (1 se à vista)', default: 1 },
        },
        required: ['tipo', 'valor', 'descricao', 'categoria', 'status'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'consultar_transacoes',
      description: 'Buscar transações com filtros (tipo, período, categoria, descrição)',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['despesa', 'receita'], nullable: true },
          dataInicio: { type: 'string', description: 'Data início YYYY-MM-DD', nullable: true },
          dataFim: { type: 'string', description: 'Data fim YYYY-MM-DD', nullable: true },
          descricao: { type: 'string', description: 'Buscar por descrição', nullable: true },
          limite: { type: 'integer', description: 'Máximo de resultados', default: 20 },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'editar_transacao',
      description: 'Modificar uma transação existente (valor, data, descrição ou categoria)',
      parameters: {
        type: 'object',
        properties: {
          numero_usuario: { type: 'integer', description: 'ID da transação (#número)' },
          campo: { type: 'string', enum: ['valor', 'data', 'descricao', 'categoria'] },
          novo_valor: { type: 'string', description: 'Novo valor para o campo' },
        },
        required: ['numero_usuario', 'campo', 'novo_valor'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'excluir_transacao',
      description: 'Excluir uma transação pelo ID',
      parameters: {
        type: 'object',
        properties: {
          numero_usuario: { type: 'integer', description: 'ID da transação (#número)' },
        },
        required: ['numero_usuario'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'liquidar_transacao',
      description: 'Marcar transação pendente como paga/recebida',
      parameters: {
        type: 'object',
        properties: {
          numero_usuario: { type: 'integer', description: 'ID da transação (#número)' },
        },
        required: ['numero_usuario'],
      },
    },
  },
  // ── Resumos e Saldos ──
  {
    type: 'function', function: {
      name: 'resumo_mensal',
      description: 'Obter resumo financeiro de um mês (receitas, despesas, por categoria)',
      parameters: {
        type: 'object',
        properties: {
          mes: { type: 'integer', description: 'Mês (1-12), omitir para mês atual', nullable: true },
          ano: { type: 'integer', description: 'Ano, omitir para ano atual', nullable: true },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'resumo_anual',
      description: 'Obter resumo financeiro anual (todos os meses)',
      parameters: {
        type: 'object',
        properties: {
          ano: { type: 'integer', description: 'Ano, omitir para ano atual', nullable: true },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'calcular_saldos',
      description: 'Calcular saldo atual, receitas e despesas pagas e pendentes',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_pendentes',
      description: 'Listar transações pendentes (a pagar ou a receber)',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['despesa', 'receita'], description: 'Filtrar por tipo', nullable: true },
        },
      },
    },
  },
  // ── Limitadores de gasto ──
  //
  // Um limitador é um grupo NOMEADO de subcategorias com teto semanal e/ou
  // mensal ("Mercado" = Supermercado + Compras). O nome é do usuário, não da
  // taxonomia — é o que torna o controle usável com 41 subcategorias.
  {
    type: 'function', function: {
      name: 'definir_limite',
      description: 'Criar ou atualizar um limitador de gastos (grupo nomeado de subcategorias com teto). Aceita teto mensal, semanal ou os dois — são controles independentes. Ex: "no mercado quero gastar no máximo 500 por semana" → nome="Mercado", periodo="semana", valor_limite=500. Se o limitador ainda não existe e você NÃO souber quais subcategorias agrupar, deixe "categorias" vazio: o sistema pergunta ao usuário.',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', description: 'Nome do limitador (ex: Mercado, Combustível, Lazer)' },
          valor_limite: { type: 'number', description: 'Valor do teto' },
          periodo: {
            type: 'string',
            enum: ['mes', 'semana'],
            description: 'Janela do teto. Padrão "mes" quando o usuário não disser.',
          },
          categorias: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subcategorias que entram no grupo, quando o usuário disser quais. Omita se não souber.',
          },
        },
        required: ['categoria', 'valor_limite'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_limites',
      description: 'Listar os limitadores de gasto e quanto já foi consumido de cada teto',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'remover_limite',
      description: 'Remover um limitador de gastos pelo nome',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', description: 'Nome do limitador' },
        },
        required: ['categoria'],
      },
    },
  },
  // ── Recorrências ──
  {
    type: 'function', function: {
      name: 'criar_recorrencia',
      description: 'Criar transação recorrente (conta fixa mensal/semanal)',
      parameters: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['despesa', 'receita'] },
          valor: { type: 'number' },
          descricao: { type: 'string' },
          categoria: { type: 'string' },
          frequencia: { type: 'string', enum: ['mensal', 'semanal'] },
          dia_mes: { type: 'integer', description: 'Dia do mês (1-31) para mensal', nullable: true },
          dia_semana: { type: 'integer', description: 'Dia da semana (0=dom, 6=sab) para semanal', nullable: true },
        },
        required: ['tipo', 'valor', 'descricao', 'categoria', 'frequencia'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_recorrencias',
      description: 'Listar transações recorrentes ativas',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'desativar_recorrencia',
      description: 'Desativar uma transação recorrente',
      parameters: {
        type: 'object',
        properties: {
          recorrencia_id: { type: 'integer', description: 'ID da recorrência' },
        },
        required: ['recorrencia_id'],
      },
    },
  },
  // ── Lembretes ──
  {
    type: 'function', function: {
      name: 'criar_lembrete',
      description: 'Criar lembrete único (dispara uma vez)',
      parameters: {
        type: 'object',
        properties: {
          mensagem: { type: 'string', description: 'Texto do lembrete' },
          dispara_em: { type: 'string', description: 'Data e hora ISO 8601 (ex: 2026-04-01T10:00:00)' },
        },
        required: ['mensagem', 'dispara_em'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'criar_lembrete_recorrente',
      description: 'Criar lembrete recorrente (diário, semanal ou mensal)',
      parameters: {
        type: 'object',
        properties: {
          mensagem: { type: 'string' },
          horario: { type: 'string', description: 'Horário HH:MM' },
          frequencia: { type: 'string', enum: ['diario', 'semanal', 'mensal'] },
          dia_semana: { type: 'integer', description: '0-6 para semanal', nullable: true },
          dia_mes: { type: 'integer', description: '1-31 para mensal', nullable: true },
        },
        required: ['mensagem', 'horario', 'frequencia'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_lembretes',
      description: 'Listar lembretes (únicos e recorrentes)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'cancelar_lembrete',
      description: 'Cancelar um lembrete pelo ID',
      parameters: {
        type: 'object',
        properties: {
          lembrete_id: { type: 'integer' },
          tipo: { type: 'string', enum: ['unico', 'recorrente'], description: 'Tipo do lembrete' },
        },
        required: ['lembrete_id', 'tipo'],
      },
    },
  },
  // ── Cartões ──
  {
    type: 'function', function: {
      name: 'criar_cartao',
      description: 'Registrar novo cartão de crédito',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do cartão (ex: Nubank)' },
          limite_total: { type: 'number' },
          dia_fechamento: { type: 'integer', description: 'Dia de fechamento da fatura' },
          dia_vencimento: { type: 'integer', description: 'Dia de vencimento' },
        },
        required: ['nome', 'limite_total', 'dia_fechamento', 'dia_vencimento'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_cartoes',
      description: 'Listar cartões de crédito com limite e uso',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'uso_cartao',
      description: 'Ver uso detalhado de um cartão no ciclo atual',
      parameters: {
        type: 'object',
        properties: {
          cartao_id: { type: 'integer' },
          dia_fechamento: { type: 'integer' },
        },
        required: ['cartao_id', 'dia_fechamento'],
      },
    },
  },
  // ── Caixinhas ──
  {
    type: 'function', function: {
      name: 'criar_caixinha',
      description: 'Criar caixinha/meta de economia',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          saldo: { type: 'number', description: 'Saldo inicial', default: 0 },
          meta: { type: 'number', description: 'Valor da meta', nullable: true },
          tipo: { type: 'string', description: 'Tipo (ex: economia, investimento)', default: 'economia' },
          rendimento_mensal: { type: 'number', description: 'Rendimento % mensal', nullable: true },
        },
        required: ['nome'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_caixinhas',
      description: 'Listar caixinhas/investimentos',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'depositar_caixinha',
      description: 'Depositar valor em uma caixinha',
      parameters: {
        type: 'object',
        properties: {
          caixinha_id: { type: 'integer' },
          valor: { type: 'number' },
        },
        required: ['caixinha_id', 'valor'],
      },
    },
  },
  // ── Contas ──
  {
    type: 'function', function: {
      name: 'criar_conta',
      description: 'Criar uma nova conta (corrente, poupança, carteira, investimento). Se o usuário não disser o nome da conta, chame mesmo assim sem o parâmetro nome — o sistema vai perguntar o nome.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome da conta (ex: Poupança, Carteira, Nubank)', nullable: true },
          tipo: { type: 'string', enum: ['corrente', 'poupanca', 'carteira', 'investimento', 'outro'], description: 'Tipo da conta', nullable: true },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'listar_contas',
      description: 'Listar todas as contas cadastradas do usuário com saldo de cada uma',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'saldo_conta',
      description: 'Consultar saldo de uma conta específica pelo nome, ou de todas as contas se o nome não for informado',
      parameters: {
        type: 'object',
        properties: {
          conta_nome: { type: 'string', description: 'Nome (ou parte do nome) da conta', nullable: true },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'transferir',
      description: 'Transferir um valor de uma conta para outra (ex: "transferir 100 da conta corrente pra poupança", "mover 50 reais pra carteira"). Se faltar valor, conta de origem ou conta de destino, chame mesmo assim com o que tiver — o sistema pergunta o que falta.',
      parameters: {
        type: 'object',
        properties: {
          valor: { type: 'number', description: 'Valor a transferir', nullable: true },
          conta_origem: { type: 'string', description: 'Nome (ou parte do nome) da conta de origem', nullable: true },
          conta_destino: { type: 'string', description: 'Nome (ou parte do nome) da conta de destino', nullable: true },
          descricao: { type: 'string', description: 'Descrição opcional da transferência', nullable: true },
        },
      },
    },
  },
  // ── Gráficos ──
  {
    type: 'function', function: {
      name: 'gerar_grafico_categorias',
      description: 'Gerar gráfico de pizza com despesas por categoria do mês',
      parameters: {
        type: 'object',
        properties: {
          mes: { type: 'integer', nullable: true },
          ano: { type: 'integer', nullable: true },
        },
      },
    },
  },
  {
    type: 'function', function: {
      name: 'gerar_grafico_receitas_despesas',
      description: 'Gerar gráfico de barras receitas vs despesas do mês',
      parameters: {
        type: 'object',
        properties: {
          mes: { type: 'integer', nullable: true },
          ano: { type: 'integer', nullable: true },
        },
      },
    },
  },
  // ── Pesquisa ──
  {
    type: 'function', function: {
      name: 'pesquisa_web',
      description: 'Pesquisar na internet (dúvidas, comparações, informações)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Termo de pesquisa' },
        },
        required: ['query'],
      },
    },
  },
];

// Tools que requerem confirmação do usuário antes de executar
// NOTA: registrar_transacao e liquidar_transacao NÃO estão aqui — executam direto
const TOOLS_COM_CONFIRMACAO = new Set([
  'definir_limite', 'remover_limite',
  'criar_recorrencia', 'desativar_recorrencia',
  'excluir_transacao', 'editar_transacao',
  'criar_cartao',
  'criar_caixinha', 'depositar_caixinha',
  'criar_lembrete', 'criar_lembrete_recorrente', 'cancelar_lembrete',
]);

// ── Validação determinística de categoria × tipo ─────────────────────────────
// Corrige silenciosamente quando a IA (ou o usuário) aplica categoria de um tipo
// errado (ex: categoria de despesa numa receita). Não bloqueia nem pergunta —
// substitui pela categoria genérica do tipo certo e retorna aviso pra concatenar
// na resposta final.
const CATEGORIA_GENERICA_POR_TIPO = {
  despesa: 'Outros',
  receita: 'Outras Receitas',
};

async function validarCategoriaPorTipo(usuarioId, categoria, tipo) {
  if (!categoria) return { categoriaFinal: categoria, aviso: '' };

  const tipoCadastrado = await db.buscarTipoCategoria(usuarioId, categoria);

  if (tipoCadastrado && tipoCadastrado !== tipo && tipoCadastrado !== 'ambos') {
    const categoriaGenerica = CATEGORIA_GENERICA_POR_TIPO[tipo] || categoria;
    const aviso = `_obs: categoria ajustada para "${categoriaGenerica}" — "${categoria}" é categoria de ${tipoCadastrado}._`;
    return { categoriaFinal: categoriaGenerica, aviso };
  }

  if (!tipoCadastrado) {
    // Categoria nova (ainda não cadastrada) — aceita como está e cadastra com o tipo correto
    const handlers = getHandlers();
    await handlers.garantirSubcategoriaVinculada(usuarioId, categoria, tipo);
  }

  return { categoriaFinal: categoria, aviso: '' };
}

// ── Executor de tools ────────────────────────────────────────────────────────

async function executeTool(usuarioId, toolName, args) {
  switch (toolName) {
    // Transações
    case 'registrar_transacao': {
      const { tipo, valor, descricao, data, status, cartao_nome, conta_nome, parcelas } = args;
      let cartaoId = null;
      if (cartao_nome) {
        const cartoes = await db.listarCartoes(usuarioId);
        const cartao = cartoes.find(c => c.nome.toLowerCase().includes(cartao_nome.toLowerCase()));
        if (cartao) cartaoId = cartao.id;
      }
      // Resolver conta_nome → contaId (reusa a mesma lógica de desambiguação do Marco 3).
      // Se não encontrar ou for ambíguo, NÃO bloqueia o registro — cai no fallback de conta padrão.
      let contaId = null;
      let avisoConta = '';
      if (conta_nome) {
        const handlers = getHandlers();
        const resolvida = await handlers.resolverContaPorNome(usuarioId, conta_nome);
        if (resolvida.conta) {
          contaId = resolvida.conta.id;
        } else {
          avisoConta = `\n_obs: não encontrei a conta "${conta_nome}", lancei na conta principal._`;
        }
      }

      // Validação determinística categoria × tipo — corrige silenciosamente categoria cruzada
      const { categoriaFinal: categoria, aviso: avisoCategoria } = await validarCategoriaPorTipo(usuarioId, args.categoria, tipo);
      const avisos = `${avisoConta}${avisoCategoria ? `\n${avisoCategoria}` : ''}`;

      // Consumo dos tetos da categoria (semana + mês) — mesma informação que o
      // fluxo determinístico anexa em salvarTransacao. Calculado DEPOIS do
      // insert, senão o gasto que acabou de entrar não apareceria na conta.
      // Vai na msg da tool para o modelo repassar ao usuário; só para despesa.
      const blocoLimite = async () => (
        tipo === 'despesa' ? await limites.blocoLimitesDaTransacao(usuarioId, categoria) : ''
      );

      if (parcelas && parcelas > 1) {
        await db.adicionarTransacoesParcelas(usuarioId, valor, descricao, categoria, data || null, cartaoId, parcelas);
        return { ok: true, msg: `${tipo === 'receita' ? '💰' : '💸'} ${descricao} registrada: ${moeda(valor)} em ${parcelas}x de ${moeda(valor / parcelas)}${avisos}${await blocoLimite()}` };
      }
      await db.adicionarTransacao(usuarioId, tipo, valor, descricao, categoria, data || null, status || 'pago', cartaoId, contaId);
      return { ok: true, msg: `${tipo === 'receita' ? '💰' : '💸'} ${descricao} registrada: ${moeda(valor)} (${status || 'pago'})${avisos}${await blocoLimite()}` };
    }
    case 'consultar_transacoes': {
      const limite = args.limite || 20;
      const filtrosBase = {
        tipo: args.tipo || null,
        dataInicio: args.dataInicio || null,
        dataFim: args.dataFim || null,
        descricao: args.descricao || null,
      };
      // Busca a página de resultados (limitada) e, em paralelo, o agregado
      // REAL do período inteiro (sem limite) — necessário para que a IA nunca
      // precise (e nunca tenha motivo para) somar manualmente os itens da
      // lista para responder "quanto gastei"/"total do período". Ver regra 14
      // do system prompt.
      const [txs, agregado] = await Promise.all([
        db.consultarTransacoes(usuarioId, { ...filtrosBase, limite }),
        db.consultarTotalTransacoes(usuarioId, filtrosBase),
      ]);
      if (txs.length === 0) {
        return { ok: true, data: [], totalGeral: 0, quantidadeTotal: 0, truncado: false, msg: 'Nenhuma transação encontrada.' };
      }
      const exibindo = txs.length;
      const totalDeRegistros = agregado.quantidade;
      const truncado = totalDeRegistros > exibindo;
      return {
        ok: true,
        data: txs.map(t => ({
          id: t.numero_usuario, tipo: t.tipo, valor: t.valor,
          descricao: t.descricao, categoria: t.categoria,
          data: t.data, status: t.status,
        })),
        totalGeral: agregado.total,
        quantidadeTotal: totalDeRegistros,
        exibindo,
        truncado,
        aviso: truncado
          ? `Lista truncada: exibindo ${exibindo} de ${totalDeRegistros} transações do período filtrado. NUNCA some os valores desta lista para responder "quanto gastei"/"total" — use o campo totalGeral (já é a soma de TODAS as ${totalDeRegistros} transações do período, não só as exibidas).`
          : `totalGeral já é a soma de todas as ${totalDeRegistros} transações retornadas — não some manualmente.`,
      };
    }
    case 'editar_transacao': {
      const result = await db.atualizarTransacao(usuarioId, args.numero_usuario, args.campo, args.novo_valor);
      if (!result) return { ok: false, msg: 'Transação não encontrada.' };
      return { ok: true, msg: `Transação #${args.numero_usuario} atualizada: ${args.campo} → ${args.novo_valor}` };
    }
    case 'excluir_transacao': {
      const result = await db.excluirTransacao(usuarioId, args.numero_usuario);
      if (result.changes === 0) return { ok: false, msg: 'Transação não encontrada.' };
      return { ok: true, msg: `Transação #${args.numero_usuario} excluída.` };
    }
    case 'liquidar_transacao': {
      const result = await db.liquidarTransacao(usuarioId, args.numero_usuario);
      if (!result) return { ok: false, msg: 'Transação não encontrada ou já paga.' };
      return { ok: true, msg: `Transação #${args.numero_usuario} marcada como paga.` };
    }

    // Resumos
    case 'resumo_mensal': {
      const resumo = await db.resumoMensal(usuarioId, args.mes, args.ano);
      return { ok: true, data: resumo };
    }
    case 'resumo_anual': {
      const resumo = await db.resumoAnual(usuarioId, args.ano);
      return { ok: true, data: resumo };
    }
    case 'calcular_saldos': {
      const saldos = await db.calcularSaldos(usuarioId);
      return { ok: true, data: saldos };
    }
    case 'listar_pendentes': {
      const pendentes = await db.listarPendentes(usuarioId, args.tipo || null);
      return { ok: true, data: pendentes.slice(0, 20).map(t => ({
        id: t.numero_usuario, tipo: t.tipo, valor: t.valor,
        descricao: t.descricao, categoria: t.categoria, data: t.data,
      })) };
    }

    // Limitadores de gasto
    //
    // Só grava direto quando dá para saber o grupo: o limitador já existe (aí
    // preserva as categorias e mexe só no teto) ou a IA extraiu as
    // subcategorias da frase. Sem isso, devolve `precisa_categorias` para o
    // agente perguntar — inventar um agrupamento é o tipo de erro que o usuário
    // só descobre semanas depois, quando o alerta não veio.
    case 'definir_limite': {
      const porSemana = args.periodo === 'semana';
      const campoTeto = porSemana ? 'valor_semanal' : 'valor_mensal';
      const existente = await db.buscarLimitadorPorNome(usuarioId, args.categoria);
      const categorias = existente ? existente.categorias : (args.categorias || []);

      if (categorias.length === 0) {
        return {
          ok: false,
          precisa_categorias: true,
          msg: `Não existe limitador "${args.categoria}" ainda. Pergunte ao usuário QUAIS subcategorias entram nesse grupo antes de criar.`,
        };
      }

      const r = await db.salvarLimitador(usuarioId, {
        id: existente?.id || null,
        nome: existente?.nome || args.categoria,
        valor_semanal: existente?.valor_semanal,
        valor_mensal: existente?.valor_mensal,
        categorias,
        [campoTeto]: args.valor_limite,
      });

      if (!r.ok) {
        if (r.erro === 'categoria_em_uso') {
          const lista = r.conflitos.map((c) => `${c.categoria} já está em ${c.limitador}`).join('; ');
          return { ok: false, msg: `Cada subcategoria só pode estar em um limitador. ${lista}.` };
        }
        return { ok: false, msg: 'Não consegui salvar o limitador.' };
      }

      return {
        ok: true,
        msg: `Limitador ${r.nome}: ${moeda(args.valor_limite)}/${porSemana ? 'semana' : 'mês'}, agrupando ${r.categorias.join(', ')}.`,
      };
    }
    case 'listar_limites': {
      const consumo = await db.listarConsumoLimitadores(usuarioId);
      return { ok: true, data: consumo };
    }
    case 'remover_limite': {
      const limitador = await db.buscarLimitadorPorNome(usuarioId, args.categoria);
      if (!limitador) return { ok: false, msg: 'Limitador não encontrado.' };
      const nome = await db.excluirLimitador(usuarioId, limitador.id);
      if (!nome) return { ok: false, msg: 'Limitador não encontrado.' };
      return { ok: true, msg: `Limitador ${nome} removido.` };
    }

    // Recorrências
    case 'criar_recorrencia': {
      const id = await db.criarRecorrencia(
        usuarioId, args.tipo, args.valor, args.descricao,
        args.categoria, args.frequencia, args.dia_mes || null, args.dia_semana || null, null, null
      );
      return { ok: true, msg: `Recorrência criada: ${args.descricao} ${moeda(args.valor)} (${args.frequencia})`, id };
    }
    case 'listar_recorrencias': {
      const recs = await db.listarRecorrencias(usuarioId);
      return { ok: true, data: recs.map(r => ({
        id: r.id, tipo: r.tipo, valor: r.valor, descricao: r.descricao,
        categoria: r.categoria, frequencia: r.frequencia,
        dia_mes: r.dia_mes, dia_semana: r.dia_semana,
      })) };
    }
    case 'desativar_recorrencia': {
      await db.desativarRecorrencia(usuarioId, args.recorrencia_id);
      return { ok: true, msg: `Recorrência #${args.recorrencia_id} desativada.` };
    }

    // Lembretes
    case 'criar_lembrete': {
      // Garantir timezone BRT: se a IA gerar datetime sem offset, acrescentar -03:00
      let disparaEm = args.dispara_em;
      if (disparaEm && !disparaEm.match(/[Zz+\-]\d{2}:?\d{2}$/) && !disparaEm.endsWith('Z')) {
        disparaEm = disparaEm + '-03:00';
      }
      const disparaDate = new Date(disparaEm);
      const id = await db.createReminder(usuarioId, args.mensagem, disparaDate.toISOString());
      try {
        const { reminderQueue } = require('./queue');
        const delay = Math.max(0, disparaDate.getTime() - Date.now());
        await reminderQueue.add('reminder',
          { tipo: 'one_time', reminderId: id },
          { jobId: `one-${id}`, delay, removeOnComplete: true,
            attempts: 5, backoff: { type: 'exponential', delay: 10000 } }
        );
      } catch (err) {
        console.error('[AGENTE] Erro ao enfileirar lembrete no BullMQ:', err.message);
      }
      return { ok: true, msg: `Lembrete criado para ${disparaDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, ${disparaDate.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`, id };
    }
    case 'criar_lembrete_recorrente': {
      const id = await db.criarLembreteRecorrente(
        usuarioId, args.mensagem, args.horario, args.frequencia,
        args.dia_semana || null, args.dia_mes || null, null
      );
      return { ok: true, msg: `Lembrete recorrente criado: ${args.frequencia} às ${args.horario}`, id };
    }
    case 'listar_lembretes': {
      const [gerais, recorrentes] = await Promise.all([
        db.listarLembretesGerais(usuarioId),
        db.listarLembretesRecorrentes(usuarioId),
      ]);
      return { ok: true, data: { gerais: gerais.slice(0, 10), recorrentes: recorrentes.slice(0, 10) } };
    }
    case 'cancelar_lembrete': {
      if (args.tipo === 'recorrente') {
        const r = await db.cancelarLembreteRecorrente(usuarioId, args.lembrete_id);
        if (!r) return { ok: false, msg: 'Lembrete recorrente não encontrado.' };
        return { ok: true, msg: `Lembrete recorrente #${args.lembrete_id} cancelado.` };
      }
      const r = await db.cancelarLembreteGeral(usuarioId, args.lembrete_id);
      if (!r) return { ok: false, msg: 'Lembrete não encontrado.' };
      return { ok: true, msg: `Lembrete #${args.lembrete_id} cancelado.` };
    }

    // Cartões
    case 'criar_cartao': {
      const id = await db.criarCartao(usuarioId, args.nome, args.limite_total, args.dia_fechamento, args.dia_vencimento);
      if (!id) return { ok: false, msg: 'Erro ao criar cartão.' };
      return { ok: true, msg: `Cartão ${args.nome} registrado com limite ${moeda(args.limite_total)}.` };
    }
    case 'listar_cartoes': {
      const cartoes = await db.listarCartoes(usuarioId);
      const result = [];
      for (const c of cartoes) {
        const uso = await db.obterUsoCartao(c);
        result.push({ ...c, usado: uso.valorUsado, disponivel: uso.disponivel });
      }
      return { ok: true, data: result };
    }
    case 'uso_cartao': {
      // Busca o cartão real do usuário em vez de confiar no dia_fechamento que
      // veio dos args da IA — garante que cartão Pluggy usa o dado real da API
      // (db.obterUsoCartao), não o cálculo de ciclo (que não se aplica a ele).
      const cartoes = await db.listarCartoes(usuarioId);
      const cartao = cartoes.find(c => c.id === args.cartao_id);
      if (!cartao) return { ok: false, msg: 'Cartão não encontrado.' };
      const uso = await db.obterUsoCartao(cartao);
      return {
        ok: true,
        data: {
          nome: cartao.nome,
          valorUsado: uso.valorUsado,
          limiteTotal: uso.limiteTotal,
          disponivel: uso.disponivel,
          qtd: uso.qtd,
          origem: uso.origem,
        },
      };
    }

    // Caixinhas
    case 'criar_caixinha': {
      await db.criarCaixinha(usuarioId, args.nome, args.saldo || 0, args.meta || null, args.tipo || 'economia', args.rendimento_mensal || null);
      return { ok: true, msg: `Caixinha "${args.nome}" criada${args.meta ? ` com meta de ${moeda(args.meta)}` : ''}.` };
    }
    case 'listar_caixinhas': {
      const caixinhas = await db.listarCaixinhas(usuarioId);
      return { ok: true, data: caixinhas };
    }
    case 'depositar_caixinha': {
      const result = await db.adicionarSaldoCaixinha(args.caixinha_id, args.valor);
      if (!result) return { ok: false, msg: 'Caixinha não encontrada.' };
      return { ok: true, msg: `Depósito de ${moeda(args.valor)} em "${result.nome}". Saldo: ${moeda(result.saldo)}` };
    }

    // Contas
    case 'criar_conta': {
      const handlers = getHandlers();
      const msg = await handlers.handleNovaConta(usuarioId, { nome: args.nome || null, tipo: args.tipo || null });
      return { ok: true, msg };
    }
    case 'listar_contas': {
      const handlers = getHandlers();
      const msg = await handlers.handleListarContas(usuarioId);
      return { ok: true, msg };
    }
    case 'saldo_conta': {
      const handlers = getHandlers();
      const msg = await handlers.handleSaldoConta(usuarioId, { conta_nome: args.conta_nome || null });
      return { ok: true, msg };
    }
    case 'transferir': {
      const handlers = getHandlers();
      const msg = await handlers.handleTransferencia(usuarioId, {
        valor: args.valor || null,
        conta_origem: args.conta_origem || null,
        conta_destino: args.conta_destino || null,
        descricao: args.descricao || null,
      });
      return { ok: true, msg };
    }

    // Gráficos
    case 'gerar_grafico_categorias': {
      const resumo = await db.resumoMensal(usuarioId, args.mes, args.ano);
      const buffer = await charts.gerarGraficoCategorias(resumo);
      if (!buffer) return { ok: false, msg: 'Sem dados para gerar gráfico.' };
      return { ok: true, grafico: buffer, msg: 'Gráfico de despesas por categoria gerado.' };
    }
    case 'gerar_grafico_receitas_despesas': {
      const resumo = await db.resumoMensal(usuarioId, args.mes, args.ano);
      const buffer = await charts.gerarGraficoReceitasDespesas(resumo);
      if (!buffer) return { ok: false, msg: 'Sem dados para gerar gráfico.' };
      return { ok: true, grafico: buffer, msg: 'Gráfico receitas vs despesas gerado.' };
    }

    // Pesquisa
    case 'pesquisa_web': {
      const resultados = await search.pesquisarWeb(args.query, 5);
      if (!resultados) return { ok: false, msg: 'Nenhum resultado encontrado.' };
      return { ok: true, data: resultados.slice(0, 5) };
    }

    default:
      return { ok: false, msg: `Tool desconhecida: ${toolName}` };
  }
}

// ── Processamento principal ──────────────────────────────────────────────────

const MAX_TOOL_CALLS_PER_TURN = 5;
const MAX_HISTORY = 20; // mensagens no histórico (10 pares user/assistant)

async function processarMensagem(usuarioId, texto, chatFn) {
  let estado = obterEstado(usuarioId);

  // Verificar se há ação pendente de confirmação
  if (estado && estado.pendingAction) {
    return await handleConfirmacao(usuarioId, texto, estado, chatFn);
  }

  // Inicializar ou atualizar contexto
  if (!estado || (Date.now() - (estado.contextBuiltAt || 0)) > CONTEXT_REFRESH_MS) {
    const ctx = await buildFinancialContext(usuarioId);
    const history = estado ? estado.conversationHistory : [];
    estado = {
      conversationHistory: history,
      contextSnapshot: ctx,
      contextBuiltAt: Date.now(),
      pendingAction: null,
    };
  }

  // Montar mensagens
  const systemMsg = { role: 'system', content: buildSystemPrompt(estado.contextSnapshot.text) };
  estado.conversationHistory.push({ role: 'user', content: texto });

  // Podar histórico se muito longo
  while (estado.conversationHistory.length > MAX_HISTORY) {
    estado.conversationHistory.shift();
  }

  const messages = [systemMsg, ...estado.conversationHistory];

  // Loop de function calling
  let graficoBuffer = null;
  let iteracoes = 0;

  while (iteracoes < MAX_TOOL_CALLS_PER_TURN) {
    iteracoes++;
    const aiResponse = await chatFn(messages, TOOLS);

    if (!aiResponse) {
      salvarEstado(usuarioId, estado);
      return { texto: 'Desculpa, tive um problema aqui. Tenta de novo?' };
    }

    // Se a IA quer chamar tools
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      // Adicionar a mensagem do assistente (com tool_calls) ao histórico
      messages.push(aiResponse);

      for (const tc of aiResponse.tool_calls) {
        const toolName = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }

        // Se a tool requer confirmação, salvar e perguntar ao usuário
        if (TOOLS_COM_CONFIRMACAO.has(toolName)) {
          estado.pendingAction = { toolName, args, toolCallId: tc.id };
          const descricao = descreverAcao(toolName, args);
          salvarEstado(usuarioId, estado);
          return { texto: `${descricao}\n\n*Confirma? (sim/não)*` };
        }

        // Executar tool
        try {
          const result = await executeTool(usuarioId, toolName, args);
          if (result.grafico) graficoBuffer = result.grafico;

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result),
          });

          // Refresh contexto após ação de escrita
          if (toolName === 'registrar_transacao' || toolName === 'liquidar_transacao') {
            const ctx = await buildFinancialContext(usuarioId);
            estado.contextSnapshot = ctx;
            estado.contextBuiltAt = Date.now();
          }
        } catch (err) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ ok: false, msg: `Erro: ${err.message}` }),
          });
        }
      }
      // Continuar o loop para a IA processar os resultados
      continue;
    }

    // Resposta final de texto
    const respostaTexto = aiResponse.content || '';
    estado.conversationHistory.push({ role: 'assistant', content: respostaTexto });

    // Podar histórico
    while (estado.conversationHistory.length > MAX_HISTORY) {
      estado.conversationHistory.shift();
    }

    salvarEstado(usuarioId, estado);

    if (graficoBuffer) {
      return { texto: respostaTexto, grafico: graficoBuffer };
    }
    return { texto: respostaTexto };
  }

  // Atingiu limite de iterações
  salvarEstado(usuarioId, estado);
  return { texto: 'Pronto! Processamento concluído.' };
}

// ── Confirmação de ações ─────────────────────────────────────────────────────

async function handleConfirmacao(usuarioId, texto, estado, chatFn) {
  const lower = texto.toLowerCase().trim();
  const { toolName, args } = estado.pendingAction;

  if (lower === 'sim' || lower === 's' || lower === 'confirma' || lower === 'pode') {
    try {
      const result = await executeTool(usuarioId, toolName, args);
      estado.pendingAction = null;

      // Refresh contexto após escrita
      const ctx = await buildFinancialContext(usuarioId);
      estado.contextSnapshot = ctx;
      estado.contextBuiltAt = Date.now();

      estado.conversationHistory.push(
        { role: 'assistant', content: `✅ ${result.msg || 'Ação executada com sucesso.'}` }
      );
      salvarEstado(usuarioId, estado);

      if (result.grafico) {
        return { texto: `✅ ${result.msg || 'Feito!'}`, grafico: result.grafico };
      }
      return { texto: `✅ ${result.msg || 'Feito!'}` };
    } catch (err) {
      estado.pendingAction = null;
      salvarEstado(usuarioId, estado);
      return { texto: `❌ Erro ao executar: ${err.message}` };
    }
  }

  if (lower === 'não' || lower === 'nao' || lower === 'n' || lower === 'cancela' || lower === 'cancelar') {
    estado.pendingAction = null;
    salvarEstado(usuarioId, estado);
    return { texto: '👍 Ok, cancelado.' };
  }

  // Resposta não reconhecida — perguntar de novo
  return { texto: `Responde *sim* para confirmar ou *não* para cancelar.\n\n${descreverAcao(toolName, args)}` };
}

// ── Descrição amigável das ações ─────────────────────────────────────────────

function descreverAcao(toolName, args) {
  switch (toolName) {
    case 'definir_limite': {
      const grupo = (args.categorias || []).length > 0 ? `\n_Agrupando: ${args.categorias.join(', ')}_` : '';
      return `📊 Definir limitador *${args.categoria}* em *${moeda(args.valor_limite)}/${args.periodo === 'semana' ? 'semana' : 'mês'}*${grupo}`;
    }
    case 'remover_limite':
      return `🗑️ Remover o limitador *${args.categoria}*`;
    case 'criar_recorrencia':
      return `🔄 Criar recorrência: *${args.descricao}* ${moeda(args.valor)} (${args.tipo}, ${args.frequencia})`;
    case 'desativar_recorrencia':
      return `🔄 Desativar recorrência #${args.recorrencia_id}`;
    case 'excluir_transacao':
      return `🗑️ Excluir transação #${args.numero_usuario}`;
    case 'editar_transacao':
      return `✏️ Editar transação #${args.numero_usuario}: ${args.campo} → ${args.novo_valor}`;
    case 'criar_cartao':
      return `💳 Registrar cartão *${args.nome}* (limite ${moeda(args.limite_total)})`;
    case 'criar_caixinha':
      return `🐷 Criar caixinha *"${args.nome}"*${args.meta ? ` com meta de ${moeda(args.meta)}` : ''}`;
    case 'depositar_caixinha':
      return `🐷 Depositar ${moeda(args.valor)} na caixinha #${args.caixinha_id}`;
    case 'criar_lembrete':
      return `⏰ Criar lembrete: "${args.mensagem}" para ${new Date(args.dispara_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    case 'criar_lembrete_recorrente':
      return `⏰ Criar lembrete recorrente: "${args.mensagem}" (${args.frequencia} às ${args.horario})`;
    case 'cancelar_lembrete':
      return `⏰ Cancelar lembrete #${args.lembrete_id}`;
    default:
      return `Executar ${toolName}`;
  }
}

module.exports = {
  processarMensagem,
  executeTool,
  TOOLS,
  obterEstado,
  limparEstado,
  agenteEstados,
};
