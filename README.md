# Cronos (BoiaClaude) - Assistente Financeiro no WhatsApp

Assistente pessoal para WhatsApp com foco em:
- gestao financeira (despesas, receitas, saldo, pendencias, limites)
- organizacao da rotina (lembretes unicos, recorrentes e agenda)
- operacao compartilhada entre usuario master e contatos vinculados

## Stack Atual

- Runtime: Node.js 18+
- Canal: `whatsapp-web.js` + `puppeteer-core`
- Banco de dados: PostgreSQL (`pg`)
- IA: OpenAI (interpretacao de mensagem, audio, imagem e extrato)
- Busca web: Brave Search API
- Busca local: Serper API
- Agendamento: `node-cron`
- Graficos: `chart.js` + `chartjs-node-canvas`

Observacao importante:
- O projeto **nao usa SQLite**.
- O schema e as migracoes basicas sao inicializados em `src/database.js`.

## Principais Funcionalidades

- Cadastro de despesas e receitas (pagas ou pendentes)
- Consulta por filtros (tipo, categoria, descricao, periodo)
- Resumo mensal e anual
- Lista de lancamentos por tipo e periodo
- Agenda consolidada (financas + lembretes + recorrentes)
- Lembretes unicos e recorrentes
- Liquidacao de pendencias (pagar/receber)
- Limite por categoria com alertas
- Importacao de extrato CSV com categorizacao por IA
- Leitura de imagem (boleto/nota/cupom) e transacao assistida
- Transcricao de audio
- Busca na internet e busca local por geolocalizacao
- Busca local usa Serper; se sem resultado, retorna link direto de busca no Google Maps
- Contatos compartilhados (master + secundarios)
- Analise financeira (inclui fluxo 50/30/20)

## Variaveis de Ambiente

Copie `.env.example` para `.env` e configure:

- `DATABASE_URL` (obrigatorio)
- `OPENAI_API_KEY` (obrigatorio para IA)
- `OPENAI_MODEL` (opcional)
- `BRAVE_SEARCH_API_KEY` (obrigatorio para pesquisa web)
- `SERPER_API_KEY` (obrigatorio para busca local)
- `CHROMIUM_PATH` (opcional, recomendado para Linux server)
- `DEBUG_SHARED_CONTACTS=1` (opcional para debug de vinculos)

## Instalacao

```bash
git clone https://github.com/correageribaldi/BoiaClaude.git
cd BoiaClaude
npm install
```

## Execucao

```bash
npm start
```

Na primeira execucao sera exibido um QR Code para conectar o WhatsApp.

## Validacao de Qualidade (Local)

Antes de commit/push, execute:

```bash
npm run ci
```

Esse comando roda:

- `npm run lint`
- `npm test`
- `npm run typecheck`

## Fluxo Para IAs Colaboradoras

Se a alteracao for feita por IA, siga obrigatoriamente:

- `AGENTS.md` para o fluxo operacional completo
- `CONTRIBUTING.md` para padroes de branch/commit/PR

Resumo minimo obrigatorio para IA:

1. Mostrar arquivos que serao alterados.
2. Aplicar alteracoes somente no escopo solicitado.
3. Executar `npm run ci`.
4. Reportar resultado antes de commit/push.

## Comandos e Intencoes Suportadas

### Financeiro (direto)

- `despesa 50 almoco alimentacao`
- `receita 3000 salario`
- `lista`
- `lista despesas`
- `lista receitas`
- `lista despesas amanha`
- `lista receitas semana que vem`
- `resumo`
- `resumo 02/2026`
- `resumo anual`
- `saldo`
- `pendentes`
- `pagar 12`
- `receber 7`
- `excluir 5`

### Limites

- `definir limite alimentacao 1200`
- `listar limites`
- `remover limite alimentacao`

### Lembretes e agenda

- `me lembre daqui 30 minutos de ligar pro cliente`
- `me lembra amanha as 8 de pagar internet`
- `me lembra toda semana as 9 de fechar relatorio`
- `lembretes`
- `lembretes recorrentes`
- `cancelar lembrete #10`
- `cancelar recorrente #R4`
- `agenda`
- `agenda amanha`
- `agenda semana`
- `agenda mes`

### Conta compartilhada (master e secundarios)

- `adicionar contato 5511999998888`
- enviar contato anexado (vCard)
- `contatos`
- `remover contato`

### IA e assistente

- Linguagem natural para registrar/consultar financas
- Audio para transacao e comandos
- Imagem de boleto/nota/cupom
- Importacao de extrato CSV
- Busca web/local com localizacao

## Arquitetura do Codigo

```text
src/
|- index.js        # bootstrap do app, eventos WhatsApp, roteamento de mensagens
|- handlers.js     # regra de negocio principal e fluxos conversacionais
|- database.js     # acesso PostgreSQL, schema e consultas
|- ai.js           # integracao OpenAI e prompts
|- search.js       # integracao Serper (local) + Brave Search (web)
|- lembretes.js    # jobs cron de lembretes
|- charts.js       # geracao de graficos
|- formatters.js   # formatacao de mensagens
```

## Fluxo Base de Processamento

1. Mensagem chega no `src/index.js`.
2. O bot identifica tipo (texto, audio, imagem, csv, localizacao, vcard).
3. `src/handlers.js` decide o fluxo (comando direto ou IA).
4. Persistencia/leitura ocorre via `src/database.js` (PostgreSQL).
5. Resposta e eventuais notificacoes sao enviadas ao usuario no WhatsApp.

## Observacoes Operacionais

- Para servidor Linux, defina `CHROMIUM_PATH` para o binario valido do Chromium.
- O bot foi pensado para execucao continua (ex: PM2/systemd).
- A autenticacao WhatsApp fica em `.wwebjs_auth/` e `.wwebjs_cache/`.
