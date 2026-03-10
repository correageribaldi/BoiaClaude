# CLAUDE.md — Cronos (Assistente Financeiro WhatsApp)

> Este arquivo fornece contexto de negócio e sistema ao Claude Code.
> Para fluxo operacional técnico (branch, commit, PR, testes), consulte `AGENTS.md`.

---

## Sobre o Produto

**Nome:** Cronos
**Repositório:** https://github.com/correageribaldi/BoiaClaude
**Branch ativa:** claude/whatsapp-financial-assistant-MRumX
**Status:** No ar — 5 usuários em fase beta, monetização em implementação

Assistente financeiro pessoal via WhatsApp. O usuário interage em linguagem natural
pelo WhatsApp para registrar despesas, receitas, consultar saldos, configurar lembretes
e receber análises financeiras. Suporta áudio, imagem (boleto/nota) e CSV de extrato.

---

## Stack Técnica

- **Runtime:** Node.js 18+
- **Canal:** whatsapp-web.js + puppeteer-core
- **Banco:** PostgreSQL (NÃO usa SQLite — o financeiro.db na raiz é resquício, ignorar)
- **IA:** OpenAI (interpretação de mensagem, áudio, imagem, extrato)
- **Busca web:** Brave Search API
- **Busca local:** Serper API
- **Agendamento:** node-cron
- **Gráficos:** chart.js + chartjs-node-canvas
- **Deploy:** VPS Linux (Ubuntu 24) via git pull após push no GitHub

## Arquitetura de Arquivos

```
src/
├── index.js       # bootstrap, eventos WhatsApp, roteamento de mensagens
├── handlers.js    # regra de negócio principal e fluxos conversacionais
├── database.js    # acesso PostgreSQL, schema e consultas
├── ai.js          # integração OpenAI e prompts
├── search.js      # Serper (local) + Brave Search (web)
├── lembretes.js   # jobs cron de lembretes
├── charts.js      # geração de gráficos
└── formatters.js  # formatação de mensagens
```

---

## Contexto de Negócio

Este produto faz parte de um portfólio de micro-SaaS em construção.
É o **Produto 1 de maior prioridade imediata** do roadmap.

**Modelo de receita:** assinatura mensal via Asaas
- Plano Básico: R$19-29/mês
- Plano Ilimitado: R$39/mês
- Período gratuito: 14 dias para novos usuários

**Meta atual:** 50 assinantes pagantes até o final do Mês 2
**MRR alvo:** R$1.950/mês (50 assinantes × R$39)

---

## Integrações Ativas / Planejadas

| Integração | Status | Finalidade |
|------------|--------|------------|
| OpenAI API | ✅ Ativo | Interpretação de linguagem natural |
| Brave Search | ✅ Ativo | Busca web |
| Serper API | ✅ Ativo | Busca local |
| Asaas | 🔄 Implementando | Cobrança recorrente (substituindo InfinityPay) |
| N8N (VPS) | 🔄 Instalando | Webhook pagamentos + auto-deploy + notificações |
| Notion API | 🔄 Configurado | Atualização automática de status do projeto |

---

## Fluxo de Deploy

```
1. Desenvolvimento via Claude Code
2. npm run ci  (lint + test + typecheck — obrigatório antes do push)
3. git push origin <branch>
4. Pull Request para claude/whatsapp-financial-assistant-MRumX
5. Merge aprovado
6. N8N detecta push na main → executa git pull no VPS automaticamente
7. N8N atualiza Notion: campo "Última Atualização" do projeto
```

**Enquanto N8N não estiver configurado:** fazer git pull manualmente no VPS.

---

## Convenções de Desenvolvimento

- Seguir padrões definidos no `AGENTS.md` e `CONTRIBUTING.md` (branch, commit, PR)
- Antes de qualquer alteração: mostrar arquivos que serão modificados
- Escopo restrito: alterar apenas o que foi solicitado
- Sempre rodar `npm run ci` antes de commit
- Mensagens de commit em português, formato: `feat:`, `fix:`, `chore:`

---

## Bugs Conhecidos / Pendências Atuais

- [ ] Bug: registro de receita sendo classificado como despesa em alguns fluxos
- [ ] Melhorar mensagem de onboarding (primeiro uso pouco intuitivo)
- [ ] Adicionar confirmação antes de registrar lançamento (reduz erros)
- [ ] Implementar webhook Asaas para liberação automática de acesso
- [ ] Migrar cobrança de InfinityPay → Asaas

---

## Variáveis de Ambiente (.env)

```
DATABASE_URL=           # PostgreSQL obrigatório
OPENAI_API_KEY=         # obrigatório para IA
OPENAI_MODEL=           # opcional
BRAVE_SEARCH_API_KEY=   # obrigatório para busca web
SERPER_API_KEY=         # obrigatório para busca local
LOCAL_MAX_DISTANCE_KM=  # opcional, padrão 50km
CHROMIUM_PATH=          # recomendado no Linux server
ASAAS_API_KEY=          # a implementar — cobrança recorrente
N8N_WEBHOOK_SECRET=     # a implementar — validação de webhooks
```

---

## Sistema de Gestão (Notion)

O projeto é gerenciado no Notion como parte do Sistema Operacional Pessoal.

- **Workspace:** ⚙️ Central de Operações
- **Entrada no Banco de Projetos:** Assistente Financeiro WhatsApp
- **URL:** https://www.notion.so/31f16b42df9c811d9143d48f35cb8c55

Ao concluir qualquer avanço relevante, atualizar o campo
"Contexto de Retomada" e "Próximo Passo" no Notion via comando `/atualiza-projeto`.

---

## Comandos Rápidos para Claude Code

| Comando | Ação |
|---------|------|
| `/wiki-projeto assistente-financeiro [descrição]` | Registra decisão técnica na Wiki de Projetos do Notion |
| `/atualiza-projeto assistente-financeiro` | Atualiza contexto de retomada e próximo passo no Notion |
| `/nova-ideia [descrição]` | Registra ideia no Banco de Projetos |

