# Guia de Contribuicao

Este documento define o padrao minimo para contribuicoes no projeto Cronos.

## Objetivo

- Manter previsibilidade de entrega.
- Facilitar onboarding de novos devs.
- Reduzir risco de regressao em producao.

## Fluxo de Branch

Crie branches curtas e objetivas:

- `feat/<tema-curto>` para nova funcionalidade
- `fix/<tema-curto>` para correcao de bug
- `docs/<tema-curto>` para documentacao
- `refactor/<tema-curto>` para refatoracao sem mudar comportamento
- `chore/<tema-curto>` para manutencao interna
- `hotfix/<tema-curto>` para correcao urgente em producao

Exemplos:

- `feat/contato-compartilhado-remocao`
- `fix/filtro-periodo-consulta`
- `docs/readme-comandos-atualizados`

## Convencao de Commit

Use Conventional Commits:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `chore: ...`
- `test: ...`

Exemplos:

- `fix: corrigir parse de data para amanha`
- `feat: permitir remover contato compartilhado por indice`
- `docs: atualizar README com stack PostgreSQL`

## Pull Request

Todo PR deve:

1. Explicar objetivo e contexto.
2. Listar arquivos/areas impactadas.
3. Descrever como testar.
4. Informar riscos e impactos.
5. Incluir evidencias (log, print, output) quando aplicavel.

Use o template em `.github/pull_request_template.md`.

## Checklist Minimo Antes de Abrir PR

- [ ] Mudanca resolve um problema claro.
- [ ] Nao expoe segredos/chaves.
- [ ] Nao comita `.env`, auth/cache do WhatsApp ou artefatos locais.
- [ ] Documentacao foi atualizada se houve mudanca funcional.
- [ ] `README.md` e `.env.example` foram revisados quando houve mudanca de configuracao.
- [ ] Fluxos principais foram validados manualmente no WhatsApp.

## Fluxo Obrigatorio de Validacao (Local)

Antes de qualquer commit/push, execute no terminal:

```bash
npm run ci
```

Regras:

- Se `npm run ci` falhar, **nao** faça commit/push.
- Corrija, rode novamente e so depois prossiga.
- Quando estiver trabalhando com IA, sempre solicite o resultado da execucao local antes de aprovar o commit.

## Regras de Review

- Mudancas em `src/database.js`, `src/handlers.js` e `src/index.js` exigem review do owner.
- Mudancas pequenas de `docs` podem ter fluxo simplificado.
- Em caso de duvida sobre impacto, trate como mudanca critica.

## Boas Praticas de Colaboracao

- Prefira PR pequeno e incremental.
- Evite misturar refatoracao com correcao de bug no mesmo PR.
- Se alterar comportamento, descreva antes/depois com exemplos de mensagem do usuario.
- Ao mexer em data/horario, explicite timezone considerado (`America/Sao_Paulo`).
