/* ── Cronos — Painel Financeiro ───────────────────────────────────────────── */

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── Auth ──────────────────────────────────────────────────────────────────────
function getJwt() { return localStorage.getItem('cronos_jwt'); }
function setJwt(t) { localStorage.setItem('cronos_jwt', t); }
function clearJwt() { localStorage.removeItem('cronos_jwt'); }

let _isAdmin = false;
let _saldoOculto = false;
let _saldoAtual = null;
let _meNome = '';

// ── Tema claro / escuro ────────────────────────────────────────────────────
function getTheme() { return localStorage.getItem('cronos_theme') || 'dark'; }
function setTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('cronos_theme', theme);
  _syncThemeToggle();
}
function _syncThemeToggle() {
  const bar = document.getElementById('theme-toggle-bar');
  if (!bar) return;
  const tema = getTheme();
  bar.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeVal === tema);
  });
}

// ── Helpers de avatar / settings ──────────────────────────────────────────────
let _avatarData = null; // data URL da foto vinda do servidor

function _aplicarAvatar(nomeBase) {
  const avatarEl   = document.getElementById('dash-avatar');
  const settingsEl = document.getElementById('settings-avatar-preview');
  const navEl      = document.getElementById('nav-avatar');
  if (avatarEl) {
    if (_avatarData) {
      avatarEl.innerHTML = `<img src="${_avatarData}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;display:block;">`;
    } else {
      avatarEl.innerHTML = '';
      avatarEl.textContent = (nomeBase[0] || '?').toUpperCase();
    }
  }
  if (settingsEl) {
    if (_avatarData) {
      settingsEl.innerHTML = `<img src="${_avatarData}" alt="foto">`;
    } else {
      settingsEl.textContent = (nomeBase[0] || '?').toUpperCase();
    }
  }
  if (navEl) {
    if (_avatarData) {
      navEl.innerHTML = `<img src="${_avatarData}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;display:block;">`;
    } else {
      navEl.innerHTML = '';
      navEl.textContent = (nomeBase[0] || '?').toUpperCase();
    }
  }
}

function _comprimirImagem(file, callback) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 256;
      const scale = Math.min(MAX / img.width, MAX / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      callback(canvas.toDataURL('image/jpeg', 0.75));
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

let _inicializado = false;

async function verificarAuth(tentativa = 1) {
  const jwt = getJwt();
  if (!jwt) { esconderLoading(); mostrarLogin(); return; }

  let res;
  try {
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt };
    res = await fetch('/api/auth/me', { headers });
  } catch {
    // Erro de rede (offline, DNS, timeout)
    if (tentativa < 3) {
      console.warn(`[AUTH] Tentativa ${tentativa} falhou (rede), retentando em 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return verificarAuth(tentativa + 1);
    }
    // 3 falhas de rede: mostra app offline se possível, senão login
    console.error('[AUTH] 3 tentativas de rede falharam');
    esconderLoading();
    mostrarLogin();
    return;
  }

  // Token inválido ou expirado → logout
  if (res.status === 401) {
    clearJwt();
    esconderLoading();
    mostrarLogin();
    return;
  }

  // Servidor retornou erro (500, etc) → retry sem limpar token
  if (!res.ok) {
    if (tentativa < 3) {
      console.warn(`[AUTH] /api/auth/me retornou ${res.status}, retentando...`);
      await new Promise(r => setTimeout(r, 2000));
      return verificarAuth(tentativa + 1);
    }
    console.error('[AUTH] /api/auth/me falhou 3 vezes com status', res.status);
    esconderLoading();
    mostrarLogin();
    return;
  }

  const me = await res.json().catch(() => ({}));
  _isAdmin = !!me.isAdmin;
  _avatarData = me.avatarData || null;
  _aplicarAvatar(me.nome || me.username || '?');
  _meNome = me.nome || me.username || '';
  if (_isAdmin) {
    document.getElementById('nav-admin').classList.remove('hidden');
  }
  esconderLoading();
  document.getElementById('app').classList.remove('hidden');

  if (!_inicializado) {
    _inicializado = true;
    try { inicializar(); } catch (err) {
      console.error('[INIT] Erro em inicializar():', err);
    }
  }

  // Restaurar aba ativa salva no localStorage
  const abaSalva = localStorage.getItem('cronos_tab_ativa');
  if (abaSalva && document.getElementById('tab-' + abaSalva)) {
    ativarTab(abaSalva);
  } else {
    ativarTab('dashboard');
  }

  // Detectar retorno do OAuth Google
  if (window.location.hash === '#google-connected') {
    toast('✅ Google Calendar conectado!', 'success');
    window.history.replaceState(null, '', window.location.pathname);
  }
}

function esconderLoading() {
  const el = document.getElementById('tela-loading');
  if (el) el.classList.add('hidden');
}

function mostrarLogin() {
  esconderLoading();
  document.getElementById('tela-login').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  setTimeout(() => document.getElementById('login-user')?.focus(), 50);
}

function logout() {
  clearJwt();
  localStorage.removeItem('cronos_tab_ativa');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('tela-login').classList.remove('hidden');
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-erro').classList.add('hidden');
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const jwt = getJwt() || '';
  const headers = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = 'Bearer ' + jwt;

  let res;
  try {
    res = await fetch(path, { headers, ...opts });
  } catch {
    throw new Error('Erro de conexão. Verifique sua internet.');
  }

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) { clearJwt(); mostrarLogin(); throw new Error('Sessão expirada'); }
  if (!res.ok) throw new Error(data.erro || 'Erro ' + res.status);
  return data;
}

// ── Modal de confirmação de recorrência ───────────────────────────────────────
// Retorna Promise<'apenas_este' | 'todos' | null>
function mostrarModalRecorrencia(descricao) {
  return new Promise(resolve => {
    const overlay = document.getElementById('modal-recorrencia');
    document.getElementById('modal-recorrencia-msg').textContent =
      `"${descricao}" é uma transação recorrente. O que deseja fazer?`;

    function fechar(res) {
      overlay.classList.add('hidden');
      btnApenas.removeEventListener('click', onApenas);
      btnTodos.removeEventListener('click', onTodos);
      btnDesistir.removeEventListener('click', onDesistir);
      overlay.removeEventListener('click', onOverlay);
      resolve(res);
    }
    function onApenas()   { fechar('apenas_este'); }
    function onTodos()    { fechar('todos'); }
    function onDesistir() { fechar(null); }
    function onOverlay(e) { if (e.target === overlay) fechar(null); }

    const btnApenas  = document.getElementById('modal-rec-apenas-este');
    const btnTodos   = document.getElementById('modal-rec-todos');
    const btnDesistir = document.getElementById('modal-rec-desistir');

    btnApenas.addEventListener('click', onApenas);
    btnTodos.addEventListener('click', onTodos);
    btnDesistir.addEventListener('click', onDesistir);
    overlay.addEventListener('click', onOverlay);

    overlay.classList.remove('hidden');
  });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, tipo = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

// ── Formatação ────────────────────────────────────────────────────────────────
function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtData(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return d + '/' + m + '/' + y;
}

// ── Ícones inteligentes de transações ─────────────────────────────────────────
const ICON_MAP = [
  // Streaming / entretenimento
  { re: /netflix/i, domain: 'netflix.com' },
  { re: /spotify/i, domain: 'spotify.com' },
  { re: /disney|disney\+/i, domain: 'disneyplus.com' },
  { re: /hbo|max/i, domain: 'max.com' },
  { re: /prime\s?video|amazon\s?prime/i, domain: 'primevideo.com' },
  { re: /apple\s?(tv|music)/i, domain: 'apple.com' },
  { re: /youtube|yt\s?premium/i, domain: 'youtube.com' },
  { re: /crunchyroll/i, domain: 'crunchyroll.com' },
  { re: /globoplay/i, domain: 'globoplay.globo.com' },
  { re: /deezer/i, domain: 'deezer.com' },
  { re: /twitch/i, domain: 'twitch.tv' },
  { re: /steam/i, domain: 'store.steampowered.com' },
  { re: /playstation|psn|ps\+/i, domain: 'playstation.com' },
  { re: /xbox|game\s?pass/i, domain: 'xbox.com' },
  // Delivery / alimentação
  { re: /ifood|i-food/i, domain: 'ifood.com.br' },
  { re: /rappi/i, domain: 'rappi.com.br' },
  { re: /uber\s?eats/i, domain: 'ubereats.com' },
  { re: /zé\s?delivery|ze\s?delivery/i, domain: 'ze.delivery' },
  { re: /mc\s?donald|mcdonald|mc\s?donalds/i, domain: 'mcdonalds.com.br' },
  { re: /burger\s?king/i, domain: 'burgerking.com.br' },
  { re: /starbucks/i, domain: 'starbucks.com.br' },
  { re: /subway/i, domain: 'subway.com' },
  { re: /habib/i, domain: 'habibs.com.br' },
  // Transporte
  { re: /uber(?!\s?eat)/i, domain: 'uber.com' },
  { re: /99|99\s?taxi|99pop/i, domain: '99app.com' },
  { re: /cabify/i, domain: 'cabify.com' },
  // Telecom / internet
  { re: /vivo/i, domain: 'vivo.com.br' },
  { re: /claro/i, domain: 'claro.com.br' },
  { re: /tim\b/i, domain: 'tim.com.br' },
  { re: /oi\b/i, domain: 'oi.com.br' },
  // Serviços / tech
  { re: /google/i, domain: 'google.com' },
  { re: /microsoft|office\s?365/i, domain: 'microsoft.com' },
  { re: /amazon(?!\s?prime)/i, domain: 'amazon.com.br' },
  { re: /mercado\s?livre/i, domain: 'mercadolivre.com.br' },
  { re: /shopee/i, domain: 'shopee.com.br' },
  { re: /shein/i, domain: 'shein.com' },
  { re: /aliexpress/i, domain: 'aliexpress.com' },
  { re: /magalu|magazine\s?luiza/i, domain: 'magazineluiza.com.br' },
  { re: /casas\s?bahia/i, domain: 'casasbahia.com.br' },
  { re: /americanas/i, domain: 'americanas.com.br' },
  // Saúde / farmácia
  { re: /drogasil/i, domain: 'drogasil.com.br' },
  { re: /droga\s?raia/i, domain: 'drogaraia.com.br' },
  { re: /pacheco/i, domain: 'dfrfrr.com.br' },
  // Supermercado
  { re: /carrefour/i, domain: 'carrefour.com.br' },
  { re: /pão\s?de\s?açúcar|pao\s?de\s?acucar/i, domain: 'paodeacucar.com' },
  { re: /extra\b/i, domain: 'extra.com.br' },
  // Financeiro / bancos
  { re: /nubank/i, domain: 'nubank.com.br' },
  { re: /inter\b/i, domain: 'bancointer.com.br' },
  { re: /itaú|itau/i, domain: 'itau.com.br' },
  { re: /bradesco/i, domain: 'bradesco.com.br' },
  { re: /santander/i, domain: 'santander.com.br' },
  { re: /caixa/i, domain: 'caixa.gov.br' },
  { re: /bb\b|banco\s?do\s?brasil/i, domain: 'bb.com.br' },
  { re: /c6\s?bank/i, domain: 'c6bank.com.br' },
  { re: /picpay/i, domain: 'picpay.com' },
  { re: /mercado\s?pago/i, domain: 'mercadopago.com.br' },
  // Educação
  { re: /duolingo/i, domain: 'duolingo.com' },
  { re: /udemy/i, domain: 'udemy.com' },
  { re: /coursera/i, domain: 'coursera.org' },
  { re: /alura/i, domain: 'alura.com.br' },
  // Moradia / serviços
  { re: /enel|eletropaulo|light\b|cemig|cpfl|energisa/i, emoji: '⚡' },
  { re: /sabesp|copasa|água|agua/i, emoji: '💧' },
  { re: /comgas|comgás|gás|gas\b/i, emoji: '🔥' },
  { re: /aluguel|condomínio|condominio|iptu/i, emoji: '🏠' },
  { re: /seguro/i, emoji: '🛡️' },
  { re: /academia|gym|smart\s?fit/i, domain: 'smartfit.com.br' },
];

const CATEGORIA_EMOJI = {
  'alimentação': '🍽️', 'alimentacao': '🍽️', 'comida': '🍽️', 'restaurante': '🍽️',
  'transporte': '🚗', 'combustível': '⛽', 'combustivel': '⛽',
  'moradia': '🏠', 'casa': '🏠', 'aluguel': '🏠',
  'saúde': '💊', 'saude': '💊', 'farmácia': '💊', 'farmacia': '💊',
  'educação': '📚', 'educacao': '📚',
  'lazer': '🎮', 'entretenimento': '🎬',
  'compras': '🛒', 'shopping': '🛒',
  'salário': '💰', 'salario': '💰', 'renda': '💰',
  'investimento': '📈', 'investimentos': '📈',
  'pet': '🐾', 'animal': '🐾',
  'beleza': '💇', 'estética': '💇', 'estetica': '💇',
  'viagem': '✈️', 'viagens': '✈️',
  'comunicação': '📱', 'comunicacao': '📱', 'telefone': '📱',
  'assinatura': '📦', 'assinaturas': '📦',
  'impostos': '📋', 'imposto': '📋', 'taxa': '📋',
  'doação': '❤️', 'doacao': '❤️',
  'vestuário': '👕', 'vestuario': '👕', 'roupa': '👕', 'roupas': '👕',
};

/**
 * Retorna HTML do ícone para uma transação.
 * Prioridade: marca conhecida (favicon) → categoria (emoji) → tipo (seta).
 */
function iconeTx(descricao, categoria, tipo) {
  const desc = (descricao || '').toLowerCase();
  // 1. Tentar match de marca
  for (const entry of ICON_MAP) {
    if (entry.re.test(desc)) {
      if (entry.domain) {
        return `<img src="https://www.google.com/s2/favicons?domain=${entry.domain}&sz=32" alt="" style="width:20px;height:20px;border-radius:4px;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span style="display:none;width:20px;height:20px;align-items:center;justify-content:center;font-size:14px">${tipo === 'receita' ? '↑' : '↓'}</span>`;
      }
      return entry.emoji;
    }
  }
  // 2. Tentar match de categoria
  const cat = (categoria || '').toLowerCase();
  if (CATEGORIA_EMOJI[cat]) return CATEGORIA_EMOJI[cat];
  // 3. Fallback tipo
  return tipo === 'receita' ? '↑' : '↓';
}

// ── Estado global ─────────────────────────────────────────────────────────────
const estado = {
  dash: { mes: new Date().getMonth() + 1, ano: new Date().getFullYear() },
  tx: { mes: new Date().getMonth() + 1, ano: new Date().getFullYear(),
        filtroStatus: '', filtroTipo: '', filtroRecorrente: false, busca: '', pagina: 1 },
  ag: { mes: new Date().getMonth() + 1, ano: new Date().getFullYear() },
  charts: {},
};

// ── Charts ────────────────────────────────────────────────────────────────────
const COR_CATEGORIA = [
  '#3498db','#e74c3c','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4','#8bc34a',
];

function renderChartCategorias(porCategoria) {
  const despesas = porCategoria.filter(r => r.tipo === 'despesa' && r.total > 0);
  const wrap = document.getElementById('chart-categorias')?.parentElement;
  if (!wrap) return;

  if (estado.charts.categorias) { estado.charts.categorias.destroy(); estado.charts.categorias = null; }

  if (!despesas.length) {
    wrap.innerHTML = '<div class="empty-state">Sem despesas no período.</div>';
    return;
  }

  // Sempre recriar o canvas — garante estado limpo após destroy()
  wrap.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.id = 'chart-categorias';
  wrap.appendChild(canvas);

  estado.charts.categorias = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: despesas.map(r => r.categoria),
      datasets: [{ data: despesas.map(r => r.total), backgroundColor: COR_CATEGORIA, borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 10 } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.label + ': ' + fmtMoeda(ctx.raw) } },
      },
    },
  });
}

async function renderChartMensal() {
  const { ano, mes } = estado.dash;
  let resumo;
  try { resumo = await api('/api/resumo-anual?ano=' + ano); }
  catch { return; }

  const mesesLabels = Array.from({ length: 12 }, (_, i) => MESES[i].substring(0, 3));
  const receitas = Array(12).fill(0);
  const despesas = Array(12).fill(0);

  for (const row of resumo.meses) {
    const idx = parseInt(row.mes) - 1;
    if (row.tipo === 'receita') receitas[idx] = row.total;
    else despesas[idx] = row.total;
  }

  const start = Math.max(0, mes - 6);
  const end = mes;

  const wrap = document.getElementById('chart-mensal')?.parentElement;
  if (!wrap) return;
  if (estado.charts.mensal) { estado.charts.mensal.destroy(); estado.charts.mensal = null; }

  // Sempre recriar o canvas — garante estado limpo após destroy()
  wrap.innerHTML = '';
  const canvasMensal = document.createElement('canvas');
  canvasMensal.id = 'chart-mensal';
  wrap.appendChild(canvasMensal);

  estado.charts.mensal = new Chart(canvasMensal, {
    type: 'bar',
    data: {
      labels: mesesLabels.slice(start, end),
      datasets: [
        { label: 'Receitas', data: receitas.slice(start, end), backgroundColor: '#2ecc7188', borderColor: '#27ae60', borderWidth: 1 },
        { label: 'Despesas', data: despesas.slice(start, end), backgroundColor: '#e74c3c88', borderColor: '#c0392b', borderWidth: 1 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 11 } } },
        tooltip: { callbacks: { label: ctx => ' ' + ctx.dataset.label + ': ' + fmtMoeda(ctx.raw) } },
      },
      scales: { y: { ticks: { callback: v => 'R$' + (v / 1000).toFixed(0) + 'k', font: { size: 11 } } } },
    },
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function carregarDashboard() {
  const { mes, ano } = estado.dash;
  document.getElementById('dash-mes-label').textContent = MESES[mes - 1] + ' ' + ano;

  let data;
  try { data = await api(`/api/dashboard?mes=${mes}&ano=${ano}`); }
  catch (err) { if (err.message !== 'Sessão expirada') toast('Erro ao carregar dashboard', 'error'); return; }

  const { resumo, saldos } = data;
  const totais = resumo.totais || [];
  const atrasadas = resumo.atrasadas || [];
  const findTotal = (tipo, status) => totais.find(r => r.tipo === tipo && r.status === status)?.total || 0;
  const findAtrasada = (tipo) => atrasadas.find(r => r.tipo === tipo);

  // Saldo: atual no mês corrente, resultado do mês nos demais
  const agora = new Date();
  const ehMesAtual = (mes === agora.getMonth() + 1 && ano === agora.getFullYear());
  const saldoLabel = document.getElementById('c-saldo-label');
  if (ehMesAtual) {
    if (saldoLabel) saldoLabel.textContent = 'Saldo em contas';
    _saldoAtual = saldos.saldoAtual;
  } else {
    if (saldoLabel) saldoLabel.textContent = 'Resultado do Mês';
    _saldoAtual = (findTotal('receita', 'pago') + findTotal('receita', 'pendente'))
                - (findTotal('despesa', 'pago') + findTotal('despesa', 'pendente'));
  }
  document.getElementById('c-saldo').textContent = _saldoOculto ? '••••••' : fmtMoeda(_saldoAtual);

  // Totais do mês (pago + pendente)
  document.getElementById('c-receitas').textContent = fmtMoeda(findTotal('receita', 'pago') + findTotal('receita', 'pendente'));
  document.getElementById('c-despesas').textContent = fmtMoeda(findTotal('despesa', 'pago') + findTotal('despesa', 'pendente'));

  // Pendentes do mês
  const elAReceber = document.getElementById('c-a-receber');
  const elAPagar   = document.getElementById('c-a-pagar');
  if (elAReceber) elAReceber.textContent = fmtMoeda(findTotal('receita', 'pendente'));
  if (elAPagar)   elAPagar.textContent   = fmtMoeda(findTotal('despesa', 'pendente'));

  // Alertas de atrasados
  const atRec = findAtrasada('receita');
  const elAlertRec = document.getElementById('alert-receber');
  if (elAlertRec) {
    if (atRec && atRec.quantidade > 0) {
      elAlertRec.textContent = `⚠️ ${atRec.quantidade} receita${atRec.quantidade > 1 ? 's' : ''} atrasada${atRec.quantidade > 1 ? 's' : ''} — ver`;
      elAlertRec.classList.remove('hidden');
    } else {
      elAlertRec.classList.add('hidden');
    }
  }

  const atDesp = findAtrasada('despesa');
  const elAlertPag = document.getElementById('alert-pagar');
  if (elAlertPag) {
    if (atDesp && atDesp.quantidade > 0) {
      elAlertPag.textContent = `⚠️ ${atDesp.quantidade} despesa${atDesp.quantidade > 1 ? 's' : ''} atrasada${atDesp.quantidade > 1 ? 's' : ''} — ver`;
      elAlertPag.classList.remove('hidden');
    } else {
      elAlertPag.classList.add('hidden');
    }
  }

  renderChartCategorias(resumo.porCategoria || []);
  try { await renderChartMensal(); } catch (e) { console.error('[CHART]', e); }
}

// ── Dashboard: últimas transações ────────────────────────────────────────────
async function carregarUltimasTx() {
  const el = document.getElementById('dash-ultimas-tx');
  if (!el) { console.warn('[DASH] #dash-ultimas-tx não encontrado'); return; }
  try {
    const { mes, ano } = estado.dash;
    const mesStr = String(mes).padStart(2, '0');
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dataInicio = `${ano}-${mesStr}-01`;
    const dataFim = `${ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;
    const txs = await api(`/api/transactions?dataInicio=${dataInicio}&dataFim=${dataFim}&limite=5`);
    const lista = Array.isArray(txs) ? txs : [];
    if (lista.length === 0) {
      el.innerHTML = '<p class="empty-hint">Nenhuma transação no mês.</p>';
      return;
    }
    el.innerHTML = lista.slice(0, 5).map(t => {
      return `<div class="dash-tx-item">
        <div class="dash-tx-icon ${t.tipo}">${iconeTx(t.descricao, t.categoria, t.tipo)}</div>
        <div class="dash-tx-info">
          <div class="dash-tx-desc">${t.descricao || '—'}</div>
          <div class="dash-tx-meta">${fmtData(t.data)}${t.categoria ? ' · ' + t.categoria : ''}</div>
        </div>
        <div class="dash-tx-valor ${t.tipo}">${fmtMoeda(t.valor)}</div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('[DASH] Erro carregarUltimasTx:', err);
    el.innerHTML = '<p class="empty-hint">Erro ao carregar.</p>';
  }
}

// ── Dashboard: próximos lembretes ────────────────────────────────────────────
async function carregarProximosLembretes() {
  const el = document.getElementById('dash-proximos-lembretes');
  if (!el) { console.warn('[DASH] #dash-proximos-lembretes não encontrado'); return; }
  try {
    const agora = new Date();
    const mes = agora.getMonth() + 1;
    const ano = agora.getFullYear();
    const itens = await api(`/api/agenda?mes=${mes}&ano=${ano}`);
    // Filtrar apenas futuros ou de hoje, deduplicar recorrentes (só o próximo)
    const hoje = agora.toISOString().substring(0, 10);
    const futuros = (itens || []).filter(i => (i.data_disparo || '') >= hoje);
    const vistos = new Set();
    const proximos = [];
    for (const i of futuros) {
      const chave = (i.recorrente_id ? 'rec_' + i.recorrente_id : 'avulso_' + (i.id || i.mensagem));
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      proximos.push(i);
      if (proximos.length >= 5) break;
    }
    if (proximos.length === 0) {
      el.innerHTML = '<p class="empty-hint">Nenhum lembrete próximo.</p>';
      return;
    }
    el.innerHTML = proximos.map(l => {
      const data = l.data_disparo ? fmtData(l.data_disparo) : '—';
      const hora = l.hora ? l.hora.substring(0, 5) : '';
      return `<div class="dash-lem-item">
        <div class="dash-lem-icon">🔔</div>
        <div class="dash-lem-info">
          <div class="dash-lem-msg">${l.mensagem || l.descricao || '—'}</div>
          <div class="dash-lem-data">${data}${hora ? ' às ' + hora : ''}</div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('[DASH] Erro carregarProximosLembretes:', err);
    el.innerHTML = '<p class="empty-hint">Erro ao carregar.</p>';
  }
}

// ── FAB Speed Dial ──────────────────────────────────────────────────────────
function toggleFab() {
  const menu = document.getElementById('fab-menu');
  const btn = document.getElementById('fab-btn');
  menu.classList.toggle('hidden');
  btn.classList.toggle('open');
}
function fecharFab() {
  document.getElementById('fab-menu')?.classList.add('hidden');
  document.getElementById('fab-btn')?.classList.remove('open');
}

// ── Transações ────────────────────────────────────────────────────────────────
async function carregarTransacoes() {
  const e = estado.tx;
  document.getElementById('tx-mes-label').textContent = MESES[e.mes - 1] + ' ' + e.ano;

  const mesStr = String(e.mes).padStart(2, '0');
  const ultimoDia = new Date(e.ano, e.mes, 0).getDate();
  const dataInicio = `${e.ano}-${mesStr}-01`;
  const dataFim = `${e.ano}-${mesStr}-${String(ultimoDia).padStart(2, '0')}`;

  const params = new URLSearchParams({ dataInicio, dataFim, limite: 200 });
  if (e.filtroStatus) params.set('status', e.filtroStatus);
  if (e.filtroTipo) params.set('tipo', e.filtroTipo);
  if (e.busca) params.set('descricao', e.busca);
  if (e.filtroRecorrente) params.set('recorrente', '1');

  let transacoes;
  try { transacoes = await api('/api/transactions?' + params); }
  catch (err) { if (err.message !== 'Sessão expirada') toast('Erro ao carregar transações', 'error'); return; }

  renderTabelaTransacoes(transacoes);
}

function renderTabelaTransacoes(transacoes) {
  const tbody = document.getElementById('tx-tbody');
  const empty = document.getElementById('tx-empty');
  const POR_PAG = 20;
  const pagina = estado.tx.pagina;
  const total = transacoes.length;
  const pagina_items = transacoes.slice((pagina - 1) * POR_PAG, pagina * POR_PAG);

  tbody.innerHTML = '';
  empty.classList.add('hidden');

  if (!total) {
    empty.classList.remove('hidden');
    document.getElementById('tx-pagination').innerHTML = '';
    return;
  }

  for (const t of pagina_items) {
    const tr = document.createElement('tr');
    const isReceita = t.tipo === 'receita';
    tr.innerHTML = `
      <td>${fmtData(t.data)}</td>
      <td><span class="tx-icon-inline">${iconeTx(t.descricao, t.categoria, t.tipo)}</span> <strong>${esc(t.descricao)}</strong>${t.recorrencia_id ? ' <span title="Recorrente" style="font-size:11px;opacity:.6">🔄</span>' : ''}</td>
      <td><span style="font-size:12px;color:var(--text-muted)">${esc(t.categoria || '—')}</span></td>
      <td class="text-right ${isReceita ? 'valor-positivo' : 'valor-negativo'}">${isReceita ? '+' : '-'}${fmtMoeda(t.valor)}</td>
      <td>${t.projetado
        ? `<span class="badge badge-projetado">${isReceita ? 'Previsto' : 'Previsto'}</span>`
        : `<span class="badge badge-${t.status}">${t.status === 'pago' ? (isReceita ? 'Recebido' : 'Pago') : (isReceita ? 'A Receber' : 'A Pagar')}</span>`
      }</td>
      <td style="white-space:nowrap">
        ${!t.projetado && t.status === 'pendente' ? `<button class="action-btn" title="${isReceita ? 'Marcar como recebido' : 'Marcar como pago'}" onclick="pagarTransacao(${t.id})">✅</button>` : ''}
        ${!t.projetado ? `<button class="action-btn" title="Editar" onclick='abrirModalEditar(${JSON.stringify({id:t.id,descricao:t.descricao,categoria:t.categoria||"",valor:t.valor,data:t.data,conta_id:t.conta_id||null})})'>✏️</button>` : ''}
        ${t.projetado
          ? `<button class="action-btn" title="Excluir" onclick="excluirProjetado(${t.recorrencia_id}, '${esc(t.descricao)}', '${t.data}')">🗑️</button>`
          : `<button class="action-btn" title="Excluir" onclick="excluirTransacao(${t.id})">🗑️</button>`
        }
      </td>
    `;
    tbody.appendChild(tr);
  }

  // ── Totais (calculados sobre TODAS as transações, não só a página atual)
  const elTotais = document.getElementById('tx-totais');
  const totalReceitas = transacoes.filter(t => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0);
  const totalDespesas = transacoes.filter(t => t.tipo === 'despesa').reduce((s, t) => s + t.valor, 0);
  const temReceita = totalReceitas > 0;
  const temDespesa = totalDespesas > 0;

  if (!temReceita && !temDespesa) {
    elTotais.classList.add('hidden');
  } else {
    elTotais.classList.remove('hidden');
    let html = '';

    if (temReceita) {
      html += `<div class="tx-totais-item">
        <span class="tx-totais-label">Receitas</span>
        <span class="tx-totais-valor valor-positivo">+${fmtMoeda(totalReceitas)}</span>
      </div>`;
    }
    if (temReceita && temDespesa) {
      html += `<div class="tx-totais-sep"></div>`;
    }
    if (temDespesa) {
      html += `<div class="tx-totais-item">
        <span class="tx-totais-label">Despesas</span>
        <span class="tx-totais-valor valor-negativo">-${fmtMoeda(totalDespesas)}</span>
      </div>`;
    }
    if (temReceita && temDespesa) {
      const saldo = totalReceitas - totalDespesas;
      const cls = saldo >= 0 ? 'tx-totais-saldo-pos' : 'tx-totais-saldo-neg';
      const sinal = saldo >= 0 ? '+' : '-';
      html += `<div class="tx-totais-sep"></div>
      <div class="tx-totais-item">
        <span class="tx-totais-label">Saldo do período</span>
        <span class="tx-totais-valor ${cls}">${sinal}${fmtMoeda(Math.abs(saldo))}</span>
      </div>`;
    }
    elTotais.innerHTML = html;
  }

  const totalPags = Math.ceil(total / POR_PAG);
  const pag = document.getElementById('tx-pagination');
  pag.innerHTML = '';
  if (totalPags <= 1) return;
  for (let i = 1; i <= totalPags; i++) {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (i === pagina ? ' active' : '');
    btn.textContent = i;
    btn.onclick = () => { estado.tx.pagina = i; carregarTransacoes(); };
    pag.appendChild(btn);
  }
}

async function pagarTransacao(id) {
  try {
    await api(`/api/transactions/${id}/pagar`, { method: 'PUT' });
    toast('✅ Marcada como paga!', 'success');
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

let _categoriasCache = null;
async function carregarCategoriasSelect() {
  if (!_categoriasCache) {
    try { _categoriasCache = await api('/api/categories'); } catch { _categoriasCache = []; }
  }
  const sel = document.getElementById('editar-tx-categoria');
  sel.innerHTML = _categoriasCache.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

async function abrirModalEditar(tx) {
  await carregarCategoriasSelect();
  await _carregarContasSelect('editar-tx-conta');
  document.getElementById('editar-tx-id').value = tx.id;
  document.getElementById('editar-tx-descricao').value = tx.descricao;
  document.getElementById('editar-tx-valor').value = tx.valor;
  document.getElementById('editar-tx-data').value = tx.data;
  const sel = document.getElementById('editar-tx-categoria');
  sel.value = tx.categoria;
  if (!sel.value && tx.categoria) {
    sel.innerHTML += `<option value="${esc(tx.categoria)}">${esc(tx.categoria)}</option>`;
    sel.value = tx.categoria;
  }
  const contaSel = document.getElementById('editar-tx-conta');
  if (contaSel && tx.conta_id) contaSel.value = tx.conta_id;
  document.getElementById('modal-editar-tx').classList.remove('hidden');
}

function fecharModalEditar() {
  document.getElementById('modal-editar-tx').classList.add('hidden');
}

async function salvarEdicaoTx() {
  const id = parseInt(document.getElementById('editar-tx-id').value);
  const conta_id = document.getElementById('editar-tx-conta').value;
  const campos = {
    descricao: document.getElementById('editar-tx-descricao').value.trim(),
    categoria: document.getElementById('editar-tx-categoria').value,
    valor: parseFloat(document.getElementById('editar-tx-valor').value),
    data: document.getElementById('editar-tx-data').value,
    conta_id: conta_id ? parseInt(conta_id) : null,
  };
  if (!campos.descricao) { toast('Descrição não pode ser vazia', 'error'); return; }
  if (!campos.valor || campos.valor <= 0) { toast('Valor inválido', 'error'); return; }
  if (!campos.data) { toast('Data inválida', 'error'); return; }
  if (!campos.conta_id) { toast('Selecione uma conta', 'error'); return; }
  try {
    for (const [campo, novo_valor] of Object.entries(campos)) {
      await api(`/api/transactions/${id}`, { method: 'PUT', body: JSON.stringify({ campo, novo_valor }) });
    }
    toast('✅ Transação atualizada!', 'success');
    fecharModalEditar();
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirTransacao(id) {
  if (!confirm('Deseja excluir esta transação?')) return;
  const jwt = getJwt() || '';
  try {
    const res = await fetch(`/api/transactions/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
    });
    if (res.status === 409) {
      const data = await res.json();
      if (data.recorrente) {
        const opcao = await mostrarModalRecorrencia(data.descricao);
        if (!opcao) return;
        if (opcao === 'apenas_este') {
          await api(`/api/transactions/${id}?modo=apenas_este`, { method: 'DELETE' });
        } else {
          await api(`/api/recurrences/${data.recorrencia_id}`, { method: 'DELETE' });
        }
        toast('Transação excluída.', 'success');
        carregarTransacoes();
        if (tabAtual === 'dashboard') carregarDashboard();
        return;
      }
    }
    if (res.status === 401) { clearJwt(); mostrarLogin(); return; }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.erro || 'Erro ao excluir', 'error');
      return;
    }
    toast('Transação excluída.', 'success');
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirProjetado(recorrenciaId, descricao, data) {
  const opcao = await mostrarModalRecorrencia(descricao);
  if (!opcao) return;
  try {
    if (opcao === 'apenas_este') {
      await api('/api/transactions/skip-occurrence', {
        method: 'POST',
        body: JSON.stringify({ recorrencia_id: recorrenciaId, data }),
      });
    } else {
      await api(`/api/recurrences/${recorrenciaId}`, { method: 'DELETE' });
    }
    toast('Transação excluída.', 'success');
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Categorias ────────────────────────────────────────────────────────────────
async function carregarCategorias() {
  await Promise.all([carregarContas(), carregarCartoes(), carregarOrcamento(), carregarCaixinhas()]);
}

// ── Contas ───────────────────────────────────────────────────────────────────
let _contasCache = [];

async function carregarContas() {
  let contas;
  try { contas = await api('/api/contas'); }
  catch { return; }

  _contasCache = contas;

  const list = document.getElementById('contas-list');
  const empty = document.getElementById('contas-empty');
  list.innerHTML = '';

  if (!contas.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const c of contas) {
    const row = document.createElement('div');
    row.className = 'cartao-row';
    const info = [c.tipo ? c.tipo : null, c.padrao ? 'Conta padrão' : null].filter(Boolean).join(' · ');
    const botaoExcluir = c.padrao
      ? ''
      : `<button class="action-btn" title="Excluir" onclick="excluirConta(${c.id}, '${esc(c.nome)}')">🗑️</button>`;
    const botaoEditar = c.padrao
      ? ''
      : `<button class="action-btn" title="Editar" onclick='abrirModalNovaConta(${c.id})'>✏️</button>`;
    row.innerHTML = `
      <div class="cartao-info">
        <span class="cartao-nome">🏦 ${esc(c.nome)} — ${fmtMoeda(c.saldo)}</span>
        ${info ? `<span class="cartao-meta">${esc(info)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${botaoEditar}
        ${botaoExcluir}
      </div>
    `;
    list.appendChild(row);
  }
}

let _editandoConta = false;

function abrirModalNovaConta(contaId = null) {
  const conta = contaId ? _contasCache.find(c => c.id === contaId) : null;
  _editandoConta = !!conta;
  document.getElementById('modal-conta-titulo').textContent = conta ? 'Editar Conta' : 'Nova Conta';
  document.getElementById('conta-edit-id').value = conta ? conta.id : '';
  document.getElementById('conta-nome').value = conta ? conta.nome || '' : '';
  document.getElementById('conta-tipo').value = conta ? conta.tipo || '' : '';
  document.getElementById('modal-nova-conta').classList.remove('hidden');
}

function fecharModalConta() {
  document.getElementById('modal-nova-conta').classList.add('hidden');
}

async function salvarConta() {
  const nome = document.getElementById('conta-nome').value.trim();
  const tipo = document.getElementById('conta-tipo').value || null;
  if (!nome) { toast('Preencha o nome', 'error'); return; }

  try {
    if (_editandoConta) {
      const id = parseInt(document.getElementById('conta-edit-id').value);
      await api(`/api/contas/${id}`, { method: 'PUT', body: JSON.stringify({ nome, tipo }) });
      toast('Conta atualizada!', 'success');
    } else {
      await api('/api/contas', { method: 'POST', body: JSON.stringify({ nome, tipo }) });
      toast('Conta criada!', 'success');
    }
    fecharModalConta();
    carregarContas();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirConta(id, nome) {
  if (!confirm(`Excluir a conta "${nome}"?`)) return;
  try {
    await api(`/api/contas/${id}`, { method: 'DELETE' });
    toast(`Conta "${nome}" excluída com sucesso.`, 'success');
    carregarContas();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Transferência entre contas ────────────────────────────────────────────────
async function abrirModalTransferencia() {
  await carregarContas();

  const origemSel = document.getElementById('transf-origem');
  const destinoSel = document.getElementById('transf-destino');
  origemSel.innerHTML = '<option value="">Selecione...</option>';
  destinoSel.innerHTML = '<option value="">Selecione...</option>';

  for (const c of _contasCache) {
    origemSel.innerHTML += `<option value="${c.id}">${esc(c.nome)}</option>`;
    destinoSel.innerHTML += `<option value="${c.id}">${esc(c.nome)}</option>`;
  }

  document.getElementById('transf-valor').value = '';
  document.getElementById('transf-descricao').value = '';
  document.getElementById('transf-data').value = new Date().toISOString().slice(0, 10);
  document.getElementById('modal-transferencia').classList.remove('hidden');
}

function fecharModalTransferencia() {
  document.getElementById('modal-transferencia').classList.add('hidden');
}

async function salvarTransferencia() {
  const conta_origem_id = parseInt(document.getElementById('transf-origem').value);
  const conta_destino_id = parseInt(document.getElementById('transf-destino').value);
  const valor = parseFloat(document.getElementById('transf-valor').value);
  const descricao = document.getElementById('transf-descricao').value.trim() || null;
  const data = document.getElementById('transf-data').value || null;

  if (!conta_origem_id || !conta_destino_id) { toast('Selecione a conta de origem e destino', 'error'); return; }
  if (conta_origem_id === conta_destino_id) { toast('Conta de origem e destino não podem ser a mesma', 'error'); return; }
  if (!valor || valor <= 0) { toast('Valor inválido', 'error'); return; }

  try {
    await api('/api/transferencias', {
      method: 'POST',
      body: JSON.stringify({ conta_origem_id, conta_destino_id, valor, descricao, data }),
    });
    toast('Transferência realizada!', 'success');
    fecharModalTransferencia();
    carregarContas();
  } catch (err) { toast(err.message, 'error'); }
}

async function carregarCartoes() {
  let cartoes;
  try { cartoes = await api('/api/cartoes'); }
  catch { return; }

  const list = document.getElementById('cartoes-list');
  const empty = document.getElementById('cartoes-empty');
  list.innerHTML = '';

  if (!cartoes.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const c of cartoes) {
    const row = document.createElement('div');
    row.className = 'cartao-row';
    const fechamento = c.dia_fechamento ? `Fecha dia ${c.dia_fechamento}` : '';
    const vencimento = c.dia_vencimento ? `Vence dia ${c.dia_vencimento}` : '';
    const limite = c.limite_total ? `Limite ${fmtMoeda(c.limite_total)}` : '';
    const info = [fechamento, vencimento, limite].filter(Boolean).join(' · ');
    row.innerHTML = `
      <div class="cartao-info">
        <span class="cartao-nome">💳 ${esc(c.nome)}</span>
        ${info ? `<span class="cartao-meta">${esc(info)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="action-btn" title="Editar" onclick='abrirModalEditarCartao(${JSON.stringify({id:c.id,nome:c.nome,limite_total:c.limite_total,dia_fechamento:c.dia_fechamento,dia_vencimento:c.dia_vencimento})})'>✏️</button>
        <button class="action-btn" title="Excluir" onclick="excluirCartao(${c.id}, '${esc(c.nome)}')">🗑️</button>
      </div>
    `;
    list.appendChild(row);
  }
}

async function excluirCartao(id, nome) {
  if (!confirm(`Excluir o cartão "${nome}" e TODOS os seus registros?\n\nIsso irá apagar todas as transações, recorrências e lembretes vinculados. Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/api/cartoes/${id}`, { method: 'DELETE' });
    toast(`Cartão "${nome}" excluído com sucesso.`, 'success');
    carregarCartoes();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Orçamento Mensal ──────────────────────────────────────────────────────────
let _orcamentoData = { salario: 0, limites: [], categoriasPrincipais: [] };

async function carregarOrcamento() {
  try {
    const [salarioRes, limites, catsPrincipais] = await Promise.all([
      api('/api/salario'),
      api('/api/limites'),
      api('/api/categorias-principais'),
    ]);
    _orcamentoData = {
      salario: salarioRes.salario || 0,
      limites,
      categoriasPrincipais: catsPrincipais || [],
    };
    renderOrcamento();
    renderSubcategorias();
  } catch { /* silencioso se não tem dados */ }
}

// ── Categorias Principais (slider percentual que soma 100%) ──────────────────
function renderOrcamento() {
  const container = document.getElementById('orcamento-container');
  const salarioBar = document.getElementById('orcamento-salario');
  const saldoEl = document.getElementById('orcamento-saldo');
  const btnSalvar = document.getElementById('orcamento-salvar');
  const { salario, categoriasPrincipais } = _orcamentoData;

  if (!salario || salario <= 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">Configure seu salário pelo Finanças em Dia para usar o orçamento.</p>';
    salarioBar.classList.add('hidden');
    saldoEl.classList.add('hidden');
    btnSalvar.classList.add('hidden');
    return;
  }

  salarioBar.classList.remove('hidden');
  salarioBar.innerHTML = `💰 <strong>Salário:</strong> ${fmtMoeda(salario)}`;

  if (categoriasPrincipais.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">Nenhuma categoria principal definida. Use o Finanças em Dia ou crie abaixo.</p>';
    saldoEl.classList.add('hidden');
    btnSalvar.classList.add('hidden');
    return;
  }

  let html = '';
  for (const cat of categoriasPrincipais) {
    const valor = Math.round(salario * (cat.percentual / 100));
    html += `<div class="orcamento-card">`;
    html += `<div class="orcamento-card-header">`;
    html += `<span class="orcamento-cat-nome">${esc(cat.nome)}</span>`;
    html += `<div style="display:flex;align-items:center;gap:8px">`;
    html += `<span class="orcamento-cat-valor" id="principal-val-${cat.id}">${fmtMoeda(valor)} (${cat.percentual}%)</span>`;
    html += `<button class="cat-del" title="Excluir" onclick="excluirCategoriaPrincipal(${cat.id}, '${esc(cat.nome)}')">🗑️</button>`;
    html += `</div></div>`;
    html += `<input type="range" class="orcamento-slider" min="0" max="100" step="1" value="${cat.percentual}" data-id="${cat.id}" oninput="atualizarSliderPrincipal(this)">`;
    html += `</div>`;
  }
  container.innerHTML = html;
  recalcularSaldo();
}

function atualizarSliderPrincipal(slider) {
  const id = parseInt(slider.dataset.id, 10);
  const pct = parseFloat(slider.value);
  const cat = _orcamentoData.categoriasPrincipais.find(c => c.id === id);
  if (cat) cat.percentual = pct;
  const valor = Math.round(_orcamentoData.salario * (pct / 100));
  const valEl = document.getElementById(`principal-val-${id}`);
  if (valEl) valEl.textContent = `${fmtMoeda(valor)} (${pct}%)`;
  recalcularSaldo();
}

function recalcularSaldo() {
  const saldoEl = document.getElementById('orcamento-saldo');
  const btnSalvar = document.getElementById('orcamento-salvar');
  const { categoriasPrincipais } = _orcamentoData;
  const somaPct = categoriasPrincipais.reduce((s, c) => s + c.percentual, 0);
  const diff = 100 - somaPct;

  saldoEl.classList.remove('hidden');
  btnSalvar.classList.remove('hidden');

  if (Math.abs(diff) < 1) {
    saldoEl.innerHTML = `✅ Orçamento equilibrado (100%)`;
    saldoEl.className = 'orcamento-saldo orcamento-saldo-ok';
    btnSalvar.disabled = false;
  } else if (diff > 0) {
    saldoEl.innerHTML = `💡 Sobram <strong>${diff}%</strong> — distribua entre as categorias`;
    saldoEl.className = 'orcamento-saldo orcamento-saldo-sobra';
    btnSalvar.disabled = false;
  } else {
    saldoEl.innerHTML = `🚨 Excede em <strong>${Math.abs(diff)}%</strong> — reduza alguma categoria`;
    saldoEl.className = 'orcamento-saldo orcamento-saldo-falta';
    btnSalvar.disabled = true;
  }
}

async function salvarOrcamento() {
  const categorias = _orcamentoData.categoriasPrincipais.map((c, i) => ({
    id: c.id,
    nome: c.nome,
    percentual: c.percentual,
    ordem: i,
  }));
  // Salvar categorias principais (percentuais)
  try {
    await api('/api/categorias-principais', { method: 'PUT', body: JSON.stringify({ categorias }) });
  } catch (err) { toast(err.message, 'error'); return; }

  // Também salvar os limites absolutos (baseados no salário atual) para compatibilidade com o WhatsApp
  const limites = categorias.map(c => ({
    categoria: c.nome,
    valor_limite: Math.round(_orcamentoData.salario * (c.percentual / 100)),
    parent: null,
  }));
  try {
    await api('/api/limites', { method: 'PUT', body: JSON.stringify({ limites }) });
    toast('✅ Categorias salvas!', 'success');
    renderSubcategorias();
  } catch (err) { toast(err.message, 'error'); }
}

async function criarCategoriaPrincipal() {
  const input = document.getElementById('catprincipal-nova-nome');
  const nome = input.value.trim();
  if (!nome) { toast('Digite o nome da categoria', 'error'); return; }
  try {
    await api('/api/categorias-principais', {
      method: 'POST',
      body: JSON.stringify({ nome, percentual: 0, ordem: _orcamentoData.categoriasPrincipais.length }),
    });
    input.value = '';
    toast('✅ Categoria criada!', 'success');
    await carregarOrcamento();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirCategoriaPrincipal(id, nome) {
  if (!confirm(`Excluir a categoria principal "${nome}"?`)) return;
  try {
    await api(`/api/categorias-principais/${id}`, { method: 'DELETE' });
    toast('Categoria excluída.', 'success');
    await carregarOrcamento();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Subcategorias (slider zero-sum com limite da principal) ──────────────
function _getLimitePrincipal(categoria) {
  const cat = _orcamentoData.categoriasPrincipais.find(c => c.nome === categoria);
  if (cat) return Math.round(_orcamentoData.salario * (cat.percentual / 100));
  const lim = _orcamentoData.limites.find(l => l.categoria === categoria);
  return lim ? lim.valor_limite : 0;
}

function _populateParentSelect() {
  const sel = document.getElementById('sub-parent-select');
  if (!sel) return;
  const { categoriasPrincipais } = _orcamentoData;
  sel.innerHTML = '<option value="">Categoria...</option>';
  for (const cat of categoriasPrincipais) {
    sel.innerHTML += `<option value="${esc(cat.nome)}">${esc(cat.nome)}</option>`;
  }
}

// Build internal map: every principal category with its subs
function _buildSubMap() {
  const { limites, categoriasPrincipais } = _orcamentoData;
  const grupoMap = {};
  for (const cat of categoriasPrincipais) {
    grupoMap[cat.nome] = { valor_limite: _getLimitePrincipal(cat.nome), subs: [] };
  }
  for (const g of limites) {
    if (grupoMap[g.categoria]) {
      grupoMap[g.categoria].subs = (g.subs || []).slice();
    }
  }
  return grupoMap;
}

function renderSubcategorias() {
  const container = document.getElementById('subcategorias-container');
  const btnSalvar = document.getElementById('subcategorias-salvar');
  const { categoriasPrincipais, salario } = _orcamentoData;

  _populateParentSelect();

  if (categoriasPrincipais.length === 0 || !salario || salario <= 0) {
    container.innerHTML = '<p style="color:var(--text-muted)">Defina as categorias principais e o salário primeiro.</p>';
    btnSalvar.classList.add('hidden');
    return;
  }

  const grupoMap = _buildSubMap();
  const temSubs = Object.values(grupoMap).some(g => g.subs.length > 0);

  btnSalvar.classList.toggle('hidden', !temSubs);
  let html = '';

  for (const [catNome, g] of Object.entries(grupoMap)) {
    const maxVal = g.valor_limite;

    html += `<div class="orcamento-card">`;
    html += `<div class="orcamento-card-header">`;
    html += `<span class="orcamento-cat-nome">${esc(catNome)}</span>`;
    html += `<span class="orcamento-cat-valor">${fmtMoeda(maxVal)}</span>`;
    html += `</div>`;

    if (g.subs.length > 0) {
      for (const sub of g.subs) {
        const pct = maxVal > 0 ? Math.round((sub.valor_limite / maxVal) * 100) : 0;
        html += `<div class="orcamento-sub-row">`;
        html += `<span class="orcamento-sub-nome">${esc(sub.categoria)}</span>`;
        html += `<input type="range" class="orcamento-slider-sub" min="0" max="${maxVal}" step="10" value="${sub.valor_limite}" data-cat="${esc(sub.categoria)}" data-parent="${esc(catNome)}" oninput="atualizarSliderSub(this)">`;
        html += `<span class="orcamento-sub-valor" id="sub-val-${esc(sub.categoria)}">${fmtMoeda(sub.valor_limite)} (${pct}%)</span>`;
        html += `<button class="cat-del" title="Excluir" onclick="excluirSubcategoria('${esc(sub.categoria)}', '${esc(catNome)}')">🗑️</button>`;
        html += `</div>`;
      }
      html += `<div class="orcamento-sub-livre" id="livre-${esc(catNome)}"></div>`;
    } else {
      html += `<p style="color:var(--text-muted);font-size:12px;margin:4px 0 0">Nenhuma subcategoria</p>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;
  for (const [catNome, g] of Object.entries(grupoMap)) {
    if (g.subs.length > 0) recalcularLivreSub(catNome);
  }
}

function atualizarSliderSub(slider) {
  const cat = slider.dataset.cat;
  const parent = slider.dataset.parent;
  const val = parseFloat(slider.value);

  // Update in-memory data
  const g = _orcamentoData.limites.find(l => l.categoria === parent);
  if (g) {
    const sub = g.subs.find(s => s.categoria === cat);
    if (sub) sub.valor_limite = val;
  }

  const parentVal = _getLimitePrincipal(parent);
  const pct = parentVal > 0 ? Math.round((val / parentVal) * 100) : 0;
  const valEl = document.getElementById(`sub-val-${cat}`);
  if (valEl) valEl.textContent = `${fmtMoeda(val)} (${pct}%)`;
  recalcularLivreSub(parent);

  document.getElementById('subcategorias-salvar').classList.remove('hidden');
}

function recalcularLivreSub(parentCat) {
  const grupoMap = _buildSubMap();
  const g = grupoMap[parentCat];
  if (!g || g.subs.length === 0) return;

  // Use in-memory values (may have been adjusted by sliders)
  const limG = _orcamentoData.limites.find(l => l.categoria === parentCat);
  const subs = limG ? limG.subs : g.subs;
  const somaSubs = subs.reduce((s, sub) => s + sub.valor_limite, 0);
  const livre = g.valor_limite - somaSubs;
  const el = document.getElementById(`livre-${parentCat}`);
  if (!el) return;

  if (livre >= 0) {
    el.innerHTML = `<span style="color:var(--green)">💡 Livre: ${fmtMoeda(livre)}</span>`;
    el.className = 'orcamento-sub-livre';
  } else {
    el.innerHTML = `<span style="color:var(--red)">🚨 Excedido em ${fmtMoeda(Math.abs(livre))}</span>`;
    el.className = 'orcamento-sub-livre orcamento-sub-excedido';
  }
}

async function salvarSubcategorias() {
  const limites = [];
  for (const g of _orcamentoData.limites) {
    for (const sub of g.subs) {
      limites.push({ categoria: sub.categoria, valor_limite: sub.valor_limite, parent: g.categoria });
    }
  }
  try {
    await api('/api/limites', { method: 'PUT', body: JSON.stringify({ limites }) });
    toast('✅ Subcategorias salvas!', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function criarSubcategoria() {
  const select = document.getElementById('sub-parent-select');
  const input = document.getElementById('sub-nova-nome');
  const parent = select.value;
  const nome = input.value.trim();

  if (!parent) { toast('Selecione uma categoria principal', 'error'); return; }
  if (!nome) { toast('Digite um nome para a subcategoria', 'error'); return; }

  try {
    await api('/api/subcategorias', {
      method: 'POST',
      body: JSON.stringify({ nome, parent }),
    });
    input.value = '';
    toast('✅ Subcategoria criada!', 'success');
    await carregarOrcamento();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirSubcategoria(nome, parent) {
  if (!confirm(`Excluir a subcategoria "${nome}" de "${parent}"?`)) return;
  try {
    await api('/api/subcategorias/' + encodeURIComponent(nome), { method: 'DELETE' });
    toast('Subcategoria excluída.', 'success');
    await carregarOrcamento();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Agenda ────────────────────────────────────────────────────────────────────
async function carregarAgenda() {
  const { mes, ano } = estado.ag;
  document.getElementById('ag-mes-label').textContent = MESES[mes - 1] + ' ' + ano;

  let lembretes;
  try { lembretes = await api(`/api/agenda?mes=${mes}&ano=${ano}`); }
  catch { toast('Erro ao carregar agenda', 'error'); return; }

  const list = document.getElementById('ag-list');
  const empty = document.getElementById('ag-empty');
  list.innerHTML = '';
  empty.classList.add('hidden');

  if (!lembretes.length) { empty.classList.remove('hidden'); return; }

  for (const l of lembretes) {
    const item = document.createElement('div');
    item.className = 'ag-item';
    const icone = l.recorrente ? '🔄' : '🔔';
    const badge = l.recorrente ? '<span class="ag-badge-rec">Recorrente</span>' : '';
    item.innerHTML = `
      <span class="ag-icon">${icone}</span>
      <div class="ag-info">
        <div class="ag-data">📅 ${esc(l.horario || l.data_disparo || '—')} ${badge}</div>
        <div class="ag-msg">${esc(l.mensagem)}</div>
      </div>
      <button class="action-btn" title="Excluir" onclick="excluirLembreteConfirm(${l.id}, ${!!l.recorrente})">🗑️</button>
    `;
    list.appendChild(item);
  }
}

// ── Admin — Envio Individual ──────────────────────────────────────────────────

const admInd = { pagina: 1, ppp: 10, busca: '' };

function renderEnvioIndividual() {
  const lista = admUsuarios.filter(u =>
    !u.usuario_id.includes('@lid') && (
      (u.nome || '').toLowerCase().includes(admInd.busca) ||
      (u.usuario_id || '').toLowerCase().includes(admInd.busca)
    )
  );

  const total = lista.length;
  const totalPags = Math.max(1, Math.ceil(total / admInd.ppp));
  if (admInd.pagina > totalPags) admInd.pagina = 1;

  const inicio = (admInd.pagina - 1) * admInd.ppp;
  const pagina_items = lista.slice(inicio, inicio + admInd.ppp);

  const listaEl = document.getElementById('adm-ind-lista');
  listaEl.innerHTML = '';

  if (!pagina_items.length) {
    listaEl.innerHTML = '<div class="empty-state">Nenhum usuário encontrado.</div>';
    document.getElementById('adm-ind-pag').innerHTML = '';
    return;
  }

  for (const u of pagina_items) {
    const uid = u.usuario_id;
    const nome = u.nome || '—';
    const numero = uid.replace('@c.us', '').replace(/^55/, '');
    const item = document.createElement('div');
    item.className = 'adm-ind-item';
    item.dataset.uid = uid;
    item.innerHTML = `
      <div class="adm-ind-info">
        <span class="adm-ind-nome">${esc(nome)}</span>
        <span class="adm-ind-num">${esc(numero)}</span>
        <span class="adm-ind-status">${statusLabel(u.status, u.pausado)}</span>
      </div>
      <button class="btn btn-sm btn-blue adm-ind-btn-abrir" onclick="toggleEnvioIndForm('${esc(uid)}')">✉️ Enviar</button>
      <div class="adm-ind-form hidden" id="adm-ind-form-${esc(uid)}">
        <textarea class="adm-ind-textarea" placeholder="Mensagem para ${esc(nome)}..." rows="3"></textarea>
        <button class="btn btn-sm btn-green" onclick="enviarIndividual('${esc(uid)}', '${esc(nome)}', this)">📤 Enviar</button>
      </div>
    `;
    listaEl.appendChild(item);
  }

  // Paginação
  const pagEl = document.getElementById('adm-ind-pag');
  pagEl.innerHTML = '';
  if (totalPags <= 1) return;

  const addBtn = (label, ativo, onclick) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (ativo ? ' active' : '');
    btn.textContent = label;
    btn.onclick = onclick;
    pagEl.appendChild(btn);
  };

  addBtn('‹', false, () => { if (admInd.pagina > 1) { admInd.pagina--; renderEnvioIndividual(); } });
  const span = document.createElement('span');
  span.style.cssText = 'font-size:13px;color:var(--text-muted);padding:0 4px';
  span.textContent = `${admInd.pagina} / ${totalPags}`;
  pagEl.appendChild(span);
  addBtn('›', false, () => { if (admInd.pagina < totalPags) { admInd.pagina++; renderEnvioIndividual(); } });
}

function toggleEnvioIndForm(uid) {
  const formEl = document.getElementById('adm-ind-form-' + uid);
  if (!formEl) return;
  formEl.classList.toggle('hidden');
  if (!formEl.classList.contains('hidden')) {
    formEl.querySelector('textarea')?.focus();
  }
}

async function enviarIndividual(usuarioId, nome, btn) {
  const formEl = document.getElementById('adm-ind-form-' + usuarioId);
  const textarea = formEl?.querySelector('textarea');
  const mensagem = textarea?.value.trim();
  if (!mensagem) { toast('Digite uma mensagem', 'error'); return; }

  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    await api('/api/admin/enviar-individual', {
      method: 'POST',
      body: JSON.stringify({ usuarioId, mensagem }),
    });
    toast(`✅ Mensagem enviada para ${nome}`, 'success');
    textarea.value = '';
    formEl.classList.add('hidden');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📤 Enviar';
  }
}

// ── Admin ─────────────────────────────────────────────────────────────────────

let admUsuarios = [];

function statusLabel(status, pausado) {
  if (pausado) return '⏸️ Pausado';
  const map = { trial: '🟡 Trial', ativo: '🟢 Ativo', graca: '🟠 Carência', expirado: '🔴 Expirado' };
  return map[status] || status || '—';
}

function fmtValidade(u) {
  if (u.pago_ate) return fmtData(u.pago_ate);
  if (u.trial_fim) return 'Trial até ' + fmtData(u.trial_fim.slice(0, 10));
  return '—';
}

async function carregarAdmin() {
  await Promise.all([carregarAdminUsuarios(), carregarAdminCupons(), carregarAdminCrons()]);
}

async function carregarAdminUsuarios() {
  try {
    admUsuarios = await api('/api/admin/usuarios');
    renderAdminUsuarios(admUsuarios);
    renderEnvioIndividual();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function carregarAdminCupons() {
  try {
    const cupons = await api('/api/admin/cupons');
    const tbody = document.getElementById('adm-cupons-tbody');
    const empty = document.getElementById('adm-cupons-empty');
    if (!cupons.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    tbody.innerHTML = cupons.map(c => `
      <tr>
        <td><strong>${esc(c.codigo)}</strong></td>
        <td>${c.tipo === 'dias_gratis' ? '🎁 Dias Grátis' : '💸 Desconto %'}</td>
        <td>${c.tipo === 'dias_gratis' ? c.valor + ' dias' : c.valor + '%'}</td>
        <td>${c.usos} / ${c.uso_maximo}</td>
        <td>${c.valido_ate ? fmtData(c.valido_ate) : '—'}</td>
        <td><span class="badge ${c.ativo ? 'badge-pago' : 'badge-pendente'}">${c.ativo ? 'Ativo' : 'Inativo'}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Admin Crons ──────────────────────────────────────────────────────────────

const REGRA_LABELS = {
  ativos_x_dias: 'Ativos (últimos X dias)',
  inativos_x_dias: 'Inativos (há X dias)',
  nao_pagantes: 'Não pagantes',
  trial: 'Em teste',
  expirados: 'Expirados',
  graca: 'Em carência',
  dias_apos_acesso: 'Dias após acesso',
  manual: 'Seleção manual',
};

const REGRAS_COM_VALOR = ['ativos_x_dias', 'inativos_x_dias', 'dias_apos_acesso'];

const FREQ_LABELS = {
  cada_30min: 'A cada 30 min',
  cada_1h: 'A cada 1 hora',
  cada_2h: 'A cada 2 horas',
  cada_4h: 'A cada 4 horas',
  cada_6h: 'A cada 6 horas',
  cada_12h: 'A cada 12 horas',
  todo_dia: 'Todo dia',
  cada_2dias: 'A cada 2 dias',
  cada_3dias: 'A cada 3 dias',
  semanal: 'Semanal',
};

// Frequências >= diárias mostram horário
const FREQ_COM_HORARIO = ['todo_dia', 'cada_2dias', 'cada_3dias', 'semanal'];

function fmtDataHora(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

async function carregarAdminCrons() {
  try {
    const crons = await api('/api/admin/crons');
    const tbody = document.getElementById('adm-crons-tbody');
    const empty = document.getElementById('adm-crons-empty');
    if (!crons.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    tbody.innerHTML = crons.map(c => {
      const regraLabel = REGRA_LABELS[c.regra] || c.regra;
      const regraDetalhe = REGRAS_COM_VALOR.includes(c.regra) && c.regra_valor
        ? `${regraLabel.replace('X', c.regra_valor)}`
        : regraLabel;
      return `
      <tr>
        <td><strong>${esc(c.titulo)}</strong></td>
        <td style="font-size:12px">${esc(regraDetalhe)}</td>
        <td style="font-size:12px">${esc(FREQ_LABELS[c.frequencia] || c.frequencia)}${c.horario ? ' às ' + esc(c.horario) : ''}</td>
        <td style="font-size:12px">${fmtDataHora(c.ultimo_envio)}<br><span style="color:var(--text-muted)">${c.total_enviados} enviados</span></td>
        <td><span class="badge ${c.ativo ? 'badge-pago' : 'badge-pendente'}">${c.ativo ? 'Ativa' : 'Inativa'}</span></td>
        <td>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            <button class="btn btn-sm" onclick="cronToggle(${c.id}, ${!c.ativo})" title="${c.ativo ? 'Desativar' : 'Ativar'}">${c.ativo ? '⏸️' : '▶️'}</button>
            <button class="btn btn-sm" onclick="cronExecutar(${c.id})" title="Executar agora">🚀</button>
            <button class="btn btn-sm" onclick="cronEditar(${c.id})" title="Editar">✏️</button>
            <button class="btn btn-sm" onclick="cronExcluir(${c.id})" title="Excluir" style="color:#e74c3c">🗑️</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

let _cronsCache = [];

async function cronToggle(id, ativo) {
  try {
    await api(`/api/admin/crons/${id}`, { method: 'PUT', body: JSON.stringify({ ativo }) });
    toast(ativo ? '▶️ Cron ativada' : '⏸️ Cron desativada', 'success');
    carregarAdminCrons();
  } catch (err) { toast(err.message, 'error'); }
}

async function cronExecutar(id) {
  if (!confirm('Executar esta cron agora? As mensagens serão enviadas imediatamente.')) return;
  try {
    await api(`/api/admin/crons/${id}/executar`, { method: 'POST' });
    toast('🚀 Execução iniciada em background', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function cronExcluir(id) {
  if (!confirm('Tem certeza que deseja excluir esta cron?')) return;
  try {
    await api(`/api/admin/crons/${id}`, { method: 'DELETE' });
    toast('🗑️ Cron excluída', 'success');
    carregarAdminCrons();
  } catch (err) { toast(err.message, 'error'); }
}

async function cronEditar(id) {
  try {
    const crons = await api('/api/admin/crons');
    const c = crons.find(x => x.id === id);
    if (!c) return toast('Cron não encontrada', 'error');

    document.getElementById('adm-cron-edit-id').value = c.id;
    document.getElementById('adm-cron-titulo').value = c.titulo;
    document.getElementById('adm-cron-frequencia').value = c.frequencia || 'todo_dia';
    document.getElementById('adm-cron-horario').value = c.horario || '10:00';
    cronAtualizarHorario(c.frequencia || 'todo_dia');
    document.getElementById('adm-cron-regra').value = c.regra;
    document.getElementById('adm-cron-valor').value = c.regra_valor || 7;
    document.getElementById('adm-cron-msg').value = c.mensagem;

    cronAtualizarCamposRegra(c.regra);

    // Se manual, popular Select2
    if (c.regra === 'manual' && c.usuario_ids && c.usuario_ids.length) {
      const sel = $('#adm-cron-usuarios');
      sel.empty();
      for (const uid of c.usuario_ids) {
        sel.append(new Option(uid, uid, true, true));
      }
      sel.trigger('change');
    }

    document.getElementById('modal-cron-titulo-header').textContent = 'Editar Cron';
    document.getElementById('modal-cron').classList.remove('hidden');
  } catch (err) { toast(err.message, 'error'); }
}

function cronAtualizarCamposRegra(regra) {
  const valorWrap = document.getElementById('adm-cron-valor-wrap');
  const manualWrap = document.getElementById('adm-cron-manual-wrap');

  if (REGRAS_COM_VALOR.includes(regra)) {
    valorWrap.style.display = '';
  } else {
    valorWrap.style.display = 'none';
  }

  if (regra === 'manual') {
    manualWrap.classList.remove('hidden');
  } else {
    manualWrap.classList.add('hidden');
  }
}

function cronLimparForm() {
  document.getElementById('adm-cron-edit-id').value = '';
  document.getElementById('adm-cron-titulo').value = '';
  document.getElementById('adm-cron-frequencia').value = 'todo_dia';
  document.getElementById('adm-cron-horario').value = '10:00';
  cronAtualizarHorario('todo_dia');
  document.getElementById('adm-cron-regra').value = 'ativos_x_dias';
  document.getElementById('adm-cron-valor').value = '7';
  document.getElementById('adm-cron-msg').value = '';
  const sel = $('#adm-cron-usuarios');
  if (sel.length) { sel.val(null).trigger('change'); }
  cronAtualizarCamposRegra('ativos_x_dias');
}

async function cronSalvar() {
  const editId = document.getElementById('adm-cron-edit-id').value;
  const titulo = document.getElementById('adm-cron-titulo').value.trim();
  const mensagem = document.getElementById('adm-cron-msg').value.trim();
  const frequencia = document.getElementById('adm-cron-frequencia').value;
  const horario = document.getElementById('adm-cron-horario').value || null;
  const regra = document.getElementById('adm-cron-regra').value;
  const regra_valor = parseInt(document.getElementById('adm-cron-valor').value) || null;
  let usuario_ids = null;

  if (!titulo || !mensagem) { toast('Preencha título e mensagem', 'error'); return; }
  if (!frequencia) { toast('Selecione a frequência', 'error'); return; }

  if (regra === 'manual') {
    usuario_ids = $('#adm-cron-usuarios').val();
    if (!usuario_ids || !usuario_ids.length) { toast('Selecione ao menos um usuário', 'error'); return; }
  }

  const body = { titulo, mensagem, frequencia, horario, regra, regra_valor, usuario_ids };

  try {
    if (editId) {
      await api(`/api/admin/crons/${editId}`, { method: 'PUT', body: JSON.stringify(body) });
      toast('✅ Cron atualizada!', 'success');
    } else {
      await api('/api/admin/crons', { method: 'POST', body: JSON.stringify(body) });
      toast('✅ Cron criada!', 'success');
    }
    fecharModalCron();
    carregarAdminCrons();
  } catch (err) { toast(err.message, 'error'); }
}

async function cronPreview() {
  const regra = document.getElementById('adm-cron-regra').value;
  const valor = document.getElementById('adm-cron-valor').value;
  const countEl = document.getElementById('adm-cron-preview-count');
  try {
    const data = await api(`/api/admin/crons/preview?regra=${regra}&valor=${valor}`);
    countEl.textContent = `${data.total} destinatário(s)`;
  } catch (err) {
    countEl.textContent = 'Erro ao carregar';
    toast(err.message, 'error');
  }
}

function cronAtualizarHorario(freq) {
  const wrap = document.getElementById('adm-cron-horario-wrap');
  if (FREQ_COM_HORARIO.includes(freq)) {
    wrap.style.display = '';
  } else {
    wrap.style.display = 'none';
  }
}

function abrirModalCron() {
  cronLimparForm();
  document.getElementById('modal-cron-titulo-header').textContent = 'Nova Cron';
  document.getElementById('modal-cron').classList.remove('hidden');
}

function fecharModalCron() {
  document.getElementById('modal-cron').classList.add('hidden');
  cronLimparForm();
}

function inicializarCronAdmin() {
  // Novo
  document.getElementById('adm-cron-novo')?.addEventListener('click', abrirModalCron);

  // Salvar e Preview
  document.getElementById('adm-cron-salvar')?.addEventListener('click', cronSalvar);
  // Toggle campos conforme regra selecionada
  document.getElementById('adm-cron-regra')?.addEventListener('change', (e) => {
    cronAtualizarCamposRegra(e.target.value);
  });

  // Toggle horário conforme frequência selecionada
  document.getElementById('adm-cron-frequencia')?.addEventListener('change', (e) => {
    cronAtualizarHorario(e.target.value);
  });

  // Select2 para seleção manual
  try {
    $('#adm-cron-usuarios').select2({
      placeholder: 'Buscar por nome ou número...',
      allowClear: true,
      minimumInputLength: 2,
      dropdownParent: $('#modal-cron .modal-box'),
      width: '100%',
      ajax: {
        url: '/api/admin/crons/usuarios-busca',
        dataType: 'json',
        delay: 300,
        headers: { 'Authorization': 'Bearer ' + (getJwt() || '') },
        data: function(params) { return { q: params.term }; },
        processResults: function(data) { return { results: data }; },
      },
    });
  } catch (_) {}

  // Fechar modal ao clicar fora
  document.getElementById('modal-cron')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-cron') fecharModalCron();
  });

  // Estado inicial dos campos
  cronAtualizarCamposRegra(document.getElementById('adm-cron-regra')?.value);
  cronAtualizarHorario(document.getElementById('adm-cron-frequencia')?.value);
}

function renderAdminUsuarios(lista) {
  const tbody = document.getElementById('adm-usuarios-tbody');
  const empty = document.getElementById('adm-usuarios-empty');
  if (!lista.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = lista.map(u => `
    <tr>
      <td>
        <div style="font-weight:600;font-size:12px">${esc(u.nome || '—')}</div>
        <div style="font-size:11px;color:var(--text-muted)">${esc(u.usuario_id)}</div>
      </td>
      <td>${statusLabel(u.status, u.pausado)}</td>
      <td style="font-size:12px">${fmtValidade(u)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${u.primeiro_contato ? fmtData(u.primeiro_contato.slice(0, 10)) : '—'}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-green" onclick="adminAtivar('${esc(u.usuario_id)}')">✅ Ativar</button>
          <button class="btn btn-sm btn-blue" onclick="adminLink('${esc(u.usuario_id)}', this)">🔗 Link</button>
          ${u.pausado
            ? `<button class="btn btn-sm btn-green" onclick="adminRetomar('${esc(u.usuario_id)}')">▶️ Retomar</button>`
            : `<button class="btn btn-sm" style="background:#e67e22;color:white" onclick="adminPausar('${esc(u.usuario_id)}')">⏸️ Pausar</button>`
          }
        </div>
      </td>
    </tr>
  `).join('');
}

async function adminAtivar(usuarioId) {
  if (!confirm(`Ativar assinatura por 30 dias para:\n${usuarioId}?`)) return;
  try {
    const r = await api('/api/admin/ativar', {
      method: 'POST',
      body: JSON.stringify({ usuarioId }),
    });
    toast('✅ Assinatura ativada até ' + fmtData(r.pagoAte), 'success');
    carregarAdminUsuarios();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminLink(usuarioId, btn) {
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const r = await api('/api/admin/link', {
      method: 'POST',
      body: JSON.stringify({ usuarioId }),
    });
    if (r.link) {
      prompt('Link de pagamento (copie):', r.link);
    } else {
      toast('InfinityPay não configurado', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔗 Link';
  }
}

async function adminPausar(usuarioId) {
  if (!confirm(`Pausar o bot para:\n${usuarioId}?\n\nO Cronos não responderá mensagens deste usuário até você retomar.`)) return;
  try {
    await api('/api/admin/pausar', {
      method: 'POST',
      body: JSON.stringify({ usuarioId }),
    });
    toast('⏸️ Bot pausado para este usuário', 'success');
    carregarAdminUsuarios();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function adminRetomar(usuarioId) {
  if (!confirm(`Retomar o bot para:\n${usuarioId}?`)) return;
  try {
    await api('/api/admin/retomar', {
      method: 'POST',
      body: JSON.stringify({ usuarioId }),
    });
    toast('▶️ Bot retomado para este usuário', 'success');
    carregarAdminUsuarios();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Navegação ─────────────────────────────────────────────────────────────────
let tabAtual = 'dashboard';

function ativarTab(tab) {
  tabAtual = tab;
  localStorage.setItem('cronos_tab_ativa', tab);
  document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'dashboard') {
    carregarDashboard();
    carregarUltimasTx();
    carregarProximosLembretes();
  }
  if (tab === 'transactions') carregarTransacoes();
  if (tab === 'categories') carregarCategorias();
  if (tab === 'agenda') carregarAgenda();
  if (tab === 'admin') carregarAdmin();
}

function abrirSettings() {
  const nome = localStorage.getItem('cronos_settings_nome') || _meNome;
  const email = localStorage.getItem('cronos_settings_email') || '';
  const nomeDisplay = document.getElementById('settings-nome-display');
  if (nomeDisplay) nomeDisplay.textContent = nome || '—';
  const inputNome = document.getElementById('settings-input-nome');
  if (inputNome) inputNome.value = nome;
  const inputEmail = document.getElementById('settings-input-email');
  if (inputEmail) inputEmail.value = email;
  _aplicarAvatar(_meNome);
  _syncThemeToggle();
  verificarGoogleStatus();
  document.getElementById('modal-settings')?.classList.remove('hidden');
}

// ── Google Calendar ───────────────────────────────────────────────────────────
async function verificarGoogleStatus() {
  try {
    const data = await api('/api/google/status');
    const on = document.getElementById('google-status-conectado');
    const off = document.getElementById('google-status-desconectado');
    if (data.conectado) {
      on?.classList.remove('hidden');
      off?.classList.add('hidden');
    } else {
      on?.classList.add('hidden');
      off?.classList.remove('hidden');
    }
  } catch {
    // Se falhar, mostra botão de conectar
  }
}

// ── Inicialização ─────────────────────────────────────────────────────────────
function inicializar() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => ativarTab(btn.dataset.tab));
  });

  // ── Avatar dropdown ──────────────────────────────────────────────────────
  const avatarEl   = document.getElementById('dash-avatar');
  const dropdown   = document.getElementById('avatar-dropdown');

  avatarEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown?.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    dropdown?.classList.add('hidden');
    // Fechar FAB se clicar fora
    const fabContainer = document.getElementById('fab-container');
    if (fabContainer && !fabContainer.contains(e.target)) fecharFab();
  });

  document.getElementById('avatar-dd-sair')?.addEventListener('click', logout);

  document.getElementById('avatar-dd-foto')?.addEventListener('click', () => {
    dropdown?.classList.add('hidden');
    document.getElementById('input-photo')?.click();
  });

  document.getElementById('input-photo')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    _comprimirImagem(file, async (dataUrl) => {
      try {
        await api('/api/auth/avatar', { method: 'POST', body: JSON.stringify({ avatarData: dataUrl }) });
        _avatarData = dataUrl;
        _aplicarAvatar(_meNome);
        toast('✅ Foto atualizada!', 'success');
      } catch (err) {
        toast('Erro ao salvar foto: ' + err.message, 'error');
      }
    });
  });

  document.getElementById('avatar-dd-config')?.addEventListener('click', () => {
    dropdown?.classList.add('hidden');
    abrirSettings();
  });

  // Desktop top-nav avatar → abre settings
  document.getElementById('nav-avatar')?.addEventListener('click', () => {
    abrirSettings();
  });

  // Toggle tema claro / escuro
  document.getElementById('theme-toggle-bar')?.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeVal));
  });

  document.getElementById('btn-settings-close')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.add('hidden');
  });

  // Google Calendar connect/disconnect
  document.getElementById('btn-google-connect')?.addEventListener('click', () => {
    window.location = '/auth/google/start?token=' + encodeURIComponent(getJwt());
  });
  document.getElementById('btn-google-disconnect')?.addEventListener('click', async () => {
    try {
      await api('/api/google/disconnect', { method: 'POST' });
      toast('Google Calendar desconectado', 'success');
      verificarGoogleStatus();
    } catch (err) {
      toast('Erro ao desconectar: ' + err.message, 'error');
    }
  });
  document.getElementById('modal-settings')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-settings'))
      document.getElementById('modal-settings').classList.add('hidden');
  });

  document.getElementById('btn-settings-salvar')?.addEventListener('click', () => {
    const nome  = document.getElementById('settings-input-nome')?.value.trim();
    const email = document.getElementById('settings-input-email')?.value.trim();
    if (nome) _meNome = nome;
    _aplicarAvatar(_meNome);
    document.getElementById('modal-settings')?.classList.add('hidden');
    toast('✅ Configurações salvas!', 'success');
  });

  document.getElementById('btn-change-photo-modal')?.addEventListener('click', () => {
    document.getElementById('input-photo')?.click();
  });

  // Dashboard: toggle saldo visível/oculto
  document.getElementById('dash-toggle-saldo')?.addEventListener('click', () => {
    _saldoOculto = !_saldoOculto;
    const saldoEl = document.getElementById('c-saldo');
    if (saldoEl) saldoEl.textContent = _saldoOculto ? '••••••' : fmtMoeda(_saldoAtual);
    // Troca ícone do olho
    const icon = document.getElementById('dash-eye-icon');
    if (icon) {
      icon.innerHTML = _saldoOculto
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    }
  });

  // Dashboard nav
  document.getElementById('dash-prev')?.addEventListener('click', () => {
    const e = estado.dash; e.mes--; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarDashboard();
  });
  document.getElementById('dash-next')?.addEventListener('click', () => {
    const e = estado.dash; e.mes++; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarDashboard();
  });

  // Alertas de atrasados → ir para transações pendentes
  document.getElementById('alert-receber')?.addEventListener('click', () => {
    const e = estado.dash;
    estado.tx.mes = e.mes; estado.tx.ano = e.ano;
    estado.tx.filtroStatus = 'pendente'; estado.tx.filtroTipo = 'receita'; estado.tx.pagina = 1;
    ativarTab('transactions');
  });
  document.getElementById('alert-pagar')?.addEventListener('click', () => {
    const e = estado.dash;
    estado.tx.mes = e.mes; estado.tx.ano = e.ano;
    estado.tx.filtroStatus = 'pendente'; estado.tx.filtroTipo = 'despesa'; estado.tx.pagina = 1;
    ativarTab('transactions');
  });

  // Transações nav
  document.getElementById('tx-prev')?.addEventListener('click', () => {
    const e = estado.tx; e.mes--; e.pagina = 1; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarTransacoes();
  });
  document.getElementById('tx-next')?.addEventListener('click', () => {
    const e = estado.tx; e.mes++; e.pagina = 1; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarTransacoes();
  });

  // Filtros transações
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      estado.tx.filtroStatus = btn.dataset.filter ?? '';
      estado.tx.filtroTipo = btn.dataset.filterTipo ?? '';
      estado.tx.filtroRecorrente = btn.dataset.filterRecorrente === '1';
      estado.tx.pagina = 1;
      carregarTransacoes();
    });
  });

  let buscaTimer;
  document.getElementById('tx-search')?.addEventListener('input', e => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(() => { estado.tx.busca = e.target.value.trim(); estado.tx.pagina = 1; carregarTransacoes(); }, 350);
  });

  // Close modals on overlay click
  ['modal-nova-tx','modal-novo-cartao','modal-nova-caixinha','modal-deposito-caixinha','modal-novo-lembrete','modal-nova-recorrencia'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => { if (e.target === el) el.classList.add('hidden'); });
  });

  // Criar subcategoria
  document.getElementById('sub-criar')?.addEventListener('click', criarSubcategoria);
  document.getElementById('sub-nova-nome')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') criarSubcategoria();
  });

  // Agenda nav
  document.getElementById('ag-prev')?.addEventListener('click', () => {
    const e = estado.ag; e.mes--; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarAgenda();
  });
  document.getElementById('ag-next')?.addEventListener('click', () => {
    const e = estado.ag; e.mes++; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarAgenda();
  });

  // Admin
  if (_isAdmin) {
    inicializarCronAdmin();

    // Favicon upload
    document.getElementById('adm-favicon-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = document.getElementById('adm-favicon-status');
      status.textContent = 'Enviando...';
      status.style.color = 'var(--text-muted)';
      try {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        const resp = await fetch('/api/admin/favicon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (getJwt() || '') },
          body: JSON.stringify({ b64 })
        });
        const data = await resp.json();
        if (data.ok) {
          status.textContent = 'Favicon atualizado!';
          status.style.color = 'var(--green)';
          const img = document.getElementById('adm-favicon-img');
          img.src = '/img/favicon.png?v=' + Date.now();
          img.style.display = 'block';
          document.getElementById('adm-favicon-placeholder').style.display = 'none';
          // Atualizar favicon no browser
          let link = document.querySelector("link[rel~='icon']");
          if (link) link.href = '/img/favicon.png?v=' + Date.now();
        } else {
          status.textContent = data.erro || 'Erro ao enviar';
          status.style.color = 'var(--red)';
        }
      } catch (err) {
        status.textContent = 'Erro: ' + err.message;
        status.style.color = 'var(--red)';
      }
    });

    // Logo upload
    document.getElementById('adm-logo-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const status = document.getElementById('adm-logo-status');
      status.textContent = 'Enviando...';
      status.style.color = 'var(--text-muted)';
      try {
        const b64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(file);
        });
        const resp = await fetch('/api/admin/logo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (getJwt() || '') },
          body: JSON.stringify({ b64 })
        });
        const data = await resp.json();
        if (data.ok) {
          status.textContent = 'Logo atualizado!';
          status.style.color = 'var(--green)';
          const ts = Date.now();
          const img = document.getElementById('adm-logo-img');
          img.src = '/img/logo.png?v=' + ts;
          img.style.display = 'block';
          document.getElementById('adm-logo-placeholder').style.display = 'none';
          // Atualizar logo na navbar
          const navLogo = document.getElementById('nav-brand-logo');
          if (navLogo) { navLogo.src = '/img/logo.png?v=' + ts; navLogo.style.display = ''; }
        } else {
          status.textContent = data.erro || 'Erro ao enviar';
          status.style.color = 'var(--red)';
        }
      } catch (err) {
        status.textContent = 'Erro: ' + err.message;
        status.style.color = 'var(--red)';
      }
    });

    // Criar cupom
    document.getElementById('adm-cupom-criar')?.addEventListener('click', async () => {
      const codigo = document.getElementById('adm-cupom-codigo').value.trim().toUpperCase();
      const tipo = document.getElementById('adm-cupom-tipo').value;
      const valor = document.getElementById('adm-cupom-valor').value;
      const usoMaximo = document.getElementById('adm-cupom-usos').value;
      const validoAte = document.getElementById('adm-cupom-validade').value || null;

      if (!codigo || !valor) { toast('Preencha código e valor', 'error'); return; }
      try {
        await api('/api/admin/cupom', {
          method: 'POST',
          body: JSON.stringify({ codigo, tipo, valor, usoMaximo, validoAte }),
        });
        toast('✅ Cupom criado!', 'success');
        document.getElementById('adm-cupom-codigo').value = '';
        document.getElementById('adm-cupom-valor').value = '';
        document.getElementById('adm-cupom-usos').value = '1';
        document.getElementById('adm-cupom-validade').value = '';
        carregarAdminCupons();
      } catch (err) { toast(err.message, 'error'); }
    });

    // Admin: envio individual
    document.getElementById('adm-ind-busca')?.addEventListener('input', e => {
      admInd.busca = e.target.value.toLowerCase().trim();
      admInd.pagina = 1;
      renderEnvioIndividual();
    });

    document.getElementById('adm-fb-todos')?.addEventListener('change', (e) => fbToggleTodos(e.target.checked));

    // Admin: busca de usuários
    document.getElementById('adm-busca')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      const filtrado = admUsuarios.filter(u =>
        (u.nome || '').toLowerCase().includes(q) ||
        (u.usuario_id || '').toLowerCase().includes(q)
      );
      renderAdminUsuarios(filtrado);
    });
  }

  // Dashboard é carregado via ativarTab() chamado no verificarAuth()
}

// ── Login form ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form-login');
  const erroEl = document.getElementById('login-erro');
  const btnLogin = document.getElementById('btn-login');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;

    if (!username || !password) {
      erroEl.textContent = 'Preencha usuário e senha.';
      erroEl.classList.remove('hidden');
      return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Entrando...';
    erroEl.classList.add('hidden');

    let loginOk = false;
    try {
      const data = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const res = await data.json();

      if (!data.ok) {
        erroEl.textContent = res.erro || 'Usuário ou senha incorretos.';
        erroEl.classList.remove('hidden');
        return;
      }

      setJwt(res.token);
      loginOk = true;
    } catch (err) {
      erroEl.textContent = 'Erro de conexão. Tente novamente.';
      erroEl.classList.remove('hidden');
      console.error('[login] fetch error:', err);
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Entrar';
    }

    if (loginOk) {
      document.getElementById('tela-login').classList.add('hidden');
      verificarAuth();
    }
  });

  verificarAuth();
});

// ── Nova Transação ───────────────────────────────────────────────────────────
let _novaTxTipo = 'despesa';
let _novaTxStatus = 'pendente';
let _cartoesCache = null;

function toggleNovaTxTipo(btn) {
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _novaTxTipo = btn.dataset.val;
  // Mostrar/esconder cartão wrap quando for despesa
  const cartaoWrap = document.getElementById('nova-tx-cartao-wrap');
  if (cartaoWrap) cartaoWrap.classList.toggle('hidden', _novaTxTipo !== 'despesa');
}

function toggleNovaTxStatus(btn) {
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _novaTxStatus = btn.dataset.val;
}

let _recDuracao = 'indeterminado';

function toggleRecorrenciaFields() {
  const checked = document.getElementById('nova-tx-recorrente').checked;
  document.getElementById('nova-tx-rec-fields').classList.toggle('hidden', !checked);
  // Parcelas e recorrência são mutuamente exclusivos
  document.getElementById('nova-tx-parcelas').closest('.form-group').classList.toggle('hidden', checked);
}

function toggleRecDuracao(btn) {
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _recDuracao = btn.dataset.val;
  document.getElementById('nova-tx-rec-vezes-wrap').classList.toggle('hidden', _recDuracao !== 'vezes');
}

async function _carregarCartoesSelect() {
  if (!_cartoesCache) {
    try { _cartoesCache = await api('/api/cartoes'); } catch { _cartoesCache = []; }
  }
  const sel = document.getElementById('nova-tx-cartao');
  if (sel) {
    sel.innerHTML = '<option value="">Nenhum</option>' +
      _cartoesCache.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  }
}

async function _carregarContasSelect(selectId) {
  if (!_contasCache.length) {
    try { _contasCache = await api('/api/contas'); } catch { _contasCache = []; }
  }
  const sel = document.getElementById(selectId);
  if (sel) {
    sel.innerHTML = _contasCache.map(c => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
    const contaPadrao = _contasCache.find(c => c.padrao);
    if (contaPadrao) sel.value = contaPadrao.id;
  }
}

async function abrirModalNovaTx() {
  await carregarCategoriasSelect();
  // Copy categories to nova-tx select
  const editSel = document.getElementById('editar-tx-categoria');
  const novaSel = document.getElementById('nova-tx-categoria');
  if (editSel && novaSel) novaSel.innerHTML = editSel.innerHTML;
  await _carregarCartoesSelect();
  await _carregarContasSelect('nova-tx-conta');

  // Set defaults
  _novaTxTipo = 'despesa';
  _novaTxStatus = 'pendente';
  document.getElementById('nova-tx-descricao').value = '';
  document.getElementById('nova-tx-valor').value = '';
  document.getElementById('nova-tx-data').value = new Date().toISOString().substring(0, 10);
  document.getElementById('nova-tx-parcelas').value = '1';

  // Reset toggles
  document.querySelectorAll('#nova-tx-tipo-bar .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === 'despesa'));
  document.querySelectorAll('#nova-tx-status-bar .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === 'pendente'));
  document.getElementById('nova-tx-cartao-wrap').classList.remove('hidden');

  // Reset recurrence fields
  const recCheck = document.getElementById('nova-tx-recorrente');
  if (recCheck) recCheck.checked = false;
  const recFields = document.getElementById('nova-tx-rec-fields');
  if (recFields) recFields.classList.add('hidden');
  const recVezesWrap = document.getElementById('nova-tx-rec-vezes-wrap');
  if (recVezesWrap) recVezesWrap.classList.add('hidden');
  _recDuracao = 'indeterminado';
  document.querySelectorAll('#nova-tx-rec-duracao-bar .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === 'indeterminado'));
  const parcelasGroup = document.getElementById('nova-tx-parcelas')?.closest('.form-group');
  if (parcelasGroup) parcelasGroup.classList.remove('hidden');

  document.getElementById('modal-nova-tx').classList.remove('hidden');
}

function fecharModalNovaTx() {
  document.getElementById('modal-nova-tx').classList.add('hidden');
}

async function salvarNovaTx() {
  const descricao = document.getElementById('nova-tx-descricao').value.trim();
  const valor = parseFloat(document.getElementById('nova-tx-valor').value);
  const categoria = document.getElementById('nova-tx-categoria').value;
  const data = document.getElementById('nova-tx-data').value;
  const cartao_id = document.getElementById('nova-tx-cartao').value || null;
  const conta_id = document.getElementById('nova-tx-conta').value || null;
  const parcelas = parseInt(document.getElementById('nova-tx-parcelas').value) || 1;
  const isRecorrente = document.getElementById('nova-tx-recorrente')?.checked;

  if (!descricao) { toast('Preencha a descrição', 'error'); return; }
  if (!valor || valor <= 0) { toast('Valor inválido', 'error'); return; }
  if (!data) { toast('Selecione uma data', 'error'); return; }
  if (!conta_id) { toast('Selecione uma conta', 'error'); return; }

  try {
    if (isRecorrente) {
      // Build recurrence payload
      const freq = document.getElementById('nova-tx-rec-freq').value; // mensal | semanal
      const dt = new Date(data + 'T12:00:00');
      const body = {
        tipo: _novaTxTipo,
        valor,
        descricao,
        categoria: categoria || null,
        frequencia: freq,
        data_inicio: data,
        data_fim: null,
      };
      if (freq === 'mensal') body.dia_mes = dt.getDate();
      if (freq === 'semanal') body.dia_semana = dt.getDay();

      if (_recDuracao === 'vezes') {
        const vezes = parseInt(document.getElementById('nova-tx-rec-vezes').value);
        if (!vezes || vezes < 2) { toast('Número de repetições inválido (mínimo 2)', 'error'); return; }
        // Calculate data_fim based on vezes
        const fim = new Date(dt);
        if (freq === 'mensal') fim.setMonth(fim.getMonth() + (vezes - 1));
        else if (freq === 'semanal') fim.setDate(fim.getDate() + (vezes - 1) * 7);
        body.data_fim = fim.toISOString().substring(0, 10);
      }

      await api('/api/recorrencias', { method: 'POST', body: JSON.stringify(body) });
      toast('Recorrência criada!', 'success');
    } else {
      await api('/api/transactions', {
        method: 'POST',
        body: JSON.stringify({
          tipo: _novaTxTipo,
          valor,
          descricao,
          categoria: categoria || null,
          data,
          status: _novaTxStatus,
          cartao_id: cartao_id ? parseInt(cartao_id) : null,
          conta_id: conta_id ? parseInt(conta_id) : null,
          parcelas,
        }),
      });
      toast('Transação criada!', 'success');
    }
    fecharModalNovaTx();
    _categoriasCache = null; // Invalidate cache
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Cartões CRUD ─────────────────────────────────────────────────────────────
let _editandoCartao = false;

function abrirModalNovoCartao() {
  _editandoCartao = false;
  document.getElementById('modal-cartao-titulo').textContent = 'Novo Cartão';
  document.getElementById('cartao-edit-id').value = '';
  document.getElementById('cartao-nome').value = '';
  document.getElementById('cartao-limite').value = '';
  document.getElementById('cartao-fechamento').value = '';
  document.getElementById('cartao-vencimento').value = '';
  document.getElementById('modal-novo-cartao').classList.remove('hidden');
}

function abrirModalEditarCartao(c) {
  _editandoCartao = true;
  document.getElementById('modal-cartao-titulo').textContent = 'Editar Cartão';
  document.getElementById('cartao-edit-id').value = c.id;
  document.getElementById('cartao-nome').value = c.nome || '';
  document.getElementById('cartao-limite').value = c.limite_total || '';
  document.getElementById('cartao-fechamento').value = c.dia_fechamento || '';
  document.getElementById('cartao-vencimento').value = c.dia_vencimento || '';
  document.getElementById('modal-novo-cartao').classList.remove('hidden');
}

function fecharModalCartao() {
  document.getElementById('modal-novo-cartao').classList.add('hidden');
}

async function salvarCartao() {
  const nome = document.getElementById('cartao-nome').value.trim();
  const limite = parseFloat(document.getElementById('cartao-limite').value) || 0;
  const fechamento = parseInt(document.getElementById('cartao-fechamento').value) || null;
  const vencimento = parseInt(document.getElementById('cartao-vencimento').value) || null;

  if (!nome) { toast('Preencha o nome', 'error'); return; }

  try {
    if (_editandoCartao) {
      const id = parseInt(document.getElementById('cartao-edit-id').value);
      await api(`/api/cartoes/${id}`, { method: 'PUT', body: JSON.stringify({ campo: 'nome', novo_valor: nome }) });
      await api(`/api/cartoes/${id}`, { method: 'PUT', body: JSON.stringify({ campo: 'limite_total', novo_valor: limite }) });
      await api(`/api/cartoes/${id}`, { method: 'PUT', body: JSON.stringify({ campo: 'dia_fechamento', novo_valor: fechamento }) });
      await api(`/api/cartoes/${id}`, { method: 'PUT', body: JSON.stringify({ campo: 'dia_vencimento', novo_valor: vencimento }) });
      toast('Cartão atualizado!', 'success');
    } else {
      await api('/api/cartoes', {
        method: 'POST',
        body: JSON.stringify({ nome, limite_total: limite, dia_fechamento: fechamento, dia_vencimento: vencimento }),
      });
      toast('Cartão criado!', 'success');
    }
    fecharModalCartao();
    _cartoesCache = null;
    carregarCartoes();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Caixinhas CRUD ───────────────────────────────────────────────────────────
let _editandoCaixinha = false;

function abrirModalNovaCaixinha() {
  _editandoCaixinha = false;
  document.getElementById('modal-caixinha-titulo').textContent = 'Nova Caixinha';
  document.getElementById('caixinha-edit-id').value = '';
  document.getElementById('caixinha-nome').value = '';
  document.getElementById('caixinha-saldo').value = '';
  document.getElementById('caixinha-meta').value = '';
  document.getElementById('caixinha-tipo').value = '';
  document.getElementById('caixinha-rendimento').value = '';
  document.getElementById('modal-nova-caixinha').classList.remove('hidden');
}

function abrirModalEditarCaixinha(c) {
  _editandoCaixinha = true;
  document.getElementById('modal-caixinha-titulo').textContent = 'Editar Caixinha';
  document.getElementById('caixinha-edit-id').value = c.id;
  document.getElementById('caixinha-nome').value = c.nome || '';
  document.getElementById('caixinha-saldo').value = c.saldo || '';
  document.getElementById('caixinha-meta').value = c.meta || '';
  document.getElementById('caixinha-tipo').value = c.tipo || '';
  document.getElementById('caixinha-rendimento').value = c.rendimento_mensal || '';
  document.getElementById('modal-nova-caixinha').classList.remove('hidden');
}

function fecharModalCaixinha() {
  document.getElementById('modal-nova-caixinha').classList.add('hidden');
}

async function salvarCaixinha() {
  const nome = document.getElementById('caixinha-nome').value.trim();
  if (!nome) { toast('Preencha o nome', 'error'); return; }

  try {
    if (_editandoCaixinha) {
      const id = parseInt(document.getElementById('caixinha-edit-id').value);
      const campos = {
        nome,
        saldo: parseFloat(document.getElementById('caixinha-saldo').value) || 0,
        meta: parseFloat(document.getElementById('caixinha-meta').value) || null,
        tipo: document.getElementById('caixinha-tipo').value || null,
        rendimento_mensal: parseFloat(document.getElementById('caixinha-rendimento').value) || null,
      };
      for (const [campo, novo_valor] of Object.entries(campos)) {
        if (novo_valor !== null && novo_valor !== undefined) {
          await api(`/api/caixinhas/${id}`, { method: 'PUT', body: JSON.stringify({ campo, novo_valor }) });
        }
      }
      toast('Caixinha atualizada!', 'success');
    } else {
      await api('/api/caixinhas', {
        method: 'POST',
        body: JSON.stringify({
          nome,
          saldo: parseFloat(document.getElementById('caixinha-saldo').value) || 0,
          meta: parseFloat(document.getElementById('caixinha-meta').value) || null,
          tipo: document.getElementById('caixinha-tipo').value || null,
          rendimento_mensal: parseFloat(document.getElementById('caixinha-rendimento').value) || null,
        }),
      });
      toast('Caixinha criada!', 'success');
    }
    fecharModalCaixinha();
    carregarCaixinhas();
  } catch (err) { toast(err.message, 'error'); }
}

function abrirModalDeposito(id, nome) {
  document.getElementById('deposito-caixinha-id').value = id;
  document.getElementById('deposito-caixinha-nome').textContent = nome;
  document.getElementById('deposito-valor').value = '';
  document.getElementById('modal-deposito-caixinha').classList.remove('hidden');
}

function fecharModalDeposito() {
  document.getElementById('modal-deposito-caixinha').classList.add('hidden');
}

async function salvarDeposito() {
  const id = parseInt(document.getElementById('deposito-caixinha-id').value);
  const valor = parseFloat(document.getElementById('deposito-valor').value);
  if (!valor || valor <= 0) { toast('Valor inválido', 'error'); return; }
  try {
    await api(`/api/caixinhas/${id}/deposito`, { method: 'POST', body: JSON.stringify({ valor }) });
    toast('Depósito realizado!', 'success');
    fecharModalDeposito();
    carregarCaixinhas();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirCaixinhaConfirm(id, nome) {
  if (!confirm(`Excluir a caixinha "${nome}"?`)) return;
  try {
    await api(`/api/caixinhas/${id}`, { method: 'DELETE' });
    toast('Caixinha excluída.', 'success');
    carregarCaixinhas();
  } catch (err) { toast(err.message, 'error'); }
}

async function carregarCaixinhas() {
  let caixinhas;
  try { caixinhas = await api('/api/caixinhas'); }
  catch { return; }

  const list = document.getElementById('investimentos-list');
  const empty = document.getElementById('investimentos-empty');
  list.innerHTML = '';

  if (!caixinhas.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const c of caixinhas) {
    const row = document.createElement('div');
    row.className = 'cartao-row';
    const pct = c.meta && c.meta > 0 ? Math.min(100, Math.round((c.saldo / c.meta) * 100)) : null;
    const info = [
      c.tipo ? c.tipo : null,
      c.meta ? `Meta: ${fmtMoeda(c.meta)}` : null,
      c.rendimento_mensal ? `Rend: ${c.rendimento_mensal}%/mês` : null,
    ].filter(Boolean).join(' · ');

    row.innerHTML = `
      <div class="cartao-info">
        <span class="cartao-nome">💰 ${esc(c.nome)} — ${fmtMoeda(c.saldo)}</span>
        ${info ? `<span class="cartao-meta">${esc(info)}</span>` : ''}
        ${pct !== null ? `<div class="caixinha-progress"><div class="caixinha-progress-fill" style="width:${pct}%"></div></div><span class="cartao-meta">${pct}% da meta</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="action-btn" title="Depositar" onclick='abrirModalDeposito(${c.id}, "${esc(c.nome)}")'>💵</button>
        <button class="action-btn" title="Editar" onclick='abrirModalEditarCaixinha(${JSON.stringify({id:c.id,nome:c.nome,saldo:c.saldo,meta:c.meta,tipo:c.tipo||"",rendimento_mensal:c.rendimento_mensal||""})})'>✏️</button>
        <button class="action-btn" title="Excluir" onclick="excluirCaixinhaConfirm(${c.id}, '${esc(c.nome)}')">🗑️</button>
      </div>
    `;
    list.appendChild(row);
  }
}

// ── Lembretes ────────────────────────────────────────────────────────────────
let _lembreteTipo = 'avulso';

function toggleLembreteTipo(btn) {
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _lembreteTipo = btn.dataset.val;
  document.getElementById('lembrete-avulso-fields').classList.toggle('hidden', _lembreteTipo !== 'avulso');
  document.getElementById('lembrete-recorrente-fields').classList.toggle('hidden', _lembreteTipo !== 'recorrente');
}

function toggleLembreteFreqFields() {
  const freq = document.getElementById('lembrete-rec-frequencia').value;
  document.getElementById('lembrete-dia-semana-wrap').classList.toggle('hidden', freq !== 'semanal');
  document.getElementById('lembrete-dia-mes-wrap').classList.toggle('hidden', freq !== 'mensal');
}

function abrirModalNovoLembrete() {
  _lembreteTipo = 'avulso';
  document.getElementById('lembrete-mensagem').value = '';
  document.getElementById('lembrete-data').value = new Date().toISOString().substring(0, 10);
  document.getElementById('lembrete-hora').value = '09:00';
  document.getElementById('lembrete-rec-horario').value = '09:00';
  document.getElementById('lembrete-rec-frequencia').value = 'diario';
  document.getElementById('lembrete-avulso-fields').classList.remove('hidden');
  document.getElementById('lembrete-recorrente-fields').classList.add('hidden');
  document.getElementById('lembrete-dia-semana-wrap').classList.add('hidden');
  document.getElementById('lembrete-dia-mes-wrap').classList.add('hidden');
  document.querySelectorAll('#lembrete-tipo-bar .toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.val === 'avulso'));
  document.getElementById('modal-novo-lembrete').classList.remove('hidden');
}

function fecharModalLembrete() {
  document.getElementById('modal-novo-lembrete').classList.add('hidden');
}

async function salvarNovoLembrete() {
  const mensagem = document.getElementById('lembrete-mensagem').value.trim();
  if (!mensagem) { toast('Preencha a mensagem', 'error'); return; }

  try {
    if (_lembreteTipo === 'avulso') {
      const data = document.getElementById('lembrete-data').value;
      const hora = document.getElementById('lembrete-hora').value;
      if (!data || !hora) { toast('Preencha data e hora', 'error'); return; }
      await api('/api/lembretes', {
        method: 'POST',
        body: JSON.stringify({ mensagem, dispara_em: `${data}T${hora}:00` }),
      });
    } else {
      const horario = document.getElementById('lembrete-rec-horario').value;
      const frequencia = document.getElementById('lembrete-rec-frequencia').value;
      if (!horario) { toast('Preencha o horário', 'error'); return; }
      const body = { mensagem, horario, frequencia };
      if (frequencia === 'semanal') body.dia_semana = parseInt(document.getElementById('lembrete-rec-dia-semana').value);
      if (frequencia === 'mensal') body.dia_mes = parseInt(document.getElementById('lembrete-rec-dia-mes').value) || 1;
      await api('/api/lembretes/recorrente', { method: 'POST', body: JSON.stringify(body) });
    }
    toast('Lembrete criado!', 'success');
    fecharModalLembrete();
    carregarAgenda();
  } catch (err) { toast(err.message, 'error'); }
}

async function excluirLembreteConfirm(id, recorrente) {
  if (!confirm('Excluir este lembrete?')) return;
  try {
    if (recorrente) {
      await api(`/api/lembretes/recorrente/${id}`, { method: 'DELETE' });
    } else {
      await api(`/api/lembretes/${id}`, { method: 'DELETE' });
    }
    toast('Lembrete excluído.', 'success');
    carregarAgenda();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Recorrências CRUD ────────────────────────────────────────────────────────
let _recTipo = 'despesa';

function toggleRecTipo(btn) {
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _recTipo = btn.dataset.val;
}

function toggleRecFreqFields() {
  const freq = document.getElementById('rec-frequencia').value;
  document.getElementById('rec-dia-mes-wrap').classList.toggle('hidden', freq !== 'mensal');
  document.getElementById('rec-dia-semana-wrap').classList.toggle('hidden', freq !== 'semanal');
}

async function abrirModalNovaRecorrencia() {
  await carregarCategoriasSelect();
  const editSel = document.getElementById('editar-tx-categoria');
  const recSel = document.getElementById('rec-categoria');
  if (editSel && recSel) recSel.innerHTML = editSel.innerHTML;

  _recTipo = 'despesa';
  document.getElementById('rec-descricao').value = '';
  document.getElementById('rec-valor').value = '';
  document.getElementById('rec-frequencia').value = 'mensal';
  document.getElementById('rec-dia-mes').value = '';
  document.getElementById('rec-data-inicio').value = new Date().toISOString().substring(0, 10);
  document.getElementById('rec-data-fim').value = '';
  document.getElementById('rec-dia-mes-wrap').classList.remove('hidden');
  document.getElementById('rec-dia-semana-wrap').classList.add('hidden');
  document.getElementById('modal-nova-recorrencia').classList.remove('hidden');
}

function fecharModalRecorrencia() {
  document.getElementById('modal-nova-recorrencia').classList.add('hidden');
}

async function salvarNovaRecorrencia() {
  const descricao = document.getElementById('rec-descricao').value.trim();
  const valor = parseFloat(document.getElementById('rec-valor').value);
  const categoria = document.getElementById('rec-categoria').value || null;
  const frequencia = document.getElementById('rec-frequencia').value;
  const data_inicio = document.getElementById('rec-data-inicio').value;
  const data_fim = document.getElementById('rec-data-fim').value || null;

  if (!descricao) { toast('Preencha a descrição', 'error'); return; }
  if (!valor || valor <= 0) { toast('Valor inválido', 'error'); return; }

  const body = { tipo: _recTipo, valor, descricao, categoria, frequencia, data_inicio, data_fim };
  if (frequencia === 'mensal') body.dia_mes = parseInt(document.getElementById('rec-dia-mes').value) || 1;
  if (frequencia === 'semanal') body.dia_semana = parseInt(document.getElementById('rec-dia-semana').value);

  try {
    await api('/api/recorrencias', { method: 'POST', body: JSON.stringify(body) });
    toast('Recorrência criada!', 'success');
    fecharModalRecorrencia();
    carregarRecorrencias();
  } catch (err) { toast(err.message, 'error'); }
}

async function carregarRecorrencias() {
  let recs;
  try { recs = await api('/api/recorrencias'); }
  catch { return; }

  const list = document.getElementById('recorrencias-list');
  if (!list) return;
  const empty = document.getElementById('recorrencias-empty');
  list.innerHTML = '';

  if (!recs.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const DIAS_SEMANA = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  for (const r of recs) {
    const row = document.createElement('div');
    row.className = 'rec-row';
    const isReceita = r.tipo === 'receita';
    const freq = r.frequencia === 'mensal' ? `Mensal (dia ${r.dia_mes || '—'})` :
                 r.frequencia === 'semanal' ? `Semanal (${DIAS_SEMANA[r.dia_semana] || '—'})` : r.frequencia;
    row.innerHTML = `
      <div class="rec-info">
        <span class="rec-nome">${isReceita ? '📈' : '📉'} ${esc(r.descricao)}</span>
        <span class="rec-meta">${esc(freq)} · ${fmtMoeda(r.valor)} · ${esc(r.categoria || '—')}</span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="action-btn" title="Excluir" onclick="excluirRecorrenciaConfirm(${r.id}, '${esc(r.descricao)}')">🗑️</button>
      </div>
    `;
    list.appendChild(row);
  }
}

async function excluirRecorrenciaConfirm(id, desc) {
  if (!confirm(`Excluir a recorrência "${desc}"?`)) return;
  try {
    await api(`/api/recurrences/${id}`, { method: 'DELETE' });
    toast('Recorrência excluída.', 'success');
    carregarRecorrencias();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toggleAccordion(btn) {
  const body = btn.nextElementSibling;
  const icon = btn.querySelector('.accordion-icon');
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden');
  icon.textContent = isOpen ? '›' : '‹';
  btn.classList.toggle('accordion-header-active', !isOpen);
}
