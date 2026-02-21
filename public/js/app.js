/* ── Cronos — Painel Financeiro ───────────────────────────────────────────── */

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── Auth ──────────────────────────────────────────────────────────────────────
function getJwt() { return localStorage.getItem('cronos_jwt'); }
function setJwt(t) { localStorage.setItem('cronos_jwt', t); }
function clearJwt() { localStorage.removeItem('cronos_jwt'); }

async function verificarAuth() {
  const jwt = getJwt();
  if (!jwt) { mostrarLogin(); return; }

  try {
    const me = await api('/api/auth/me');
    document.getElementById('header-user').textContent = me.username ? '👤 ' + me.username : '';
    document.getElementById('app').classList.remove('hidden');
    inicializar();
  } catch {
    clearJwt();
    mostrarLogin();
  }
}

function mostrarLogin() {
  document.getElementById('tela-login').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  setTimeout(() => document.getElementById('login-user')?.focus(), 50);
}

function logout() {
  clearJwt();
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

  const res = await fetch(path, { headers, ...opts });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401) { clearJwt(); mostrarLogin(); throw new Error('Sessão expirada'); }
  if (!res.ok) throw new Error(data.erro || 'Erro ' + res.status);
  return data;
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

// ── Estado global ─────────────────────────────────────────────────────────────
const estado = {
  dash: { mes: new Date().getMonth() + 1, ano: new Date().getFullYear() },
  tx: { mes: new Date().getMonth() + 1, ano: new Date().getFullYear(),
        filtroStatus: '', filtroTipo: '', busca: '', pagina: 1 },
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

  // Recriar canvas se necessário
  if (!document.getElementById('chart-categorias')) {
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-categorias';
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
  }

  estado.charts.categorias = new Chart(document.getElementById('chart-categorias'), {
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
  if (!document.getElementById('chart-mensal')) {
    const canvas = document.createElement('canvas');
    canvas.id = 'chart-mensal';
    wrap.innerHTML = '';
    wrap.appendChild(canvas);
  }

  estado.charts.mensal = new Chart(document.getElementById('chart-mensal'), {
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
  document.getElementById('c-saldo').textContent = fmtMoeda(saldos.saldoAtual);
  document.getElementById('c-receitas').textContent = fmtMoeda(saldos.receitasPagas);
  document.getElementById('c-despesas').textContent = fmtMoeda(saldos.despesasPagas);
  document.getElementById('c-pendentes').textContent = fmtMoeda(saldos.despesasPendentes);

  renderChartCategorias(resumo.porCategoria || []);
  await renderChartMensal();
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
      <td><strong>${esc(t.descricao)}</strong></td>
      <td><span style="font-size:12px;color:var(--text-muted)">${esc(t.categoria || '—')}</span></td>
      <td class="text-right ${isReceita ? 'valor-positivo' : 'valor-negativo'}">${isReceita ? '+' : '-'}${fmtMoeda(t.valor)}</td>
      <td><span class="badge badge-${t.status}">${t.status === 'pago' ? 'Pago' : 'A Pagar'}</span></td>
      <td style="white-space:nowrap">
        ${t.status === 'pendente' ? `<button class="action-btn" title="Marcar como pago" onclick="pagarTransacao(${t.id})">✅</button>` : ''}
        <button class="action-btn" title="Excluir" onclick="excluirTransacao(${t.id})">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
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

async function excluirTransacao(id) {
  if (!confirm('Deseja excluir esta transação?')) return;
  try {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    toast('Transação excluída.', 'success');
    carregarTransacoes();
    if (tabAtual === 'dashboard') carregarDashboard();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Categorias ────────────────────────────────────────────────────────────────
async function carregarCategorias() {
  let cats;
  try { cats = await api('/api/categories'); }
  catch { toast('Erro ao carregar categorias', 'error'); return; }

  const grid = document.getElementById('cat-grid');
  grid.innerHTML = '';
  for (const nome of cats) {
    const card = document.createElement('div');
    card.className = 'cat-card';
    card.innerHTML = `
      <span class="cat-nome">${esc(nome)}</span>
      <button class="cat-del" title="Excluir" onclick="excluirCategoria('${esc(nome)}')">🗑️</button>
    `;
    grid.appendChild(card);
  }
}

async function excluirCategoria(nome) {
  if (!confirm(`Excluir a categoria "${nome}"?`)) return;
  try {
    await api('/api/categories/' + encodeURIComponent(nome), { method: 'DELETE' });
    toast('Categoria excluída.', 'success');
    carregarCategorias();
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
    item.innerHTML = `
      <span class="ag-icon">🔔</span>
      <div class="ag-info">
        <div class="ag-data">📅 ${esc(l.horario || l.data_disparo || '—')}</div>
        <div class="ag-msg">${esc(l.mensagem)}</div>
      </div>
    `;
    list.appendChild(item);
  }
}

// ── Navegação ─────────────────────────────────────────────────────────────────
let tabAtual = 'dashboard';

function ativarTab(tab) {
  tabAtual = tab;
  document.querySelectorAll('.tab-content').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.remove('hidden');
  document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'dashboard') carregarDashboard();
  if (tab === 'transactions') carregarTransacoes();
  if (tab === 'categories') carregarCategorias();
  if (tab === 'agenda') carregarAgenda();
}

// ── Inicialização ─────────────────────────────────────────────────────────────
function inicializar() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => ativarTab(btn.dataset.tab));
  });

  document.getElementById('btn-logout').addEventListener('click', logout);

  // Dashboard nav
  document.getElementById('dash-prev').addEventListener('click', () => {
    const e = estado.dash; e.mes--; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarDashboard();
  });
  document.getElementById('dash-next').addEventListener('click', () => {
    const e = estado.dash; e.mes++; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarDashboard();
  });

  // Transações nav
  document.getElementById('tx-prev').addEventListener('click', () => {
    const e = estado.tx; e.mes--; e.pagina = 1; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarTransacoes();
  });
  document.getElementById('tx-next').addEventListener('click', () => {
    const e = estado.tx; e.mes++; e.pagina = 1; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarTransacoes();
  });

  // Filtros transações
  document.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      estado.tx.filtroStatus = btn.dataset.filter ?? '';
      estado.tx.filtroTipo = btn.dataset.filterTipo ?? '';
      estado.tx.pagina = 1;
      carregarTransacoes();
    });
  });

  let buscaTimer;
  document.getElementById('tx-search').addEventListener('input', e => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(() => { estado.tx.busca = e.target.value.trim(); estado.tx.pagina = 1; carregarTransacoes(); }, 350);
  });

  // Criar categoria
  document.getElementById('cat-criar').addEventListener('click', async () => {
    const input = document.getElementById('cat-nova');
    const nome = input.value.trim();
    if (!nome) { toast('Digite um nome para a categoria', 'error'); return; }
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ nome }) });
      input.value = '';
      toast('✅ Categoria criada!', 'success');
      carregarCategorias();
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('cat-nova').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('cat-criar').click();
  });

  // Agenda nav
  document.getElementById('ag-prev').addEventListener('click', () => {
    const e = estado.ag; e.mes--; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarAgenda();
  });
  document.getElementById('ag-next').addEventListener('click', () => {
    const e = estado.ag; e.mes++; if (e.mes > 12) { e.mes = 1; e.ano++; } carregarAgenda();
  });

  carregarDashboard();
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
      document.getElementById('header-user').textContent = '👤 ' + res.username;
      document.getElementById('tela-login').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
      inicializar();
    } catch {
      erroEl.textContent = 'Erro de conexão. Tente novamente.';
      erroEl.classList.remove('hidden');
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Entrar';
    }
  });

  verificarAuth();
});

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
