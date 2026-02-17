# Regras Operacionais Para IAs Colaboradoras

Este arquivo define o fluxo minimo esperado para qualquer IA que altere o projeto.

## Fluxo Obrigatorio Antes de Commit/Push

1. Mostrar quais arquivos serao alterados.
2. Aplicar alteracoes.
3. Executar validacao local:

```bash
npm run ci
```

4. Reportar resultado da validacao (sucesso/falha).
5. So entao realizar commit/push.

## Regras de Escopo

- Nao alterar arquivos fora do objetivo da tarefa.
- Em mudancas de comportamento, atualizar `README.md` e/ou `CONTRIBUTING.md`.
- Em mudancas de ambiente, atualizar `.env.example`.

## Regras de Conversa de Produto (alto nivel)

- Usuario pode informar tudo de uma vez **ou** em partes.
- Se faltar dado obrigatorio, o bot deve coletar de forma progressiva (perguntar o proximo campo).
- Audio e texto devem seguir o mesmo comportamento funcional.
