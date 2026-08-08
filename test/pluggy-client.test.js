const test = require('node:test');
const assert = require('node:assert/strict');

const pluggy = require('../src/pluggy');

// Cobertura de rede real (200/401 da API Pluggy) fica fora deste teste unitário
// de propósito — o módulo chama https://api.pluggy.ai/auth com URL fixa, sem
// injeção de cliente HTTP para mockar. Validado manualmente antes do Marco 1
// ir a produção; se o módulo crescer no Marco 2 (Connect Token, Item), vale
// considerar extrair o cliente HTTP para permitir mock nesses testes.

test('gerarApiKey: rejeita sem client_id, sem tentar rede', async () => {
  await assert.rejects(
    () => pluggy.gerarApiKey('', 'algum-secret'),
    /Client ID e Client Secret são obrigatórios/
  );
});

test('gerarApiKey: rejeita sem client_secret, sem tentar rede', async () => {
  await assert.rejects(
    () => pluggy.gerarApiKey('algum-client-id', ''),
    /Client ID e Client Secret são obrigatórios/
  );
});

test('gerarApiKey: rejeita quando ambos ausentes', async () => {
  await assert.rejects(() => pluggy.gerarApiKey(undefined, undefined));
});
