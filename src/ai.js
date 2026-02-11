const OpenAI = require('openai');
const db = require('./database');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

const SYSTEM_PROMPT = `Você é um assistente financeiro que interpreta mensagens de usuários em português brasileiro.
Sua tarefa é extrair informações financeiras da mensagem e retornar APENAS um JSON válido (sem markdown, sem texto extra).

Categorias disponíveis: {{CATEGORIAS}}

Regras:
- "tipo" deve ser "despesa" ou "receita"
- "valor" deve ser um número positivo (ex: 50.90)
- "descricao" deve ser curta e clara
- "categoria" deve ser uma das categorias listadas acima. Se não tiver certeza, use "Outros"
- "data" deve ser null (para hoje) ou no formato "dd/mm/aaaa" se o usuário mencionar uma data
- Se a mensagem mencionar "hoje", data deve ser null
- Se a mensagem mencionar "ontem", calcule a data de ontem
- Se NÃO for uma mensagem financeira (saudação, pergunta aleatória, etc), retorne: {"acao": "nenhuma"}
- Palavras-chave de despesa: gastei, paguei, comprei, despesa, gasto, conta, boleto, parcela, custo, pagar
- Palavras-chave de receita: recebi, ganhei, entrou, salário, freelance, renda, receita, pagamento recebido
- Se o usuário pedir resumo, lista ou excluir, retorne: {"acao": "comando", "dica": "<comando sugerido>"}

Formato de resposta para transações:
{"acao": "transacao", "tipo": "despesa|receita", "valor": 0.00, "descricao": "...", "categoria": "...", "data": null}

Formato para não-financeiro:
{"acao": "nenhuma"}

Formato para comandos:
{"acao": "comando", "dica": "resumo"}`;

async function interpretarMensagem(texto) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const categorias = (await db.listarCategorias()).join(', ');
    const prompt = SYSTEM_PROMPT.replace('{{CATEGORIAS}}', categorias);

    const hoje = new Date();
    const dataHoje = hoje.toLocaleDateString('pt-BR');

    const response = await getOpenAI().chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Data de hoje: ${dataHoje}\nMensagem: "${texto}"` },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    // Limpar possível markdown do response
    const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[AI] Erro ao interpretar mensagem:', err.message);
    return null;
  }
}

module.exports = { interpretarMensagem };
