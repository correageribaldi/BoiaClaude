# BoiaClaude - Assistente Financeiro WhatsApp

Bot para controle financeiro pessoal via WhatsApp. Cadastre despesas e receitas, visualize resumos mensais e anuais, tudo direto pelo WhatsApp.

## Funcionalidades

- Cadastro de **despesas** e **receitas** com valor, descrição, categoria e data
- **Resumo mensal** com totais e breakdown por categoria
- **Resumo anual** com saldo por mês
- **Listagem** dos últimos lançamentos
- **Exclusão** de lançamentos
- Dados armazenados localmente em SQLite

## Pré-requisitos

- Node.js 18+
- Google Chrome ou Chromium instalado (necessário para whatsapp-web.js)

## Instalação

```bash
git clone https://github.com/correageribaldi/BoiaClaude.git
cd BoiaClaude
npm install
```

## Uso

```bash
npm start
```

Na primeira execução, um QR Code aparecerá no terminal. Escaneie-o com o WhatsApp:

1. Abra o WhatsApp no celular
2. Vá em **Dispositivos conectados** > **Conectar dispositivo**
3. Escaneie o QR Code

Após conectar, envie **ajuda** para o número conectado para ver os comandos.

## Comandos

| Comando | Descrição | Exemplo |
|---------|-----------|---------|
| `despesa <valor> <descrição> [categoria] [data]` | Registrar despesa | `despesa 50 Almoço Alimentação` |
| `receita <valor> <descrição> [categoria] [data]` | Registrar receita | `receita 3000 Salário Salário` |
| `resumo` | Resumo do mês atual | `resumo` |
| `resumo <mês>` | Resumo de um mês | `resumo 01` |
| `resumo anual` | Resumo do ano | `resumo anual` |
| `lista` | Últimos 10 lançamentos | `lista` |
| `lista despesas` | Últimas despesas | `lista despesas` |
| `lista receitas` | Últimas receitas | `lista receitas` |
| `excluir <id>` | Excluir lançamento | `excluir 5` |
| `categorias` | Ver categorias | `categorias` |
| `ajuda` | Ver todos os comandos | `ajuda` |

## Categorias padrão

Alimentação, Transporte, Moradia, Saúde, Educação, Lazer, Vestuário, Salário, Freelance, Investimentos, Outros

## Estrutura

```
src/
├── index.js        # Entry point, conexão WhatsApp
├── handlers.js     # Parser de comandos e lógica
├── database.js     # Camada de dados SQLite
└── formatters.js   # Formatação de mensagens
```

## Tecnologias

- [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) - Conexão WhatsApp
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - Banco de dados
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) - QR Code no terminal
