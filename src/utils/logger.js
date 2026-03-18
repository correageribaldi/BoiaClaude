// Prefixar todas as saídas de console com timestamp no fuso de São Paulo
const fmt = () => new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

['log', 'warn', 'error', 'info'].forEach((method) => {
  const original = console[method].bind(console);
  console[method] = (...args) => original(`[${fmt()}]`, ...args);
});
