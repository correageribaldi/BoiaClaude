const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./database');

let openai;
function getOpenAI() {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

const SYSTEM_PROMPT = `Você é o Cronos, um assistente financeiro amigável e eficiente no WhatsApp.
Você ajuda pessoas a controlar suas finanças de forma simples e natural em português brasileiro.
Retorne APENAS um JSON válido (sem markdown, sem texto extra).

Categorias disponíveis: {{CATEGORIAS}}
Data de hoje: {{DATA_HOJE}}

TIPOS DE AÇÃO:

1. SAUDAÇÃO (oi, olá, bom dia, boa tarde, boa noite, tudo bem, e aí, etc):
{"acao": "saudacao", "resposta": "mensagem amigável e breve, se apresente como Cronos, diga que ajuda a controlar finanças e dê exemplos curtos de como usar"}

2. REGISTRAR TRANSAÇÃO (gastei, paguei, comprei, recebi, ganhei, etc):
{"acao": "transacao", "tipo": "despesa|receita", "valor": 0.00, "descricao": "...", "categoria": "...", "data": null}

3. CONSULTA (quanto gastei, quanto recebi, me mostra, quais foram, etc):
{"acao": "consulta", "tipo": "despesa|receita|null", "categoria": "nome da categoria ou null", "dataInicio": "YYYY-MM-DD ou null", "dataFim": "YYYY-MM-DD ou null", "descricao": "palavra-chave ou null", "pergunta": "resumo curto da pergunta"}

4. COMANDO (pedir resumo, lista, excluir):
{"acao": "comando", "dica": "resumo|lista|excluir"}

5. NÃO FINANCEIRO (assuntos sem relação com finanças):
{"acao": "nenhuma", "resposta": "mensagem gentil explicando que você é um assistente financeiro e dando exemplos de como pode ajudar"}

REGRAS GERAIS:
- SEMPRE retorne JSON válido, nunca texto puro
- Use emojis nas respostas de saudação e nenhuma para ficar amigável

REGRAS PARA SAUDAÇÃO:
- Seja caloroso e breve
- Apresente-se como Cronos
- Dê 2-3 exemplos rápidos de uso: registrar gasto, consultar, pedir resumo

REGRAS PARA TRANSAÇÃO:
- "tipo": "despesa" ou "receita"
- "valor": número positivo (ex: 50.90)
- "descricao": curta e clara
- "categoria": uma das categorias listadas. Se não tiver certeza, use "Outros"
- "data": null para hoje, ou "YYYY-MM-DD" se o usuário mencionar data
- Calcule a data correta para "ontem", "anteontem", "semana passada", etc
- Palavras de despesa: gastei, paguei, comprei, gasto, conta, boleto, parcela
- Palavras de receita: recebi, ganhei, entrou, salário, freelance, renda

REGRAS PARA CONSULTA:
- Extraia os filtros da pergunta do usuário
- Calcule datas relativas baseado na data de hoje:
  - "últimos 3 dias": dataInicio = hoje - 3 dias, dataFim = hoje
  - "esta semana": dataInicio = segunda-feira desta semana, dataFim = hoje
  - "mês passado": dataInicio = primeiro dia do mês anterior, dataFim = último dia do mês anterior
  - "em janeiro": dataInicio = YYYY-01-01, dataFim = YYYY-01-31
- Mapeie termos para categorias: "comida/alimentação/almoço/jantar" → "Alimentação", "uber/ônibus/gasolina" → "Transporte", etc
- Se o termo não mapeia claramente para uma categoria, use o campo "descricao" para busca por palavra-chave
- "pergunta": resuma a consulta do usuário em poucas palavras (ex: "gastos com alimentação nos últimos 3 dias")

REGRAS PARA NÃO FINANCEIRO:
- Seja gentil e redirecione para o uso financeiro
- Dê exemplos de como a pessoa pode usar o bot`;

async function interpretarMensagem(texto) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const categorias = (await db.listarCategorias()).join(', ');
    const hoje = new Date();
    const dataHoje = hoje.toLocaleDateString('pt-BR');

    const prompt = SYSTEM_PROMPT
      .replace('{{CATEGORIAS}}', categorias)
      .replace('{{DATA_HOJE}}', dataHoje);

    const response = await getOpenAI().chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: texto },
      ],
      temperature: 0.3,
      max_tokens: 350,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return null;

    const jsonStr = content.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    return JSON.parse(jsonStr);
  } catch (err) {
    console.error('[AI] Erro ao interpretar mensagem:', err.message);
    return null;
  }
}

async function transcreverAudio(base64Data) {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  const buffer = Buffer.from(base64Data, 'base64');
  const tmpPath = path.join(os.tmpdir(), `cronos_audio_${Date.now()}.ogg`);

  try {
    fs.writeFileSync(tmpPath, buffer);

    const transcription = await getOpenAI().audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(tmpPath),
      language: 'pt',
    });

    return transcription.text?.trim() || null;
  } catch (err) {
    console.error('[AI] Erro ao transcrever áudio:', err.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

module.exports = { interpretarMensagem, transcreverAudio };
