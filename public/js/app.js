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

// ── Helpers de avatar / settings ──────────────────────────────────────────────
function _aplicarAvatar(nomeBase) {
  const foto = localStorage.getItem('cronos_avatar_photo');
  const avatarEl  = document.getElementById('dash-avatar');
  const settingsEl = document.getElementById('settings-avatar-preview');
  if (avatarEl) {
    if (foto) {
      avatarEl.style.backgroundImage = `url(${foto})`;
      avatarEl.style.backgroundSize = 'cover';
      avatarEl.style.backgroundPosition = 'center';
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = (nomeBase[0] || '?').toUpperCase();
    }
  }
  if (settingsEl) {
    if (foto) {
      settingsEl.innerHTML = `<img src="${foto}" alt="foto">`;
    } else {
      settingsEl.textContent = (nomeBase[0] || '?').toUpperCase();
    }
  }
}

async function verificarAuth() {
  const jwt = getJwt();
  if (!jwt) { mostrarLogin(); return; }

  try {
    const me = await api('/api/auth/me');
    _isAdmin = !!me.isAdmin;
    // Avatar: foto salva ou inicial do nome
    _aplicarAvatar(me.nome || me.username || '?');
    // Nome na tela de settings
    _meNome = me.nome || me.username || '';
    if (_isAdmin) {
      document.getElementById('nav-admin').classList.remove('hidden');
    }
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
      <td>${t.projetado
        ? `<span class="badge badge-projetado">${isReceita ? 'Previsto' : 'Previsto'}</span>`
        : `<span class="badge badge-${t.status}">${t.status === 'pago' ? (isReceita ? 'Recebido' : 'Pago') : (isReceita ? 'A Receber' : 'A Pagar')}</span>`
      }</td>
      <td style="white-space:nowrap">
        ${!t.projetado && t.status === 'pendente' ? `<button class="action-btn" title="${isReceita ? 'Marcar como recebido' : 'Marcar como pago'}" onclick="pagarTransacao(${t.id})">✅</button>` : ''}
        ${!t.projetado ? `<button class="action-btn" title="Excluir" onclick="excluirTransacao(${t.id})">🗑️</button>` : ''}
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
    const icone = l.recorrente ? '🔄' : '🔔';
    const badge = l.recorrente ? '<span class="ag-badge-rec">Recorrente</span>' : '';
    item.innerHTML = `
      <span class="ag-icon">${icone}</span>
      <div class="ag-info">
        <div class="ag-data">📅 ${esc(l.horario || l.data_disparo || '—')} ${badge}</div>
        <div class="ag-msg">${esc(l.mensagem)}</div>
      </div>
    `;
    list.appendChild(item);
  }
}

// ── Admin — Campanhas ─────────────────────────────────────────────────────────

let campPollTimer = null;

async function campPreview() {
  const filtro = document.getElementById('adm-camp-filtro').value;
  const countEl = document.getElementById('adm-camp-count');
  countEl.textContent = '…';
  try {
    const r = await api('/api/admin/campanhas/destinatarios?filtro=' + filtro);
    countEl.textContent = `${r.total} destinatário(s)`;
  } catch (err) {
    countEl.textContent = err.message;
  }
}

async function campEnviar() {
  const mensagem = document.getElementById('adm-camp-msg').value.trim();
  const filtro = document.getElementById('adm-camp-filtro').value;
  const statusEl = document.getElementById('adm-camp-status');
  const progressoEl = document.getElementById('adm-camp-progresso');
  const btn = document.getElementById('adm-camp-enviar');

  if (!mensagem) { toast('Digite a mensagem da campanha', 'error'); return; }

  const previewCount = document.getElementById('adm-camp-count').textContent;
  if (!confirm(`Confirmar envio da campanha para:\n${previewCount || 'destinatários selecionados'}?\n\nO envio será feito com delay aleatório entre mensagens.`)) return;

  btn.disabled = true;
  btn.textContent = '⏳ Iniciando...';
  statusEl.textContent = '';
  progressoEl.classList.add('hidden');

  try {
    const r = await api('/api/admin/campanhas/enviar', {
      method: 'POST',
      body: JSON.stringify({ mensagem, filtro }),
    });

    if (r.total === 0) {
      statusEl.textContent = r.aviso || 'Nenhum destinatário encontrado.';
      btn.disabled = false;
      btn.textContent = '📤 Enviar Campanha';
      return;
    }

    progressoEl.classList.remove('hidden');
    document.getElementById('adm-camp-prog-label').textContent = 'Enviando...';
    document.getElementById('adm-camp-prog-nums').textContent = `0 / ${r.total}`;
    document.getElementById('adm-camp-barra').style.width = '0%';
    document.getElementById('adm-camp-log').innerHTML = '';
    btn.textContent = '⏳ Enviando...';

    campStartPolling(r.campanhaId, r.total);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '📤 Enviar Campanha';
  }
}

function campStartPolling(campanhaId, total) {
  if (campPollTimer) clearInterval(campPollTimer);

  campPollTimer = setInterval(async () => {
    try {
      const s = await api('/api/admin/campanhas/' + campanhaId);
      const feitos = s.enviados + s.erros;
      const pct = total > 0 ? Math.round((feitos / total) * 100) : 0;

      document.getElementById('adm-camp-prog-nums').textContent = `${feitos} / ${total}`;
      document.getElementById('adm-camp-barra').style.width = pct + '%';

      const logEl = document.getElementById('adm-camp-log');
      const logAtual = logEl.children.length;
      const novos = s.log.slice(logAtual);
      for (const item of novos) {
        const div = document.createElement('div');
        div.className = 'camp-log-item ' + (item.ok ? 'camp-log-ok' : 'camp-log-erro');
        div.textContent = (item.ok ? '✅ ' : '❌ ') + item.nome + (item.erro ? ` — ${item.erro}` : '');
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
      }

      if (s.finalizado) {
        clearInterval(campPollTimer);
        campPollTimer = null;
        document.getElementById('adm-camp-prog-label').textContent =
          `Concluído! ${s.enviados} enviados, ${s.erros} erros.`;
        document.getElementById('adm-camp-barra').style.width = '100%';
        const btnFim = document.getElementById('adm-camp-enviar');
        btnFim.disabled = false;
        btnFim.textContent = '📤 Enviar Campanha';
        toast(`Campanha concluída: ${s.enviados} mensagens enviadas!`, 'success');
      }
    } catch (_) {}
  }, 3000);
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
        <span class="adm-ind-status">${statusLabel(u.status)}</span>
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

function statusLabel(status) {
  const map = { trial: '🟡 Trial', ativo: '🟢 Ativo', graca: '🟠 Carência', expirado: '🔴 Expirado' };
  return map[status] || status || '—';
}

function fmtValidade(u) {
  if (u.pago_ate) return fmtData(u.pago_ate);
  if (u.trial_fim) return 'Trial até ' + fmtData(u.trial_fim.slice(0, 10));
  return '—';
}

async function carregarAdmin() {
  await Promise.all([carregarAdminUsuarios(), carregarAdminCupons()]);
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
      <td>${statusLabel(u.status)}</td>
      <td style="font-size:12px">${fmtValidade(u)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${u.primeiro_contato ? fmtData(u.primeiro_contato.slice(0, 10)) : '—'}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-green" onclick="adminAtivar('${esc(u.usuario_id)}')">✅ Ativar</button>
          <button class="btn btn-sm btn-blue" onclick="adminLink('${esc(u.usuario_id)}', this)">🔗 Link</button>
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
  document.getElementById('modal-settings')?.classList.remove('hidden');
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
  document.addEventListener('click', () => dropdown?.classList.add('hidden'));

  document.getElementById('avatar-dd-sair')?.addEventListener('click', logout);

  document.getElementById('avatar-dd-foto')?.addEventListener('click', () => {
    dropdown?.classList.add('hidden');
    document.getElementById('input-photo')?.click();
  });

  document.getElementById('input-photo')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      localStorage.setItem('cronos_avatar_photo', ev.target.result);
      _aplicarAvatar(_meNome);
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('avatar-dd-config')?.addEventListener('click', () => {
    dropdown?.classList.add('hidden');
    abrirSettings();
  });

  document.getElementById('btn-settings-close')?.addEventListener('click', () => {
    document.getElementById('modal-settings')?.classList.add('hidden');
  });
  document.getElementById('modal-settings')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-settings'))
      document.getElementById('modal-settings').classList.add('hidden');
  });

  document.getElementById('btn-settings-salvar')?.addEventListener('click', () => {
    const nome  = document.getElementById('settings-input-nome')?.value.trim();
    const email = document.getElementById('settings-input-email')?.value.trim();
    if (nome)  { localStorage.setItem('cronos_settings_nome', nome); _meNome = nome; }
    if (email) localStorage.setItem('cronos_settings_email', email);
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
  document.getElementById('dash-prev').addEventListener('click', () => {
    const e = estado.dash; e.mes--; if (e.mes < 1) { e.mes = 12; e.ano--; } carregarDashboard();
  });
  document.getElementById('dash-next').addEventListener('click', () => {
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

  // Admin: criar cupom
  if (_isAdmin) {
    document.getElementById('adm-cupom-criar').addEventListener('click', async () => {
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
    document.getElementById('adm-ind-busca').addEventListener('input', e => {
      admInd.busca = e.target.value.toLowerCase().trim();
      admInd.pagina = 1;
      renderEnvioIndividual();
    });

    // Admin: campanhas
    document.getElementById('adm-camp-preview').addEventListener('click', campPreview);
    document.getElementById('adm-camp-enviar').addEventListener('click', campEnviar);

    // Admin: busca de usuários
    document.getElementById('adm-busca').addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      const filtrado = admUsuarios.filter(u =>
        (u.nome || '').toLowerCase().includes(q) ||
        (u.usuario_id || '').toLowerCase().includes(q)
      );
      renderAdminUsuarios(filtrado);
    });
  }

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
      document.getElementById('app').classList.remove('hidden');
      inicializar();
    }
  });

  verificarAuth();
});

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
