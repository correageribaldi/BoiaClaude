// ─── Identidade da contraparte de uma transação (CPF/CNPJ → hash) ────────────
//
// A Pluggy entrega, em paymentData, o documento de quem pagou (payer) e de
// quem recebeu (receiver). Isso é uma chave de identidade MUITO melhor que a
// descrição para o aprendizado de categoria: o mesmo prestador pode aparecer
// como "PIX ENVIADO|JOAO S SILVA", "Ted enviada|JOAO SILVA" e
// "JOAO DA SILVA ME" em três lançamentos, e o texto nunca amarra os três —
// o documento amarra.
//
// ── Privacidade: por que só o HASH é gravado ────────────────────────────────
//
// O documento aqui é de TERCEIRO — quem pagou ao usuário ou recebeu dele.
// Guardar CPF de terceiro em texto puro num banco de aplicação é retenção de
// dado pessoal que o produto não precisa: para o aprendizado, a única pergunta
// é "é a mesma contraparte de antes?", e um hash responde isso igualmente bem.
//
// E é HMAC, não SHA-256 puro nem SHA-256 com salt guardado no banco:
// CPF tem 11 dígitos, ou seja, o espaço inteiro cabe em 10^11 combinações —
// um hash sem segredo é revertido por força bruta em tempo trivial, e um salt
// que vaza junto com a tabela não protege nada. A chave do HMAC é a chave
// mestra da instalação (PLUGGY_ENCRYPTION_KEY), que vive só no .env do
// servidor e nunca no banco (mesma premissa de src/pluggyCrypto.js). Com a
// tabela na mão e sem a chave, o hash não volta a ser CPF.
//
// Consequências assumidas:
//  - a mesma contraparte gera a mesma chave dentro de uma instalação, e chaves
//    diferentes em instalações diferentes (é o desejado — não há por que dois
//    bancos de dados distintos poderem cruzar contrapartes);
//  - trocar PLUGGY_ENCRYPTION_KEY invalida o aprendizado por documento (o
//    aprendizado por texto continua de pé, e o novo é reconstruído no uso);
//  - sem chave configurada, a função devolve null e a feature simplesmente não
//    liga — nunca grava um hash fraco "por enquanto".
//
// REGRA DURA: o documento cru não é logado, não é gravado em coluna nenhuma e
// não sai desta camada. Só o hash atravessa a fronteira do módulo.

const crypto = require('crypto');

// Rótulo de domínio no meio da mensagem: garante que este hash nunca colida
// nem seja intercambiável com outro derivado da mesma chave mestra para outra
// finalidade. O "v1" existe para permitir trocar o esquema no futuro sem
// confundir chave velha com nova.
const DOMINIO_HASH = 'cronos:contraparte:v1:';

const TAMANHO_CPF = 11;
const TAMANHO_CNPJ = 14;

function obterChaveMestra() {
  const chaveHex = process.env.PLUGGY_ENCRYPTION_KEY;
  if (!chaveHex) return null;
  try {
    const chave = Buffer.from(chaveHex, 'hex');
    return chave.length === 32 ? chave : null;
  } catch {
    return null;
  }
}

// normalizarDocumento(valor) -> '03778810073' | null
//
// Só dígitos, e só aceita o que tem cara de CPF (11) ou CNPJ (14) — assim
// "000", "N/A" ou um id de operação não viram chave de aprendizado. Não valida
// dígito verificador de propósito: documento com DV inválido vindo do banco
// ainda é um identificador estável daquela contraparte, e recusar geraria
// menos aprendizado sem ganho de privacidade.
function normalizarDocumento(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const digitos = String(valor).replace(/\D/g, '');
  if (digitos.length !== TAMANHO_CPF && digitos.length !== TAMANHO_CNPJ) return null;
  // Documento com todos os dígitos iguais ("00000000000") é preenchimento
  // genérico de sistema bancário, não identifica ninguém.
  if (/^(\d)\1+$/.test(digitos)) return null;
  return digitos;
}

// hashDocumento(documento) -> hex de 64 chars | null
function hashDocumento(documento) {
  const normalizado = normalizarDocumento(documento);
  if (!normalizado) return null;

  const chave = obterChaveMestra();
  if (!chave) return null; // sem chave mestra a feature fica inerte, por escolha

  return crypto.createHmac('sha256', chave)
    .update(DOMINIO_HASH + normalizado)
    .digest('hex');
}

// documentoDaContraparte(paymentData, tipo) -> string crua | null
//
// Quem é a "contraparte" depende da direção do dinheiro: numa DESPESA o
// usuário é o pagador, então o outro lado é o receiver; numa RECEITA é o
// inverso. Errar isso faria o aprendizado casar o usuário consigo mesmo em
// metade dos lançamentos.
//
// Exportada para teste; o resto do sistema deve usar hashContraparte, que já
// devolve a versão irreversível.
function documentoDaContraparte(paymentData, tipo) {
  const lado = tipo === 'receita' ? paymentData?.payer : paymentData?.receiver;
  const valor = lado?.documentNumber?.value;
  return typeof valor === 'string' ? valor : null;
}

// hashContraparte(paymentData, tipo) -> hex | null — única porta de saída.
function hashContraparte(paymentData, tipo) {
  return hashDocumento(documentoDaContraparte(paymentData, tipo));
}

module.exports = {
  hashContraparte,
  hashDocumento,
  documentoDaContraparte,
  normalizarDocumento,
};
