# Cronos — Documentação Completa de Funcionalidades
> Versão para equipe de marketing | Março 2026

---

## O que é o Cronos?

**Cronos é um assistente financeiro pessoal que funciona direto no WhatsApp.**

Sem instalar aplicativo. Sem acessar site todo dia. Só mandar mensagem — texto, áudio ou foto — e o Cronos registra, organiza e analisa tudo automaticamente. É como ter um contador particular no seu WhatsApp, disponível 24 horas.

---

## Por que isso é diferente?

| Outros apps financeiros | Cronos |
|---|---|
| Precisa instalar e abrir o app | Funciona no WhatsApp que você já usa |
| Registrar é manual e chato | Fala normal: "gastei 50 no almoço" |
| Você esquece de registrar | Manda áudio enquanto sai do restaurante |
| Relatórios confusos | Resumo claro, no WhatsApp mesmo |
| Aprende sozinho com dificuldade | Guided setup: Finanças em Dia |

---

## Funcionalidades

---

### 1. Registro de Transações (A funcionalidade principal)

O usuário não precisa preencher formulário. Fala ou escreve como normalmente fala.

**Exemplos de frases aceitas:**
- *"gastei 50 reais no almoço"*
- *"paguei 150 de conta de luz"*
- *"recebi 2000 de salário"*
- *"tenho que pagar 200 de internet dia 15"* → salva como **pendente**
- *"vou receber meu freela de 500 dia 20"* → receita pendente
- *"30k de IPVA"* → entende que são R$ 30.000

**Aceita também:**
- 🎙️ **Mensagem de voz** — transcreve com IA e processa
- 📸 **Foto de boleto, nota fiscal, cupom, recibo** — lê e registra automaticamente

**O que a IA extrai automaticamente:**
- Tipo (despesa ou receita)
- Valor (incluindo "30k", "2 mil", "1,5 mil")
- Descrição
- Categoria (vê "mercado" → Alimentação; "netflix" → Lazer)
- Data (hoje, amanhã, dia 15, sexta-feira...)
- Status (pago ou pendente)
- **Cartão de crédito** (quando mencionado: "no Nubank", "no Inter", "no cartão Bradesco")

---

### 2. Consultar Saldo

**Frases:**
- *"saldo"*
- *"quanto tenho?"*
- *"qual é meu saldo?"*

**O que mostra:**
- Saldo atual (receitas pagas - despesas pagas)
- Saldo previsto (incluindo pendentes do mês)
- Patrimônio total (saldo + investimentos/caixinhas)

---

### 3. Resumo Mensal e Anual

**Frases:**
- *"resumo"* → mês atual
- *"resumo março"*
- *"resumo 3/2026"*
- *"resumo anual"*
- *"resumo do mês que vem"*

**O que mostra:**
- Receitas e despesas totais do período
- Saldo do período
- Breakdown por categoria (com gráfico enviado como imagem)
- Diferença entre pago e projetado

---

### 4. Finanças em Dia (Setup Completo)

**O diferencial mais forte do Cronos.**

O usuário responde a uma sequência de perguntas simples e o Cronos monta automaticamente o panorama financeiro completo dele — saldo, receitas fixas, despesas, investimentos, cartões — tudo de uma vez, sem planilha, sem dificuldade.

**Como ativar:** *"finanças em dia"* ou escolher durante o onboarding.

**Etapas guiadas:**
1. **Saldo atual** — quanto tem disponível hoje
2. **Receitas fixas** — salário, aluguel recebido, benefícios (valor + dia do mês)
3. **Receitas variáveis** — freelas, bicos, comissões
4. **Despesas fixas** — aluguel, internet, luz, escola, streaming...
5. **Investimentos e caixinhas** — poupança, CDB, fundos, reserva de emergência
6. **Cartões de crédito** — nome, limite, datas de fechamento/vencimento

**O que acontece após o setup:**
- Cria automaticamente as recorrências mensais para cada despesa/receita fixa
- Registra as transações previstas do mês atual (sempre no mês corrente, nunca no mês seguinte)
- Define orçamento proporcional por categoria
- Registra os cartões informados no sistema de controle de crédito (com limite, data de fechamento e vencimento)
- Gera relatório visual completo com tudo organizado

**Estado persiste no banco:** se o usuário precisar parar no meio, retoma de onde parou.

---

### 5. Análise Financeira 50/30/20

**O que é:** Método clássico de organização financeira que divide a renda em 3 categorias.

**Como ativar:** *"análise financeira"* ou *"50 30 20"*

**Fluxo:**
1. Bot solicita até 3 extratos bancários em CSV
2. Usuário envia os arquivos
3. Bot detecta transações recorrentes e pede confirmação
4. Categoriza tudo automaticamente
5. Gera análise comparando o real vs. a meta ideal

**Divisão analisada:**
- 🏠 **50% — Necessidades** (Moradia, Alimentação, Transporte, Saúde, Educação)
- 🎯 **30% — Desejos** (Lazer, Compras, Assinaturas, Vestuário)
- 💰 **20% — Poupança/Investimentos**

**Resultado:** identifica onde o usuário está desviando da meta e sugere ajustes. Pode criar limites automaticamente.

---

### 6. Assessor de Compra

**O que é:** O usuário pergunta se pode ou não comprar algo, e o Cronos analisa a situação financeira real antes de responder.

**Como ativar:**
- *"quero comprar um iPhone de 5 mil"*
- *"dá pra comprar uma moto de 8k?"*
- *"posso comprar em 12 parcelas?"*

**O que analisa:**
- Saldo atual
- Contas a pagar nos próximos 30 dias
- Superávit médio mensal dos últimos meses
- Próxima receita esperada
- Limites de gastos ativos

**O que responde:**
- Viabilidade da compra à vista
- Viabilidade parcelada (com número de parcelas sugerido)
- Comparativo de cenários
- Recomendação clara: ✅ VIÁVEL / ⚠️ COM CUIDADO / 🚫 NÃO RECOMENDADO

---

### 7. Lembretes

#### 7.1 Lembrete Único
**Frases:**
- *"me lembra daqui 10 minutos de pegar o João"*
- *"me avisa às 15h da reunião"*
- *"lembra sexta-feira às 10h de pagar o aluguel"*

**O que faz:** Manda notificação no WhatsApp no horário exato.

#### 7.2 Lembrete Recorrente
**Frases:**
- *"todo dia às 8h me lembra de tomar o remédio"*
- *"toda segunda às 9h me lembra da reunião"*
- *"todo mês no dia 15 me lembra de pagar o cartão"*
- *"toda semana por 6 meses me lembra de cortar a grama"*

**Frequências suportadas:** diário, semanal (+ dia da semana), mensal (+ dia do mês)
**Duração:** por tempo indeterminado ou com data de encerramento

#### 7.3 Confirmação de Pagamento (automático)
Quando o Cronos lembra de uma conta pendente, o usuário pode responder:
- *"paguei"*, *"sim"*, *"confirmado"*, *"quitei"*, *"mandei o pix"*

O Cronos marca a transação como paga automaticamente.

---

### 8. Caixinhas de Investimento

**O que é:** Buckets nomeados para guardar diferentes reservas e investimentos, cada um com saldo, meta e rendimento.

**Como criar:** durante o Finanças em Dia ou a qualquer momento:
- *"criar caixinha"*
- *"novo investimento"*
- *"criar caixinha viagem Europa"*

**Por caixinha, guarda:**
- Nome (ex: "Reserva de emergência", "CDB Nubank", "Viagem")
- Saldo atual
- Meta (opcional)
- Tipo (renda fixa, ações, poupança...)
- Rendimento mensal % (opcional)

**Para adicionar dinheiro:**
- *"adicionar 500 na poupança"*
- *"depositar 1000 na reserva de emergência"*

> 💡 Ao depositar em uma caixinha, o Cronos registra automaticamente uma despesa na categoria "Investimentos" — assim o saldo da conta corrente é atualizado corretamente e você sabe de onde saiu o dinheiro.

**Para ver tudo:**
- *"caixinhas"* ou *"meus investimentos"*

Mostra saldo de cada uma + progresso para a meta + total investido.

---

### 9. Controle de Orçamento por Categoria

**O que é:** Limites mensais de gastos por categoria. Quando o usuário registra uma despesa, o Cronos mostra automaticamente quanto ainda tem disponível naquela categoria.

**Como definir:**
- *"limitar gastos com Alimentação em 1000 reais"*
- *"limite mensal de Lazer é 500"*

**Barra visual após cada gasto:**
```
Alimentação: ████████░░  80% — R$ 200 restantes
```

**Alertas automáticos:**
- ✅ abaixo de 60%
- 📊 entre 60-80%
- ⚠️ entre 80-100%
- 🚨 acima de 100% (estourou)

**Para ver todos os limites:** *"meus limites"*

---

### 10. Boletos e Documentos por Foto

**O que é:** O usuário tira foto de um boleto, nota fiscal, cupom ou recibo e manda para o Cronos. A IA lê o documento e extrai tudo automaticamente.

**Documentos aceitos:**
- Boletos bancários
- Notas fiscais
- Cupons fiscais
- Recibos
- Faturas

**Extrai automaticamente:**
- Valor
- Descrição (nome do estabelecimento, serviço)
- Data de vencimento ou emissão
- Categoria sugerida

**Fluxo após a foto:**
1. Cronos mostra o que identificou
2. Pergunta: "Já paguei ou está pendente?"
3. Registra conforme resposta

**Se não for documento financeiro** (foto de comida, animal, selfie...):
- Cronos identifica o que está na imagem
- Faz uma piada criativa relacionada a finanças
- Convida a mandar um documento real 😄

---

### 11. Análise de Extrato CSV

**O que é:** O usuário baixa o extrato do banco em CSV e envia para o Cronos. O bot importa todas as transações, categoriza e registra.

**Formatos aceitos:** CSV com colunas de data, valor, descrição.

**O que faz:**
- Detecta receitas e despesas pelo sinal do valor
- Categoriza via IA
- Registra em massa

---

### 12. Painel Web

**O que é:** Interface visual no navegador para ver gráficos, editar transações, configurar o perfil — tudo que é mais fácil de ver em tela grande.

**Como acessar:** *"meu painel"*

**Primeira vez:**
1. Cronos pede nome de usuário (login)
2. Pede senha
3. Envia URL + credenciais

**Funcionalidades do painel:**
- Dashboard com gráficos de gastos por categoria
- Tabela de transações com filtros
- Foto de perfil (sincronizada entre dispositivos)
- Configurações de conta
- Gestão de lembretes e recorrências

---

### 13. Conta Compartilhada (Multi-usuário)

**O que é:** O titular pode adicionar outros números ao mesmo perfil. Marido e esposa, por exemplo, registram no mesmo lugar.

**Como adicionar:** *"adicionar contato 11999998888"*

**O que acontece:**
- O novo contato recebe mensagem de convite automática
- A partir daí, tudo que qualquer membro registrar aparece para todos
- Saldo, pendentes e resumos são compartilhados

**Quem pode remover:** apenas o titular (quem criou a conta originalmente).

---

### 14. Busca na Internet

**O que é:** O Cronos também pesquisa coisas na web — não é exclusivo para finanças.

**Frases:**
- *"preço do iPhone 15"*
- *"como fazer investimento em tesouro direto"*
- *"taxa selic hoje"*
- *"receita de bolo de chocolate"*

**Retorna:** top resultados formatados com título, resumo e link.

---

### 15. Busca de Lugares Próximos

**O que é:** O usuário manda sua localização e o Cronos encontra lugares próximos.

**Como funciona:**
1. Usuário envia localização (via WhatsApp: clipe → Localização → Enviar localização atual)
2. Pergunta o que quer encontrar: *"restaurantes"*, *"farmácias"*, *"academias"*
3. Cronos retorna lista com avaliações, endereço, telefone e link do Google Maps

---

### 16. Agenda

**O que é:** Visão consolidada de receitas, despesas e lembretes por período.

**Frases:**
- *"agenda"* → hoje
- *"agenda amanhã"*
- *"agenda semana"*
- *"agenda do mês"*

**O que mostra:**
- Receitas e despesas pendentes agrupadas por data
- Lembretes do período
- Saldo projetado ao final do período

---

### 17. Listagem e Exclusão de Transações

**Para listar:**
- *"lista"* → últimas 10 transações
- *"lista despesas"*
- *"lista receitas"*
- *"lista esta semana"*
- *"lista pendentes"* / *"contas"* / *"a pagar"*

**Para pagar/receber:**
- *"pagar #5"*
- *"recebi #3"*

**Para excluir:**
- *"excluir #5"*

---

### 18. Assistente Pessoal (além das finanças)

Cronos responde perguntas gerais também:
- *"quanto é 15% de 3000?"*
- *"como funciona o tesouro direto?"*
- *"me explica o que é CDI"*
- *"como fazer café gelado?"*
- Qualquer outra pergunta cotidiana

---

### 19. Onboarding Inteligente (novo usuário)

Quando uma pessoa manda mensagem pela primeira vez:
1. Cronos se apresenta completo
2. Pergunta como quer ser chamado
3. Oferece duas opções:
   - **"Organizar tudo agora"** → inicia Finanças em Dia
   - **"Ir cadastrando aos poucos"** → começa registrando do dia a dia

Se o usuário mandar algo fora de contexto durante o onboarding, o Cronos faz uma piada com o que foi dito e traz de volta ao assunto 😄.

---

### 20. Controle de Cartão de Crédito

**O que é:** Rastreamento completo das compras feitas no cartão de crédito, separado do saldo da conta corrente. O Cronos sabe exatamente quanto você usou do limite em cada ciclo.

#### Registrar compra no cartão

Basta mencionar o cartão ao registrar a despesa:
- *"gastei 150 no mercado com o Nubank"*
- *"paguei 80 de gasolina no Inter"*
- *"comprei 300 de roupa no cartão Bradesco"*

A compra é registrada vinculada ao cartão — **sem descontar da conta corrente**. O saldo bancário só cai quando a fatura for paga.

#### Pergunta automática quando o cartão não é informado

Se você registrar uma despesa sem dizer se foi no cartão ou no débito, o Cronos pergunta automaticamente:

```
Anotei *Mercado* de *R$ 150,00* 👍
Foi no cartão ou conta corrente?
  1. Nubank
  2. Inter
  3. Conta corrente
```

Você responde com o número, o nome do cartão ou "conta corrente" — e o Cronos registra corretamente.

#### Consultar uso do cartão

- *"uso do Nubank"*
- *"quanto usei do Inter?"*
- *"limite do cartão"*
- *"quanto tenho disponível no crédito?"*

**O que mostra:**
```
💳 Nubank — vence dia 10
  💸 Gasto no ciclo: R$ 1.230,00 (8 compras)
  💳 Limite: R$ 5.000,00 🟡 24% usado
  ✅ Disponível: R$ 3.770,00
  📅 Ciclo desde: 2026-02-15
```

Inclui: cor de alerta (🟢 até 50%, 🟡 50-80%, 🔴 acima de 80%) e data de início do ciclo atual.

#### Como funciona internamente

| Tipo de lançamento | Efeito no saldo | Aparece no resumo? |
|---|---|---|
| Compra no cartão | ❌ Não desconta | ❌ Não (aparece na view do cartão) |
| Pagamento da fatura | ✅ Desconta | ✅ Sim |
| Compra no débito / PIX | ✅ Desconta | ✅ Sim |

Isso evita double-counting: a compra aparece na view do cartão; a fatura (já cadastrada como recorrência) aparece no resumo mensal.

---

### 21. Assinatura e Planos

**Consultar:**
- *"meu plano"* → mostra status e validade

**Contratar:**
- *"plano mensal"* ou *"plano anual"* → gera link de pagamento

**Aplicar cupom:**
- *"cupom CRONOS30"* → valida e aplica desconto ou dias grátis

---

## Resumo dos Comandos Diretos

| Comando | O que faz |
|---|---|
| `saldo` | Saldo atual e previsto |
| `resumo` | Resumo do mês |
| `lista` | Últimas transações |
| `pendentes` / `a pagar` | Contas a pagar/receber |
| `agenda` | Agenda do dia |
| `caixinhas` / `investimentos` | Suas caixinhas |
| `meus limites` | Orçamento por categoria |
| `lembretes` | Seus lembretes |
| `uso do cartão` / `uso do Nubank` | Uso e limite dos cartões de crédito |
| `finanças em dia` | Setup financeiro completo |
| `análise financeira` / `50 30 20` | Análise de extrato |
| `meu painel` / `painel` | Painel web |
| `categorias` | Lista categorias disponíveis |
| `contatos` | Contatos vinculados |
| `meu plano` / `assinatura` | Status da assinatura |
| `ajuda` / `menu` | Menu completo |
| `resetar` | Zerar tudo e recomeçar |

---

## Meios de Entrada Suportados

| Formato | Suporte |
|---|---|
| Texto (linguagem natural) | ✅ Completo |
| Mensagem de voz / áudio | ✅ Transcreve e processa |
| Foto de boleto/nota/cupom | ✅ IA lê e extrai dados |
| Foto de qualquer coisa | ✅ Resposta criativa + redirecionamento |
| Localização GPS | ✅ Busca local |
| Arquivo CSV | ✅ Importação de extrato |
| Contato (vCard) | ✅ Vincula à conta |

---

## Integrações e Tecnologia

| Componente | Tecnologia |
|---|---|
| Canal principal | WhatsApp |
| IA de linguagem | OpenAI GPT-4o-mini |
| Transcrição de áudio | OpenAI Whisper |
| Análise de imagens | OpenAI Vision (GPT-4o) |
| Busca web | Brave Search |
| Busca local | Serper (Google Maps) |
| Banco de dados | PostgreSQL |
| Painel web | Node.js + HTML/CSS/JS |
| Servidor | PM2 + Node.js |

---

## Diferenciais para o Marketing

1. **Zero atrito** — funciona no WhatsApp, sem baixar nada
2. **Linguagem natural** — fala como fala, não precisa aprender comandos
3. **Voz** — registra gastos sem tirar o celular do bolso (literalmente)
4. **Foto de boleto** — tira foto e pronto, sem digitar nada
5. **Setup guiado** — Finanças em Dia organiza tudo em uma conversa de 5 minutos
6. **Persistência** — estados salvos no banco, nunca perde progresso
7. **Multi-usuário** — família inteira na mesma conta
8. **Assessor de compra** — antes de gastar, pergunta pro Cronos se é viável
9. **Lembretes automáticos** — lembra de pagar boletos sem que o usuário precise lembrar
10. **Painel web** — para quem quer ver gráficos e detalhes em tela grande
11. **Cartão de crédito inteligente** — rastreia compras por cartão, mostra limite disponível e não confunde com saldo da conta
12. **Pergunta automática sobre cartão** — se não informar, o Cronos pergunta se foi no cartão ou débito antes de registrar

---

*Documentação gerada em Março/2026 — Cronos Assistant*
