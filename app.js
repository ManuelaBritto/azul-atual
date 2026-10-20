import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { supabaseConfig } from './supabase-config.js';

const configured = Boolean(supabaseConfig.url && supabaseConfig.anonKey && !supabaseConfig.url.startsWith('COLE_') && !supabaseConfig.anonKey.startsWith('COLE_'));
const supabase = configured ? createClient(supabaseConfig.url, supabaseConfig.anonKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
const appRoot = document.querySelector('#app');
const publicNav = document.querySelector('.public-nav');
const publicFooter = document.querySelector('.public-footer');
const roleNames = { cco: 'Centro de controle', maintenance: 'Manutenção', handling: 'Handling', customer_service: 'Atendimento', commercial: 'Comercial', admin: 'Administração' };
let currentUser = null;
let currentProfile = null;
let authReady = false;
let liveSubscriptions = [];
let liveRefreshTimer = 0;

let channelCounter = 0;

function clearLiveSubscriptions() {
  liveSubscriptions.forEach(unsubscribe => unsubscribe());
  liveSubscriptions = [];
  clearTimeout(liveRefreshTimer);
}
// Tempo real do Supabase (substitui o onSnapshot). O Realtime respeita as regras RLS.
function watchForChanges(table, filter, refresh) {
  if (!supabase) return;
  const channel = supabase.channel(`live-${table}-${++channelCounter}`);
  channel.on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, () => {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(refresh, 180);
  }).subscribe();
  liveSubscriptions.push(() => supabase.removeChannel(channel));
}
// Helpers do Supabase: lançam o erro para manter o fluxo try/catch original.
async function must(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}
function inFilter(values) { return `(${values.map(value => String(value).replace(/[^A-Za-z0-9-]/g, '')).join(',')})`; }
function mapMembership(row) {
  return { id: row.org_id, active: row.active, organizationId: row.org_id, organizationName: row.organization_name, areaIds: row.area_ids || [], areaNames: row.area_names || {}, roles: row.roles || {}, canViewAll: row.can_view_all, canManageIncidents: row.can_manage_incidents };
}
function mapIncident(row) {
  return { id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, flightCode: row.flight_code, flightKey: row.flight_key, title: row.title, category: row.category, priority: row.priority, status: row.status, summaryInternal: row.summary_internal, createdBy: row.created_by, assignedAreaIds: row.assigned_area_ids || [], assignedAreaNames: row.assigned_area_names || {}, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toMillis(value) { const time = value ? Date.parse(value) : NaN; return Number.isNaN(time) ? 0 : time; }

const route = () => {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = hash.split('?');
  return { path, params: new URLSearchParams(search) };
};
function go(path) { location.hash = `#${path}`; }
function e(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function flightKey(code) { return String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function brand() { return '<a class="brand"><span class=""><img class="brand-logo" src="foto/logo.png" alt="" style="width: 40px;"></span><span>azul <b>em sintonia</b></span></a>'; }
function errorText(error) {
  const messages = {
    'user_already_exists': 'Este e-mail já tem uma conta. Entre ou use outro e-mail.',
    'email_exists': 'Este e-mail já tem uma conta. Entre ou use outro e-mail.',
    'invalid_credentials': 'E-mail ou senha incorretos.',
    'weak_password': 'Escolha uma senha mais forte, com pelo menos 6 caracteres.',
    'email_address_invalid': 'Confira o formato do e-mail.',
    'validation_failed': 'Confira o formato do e-mail.',
    'email_not_confirmed': 'Confirme seu e-mail pelo link enviado antes de entrar.',
    'over_email_send_rate_limit': 'Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.',
    'over_request_rate_limit': 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    'signup_disabled': 'O cadastro de novas contas está desativado no momento.',
    '42501': 'Sua conta não tem permissão para esta ação. Confira o credenciamento da área.',
    'PGRST301': 'Sua sessão expirou. Entre novamente.',
    '23505': 'Este registro já existe.'
  };
  if (messages[error?.code]) return messages[error.code];
  if (/user already registered/i.test(error?.message || '')) return messages.user_already_exists;
  if (/invalid login credentials/i.test(error?.message || '')) return messages.invalid_credentials;
  if (/row-level security|permission denied/i.test(error?.message || '')) return messages['42501'];
  if (/failed to fetch|networkerror|load failed/i.test(error?.message || '')) return 'Não foi possível conectar agora. Confira a internet e tente novamente.';
  return error?.message || 'Não foi possível concluir. Tente novamente.';
}
function showError(container, message) { const target = container?.querySelector('[data-error]'); if (target) target.textContent = message; }

function setLayout(isInternal) {
  publicNav.hidden = isInternal;
  publicFooter.hidden = isInternal;
  document.body.classList.toggle('internal-mode', isInternal);
}

async function render() {
  const { path, params } = route();
  if (!authReady && configured) { appRoot.innerHTML = `<section class="loading-screen">${brand()}<p>Carregando sua conta…</p></section>`; return; }
  if (path === '/' || path === '') { setLayout(false); renderLanding(); return; }
  if (['/login', '/cadastro', '/operacao/login'].includes(path)) { setLayout(false); renderAuth(path); return; }
  if (path.startsWith('/cliente')) {
    if (!currentUser) { go('/login'); return; }
    if (currentProfile?.accountType !== 'customer') { setLayout(false); renderDenied('Esta área é exclusiva para contas de cliente.'); return; }
    setLayout(true); await renderCustomer(); return;
  }
  if (path.startsWith('/operacao')) {
    if (!currentUser) { go('/operacao/login'); return; }
    if (currentProfile?.accountType !== 'employee') { setLayout(false); renderDenied('Sua conta não tem credenciamento operacional. O acesso é concedido por um administrador.'); return; }
    setLayout(true); await renderOperations(params); return;
  }
  setLayout(false); renderLanding();
}

function renderLanding() {
  const areaLink = currentUser ? (currentProfile?.accountType === 'customer' ? '/cliente' : '/operacao') : '/login';
  document.querySelector('.public-nav nav').innerHTML = `<a href="#como-funciona">Como funciona</a><a href="#/operacao/login">Acesso operacional</a><a class="nav-login" href="#${areaLink}">${currentUser ? 'Minha área →' : 'Entrar'}</a>`;
  appRoot.innerHTML = `
    <section class="hero"><div class="hero-copy">
      <span class="eyebrow">INFORMAÇÃO CONECTADA, VIAGENS MAIS TRANQUILAS</span>
       <h1>Todos em Sintonia ao Azul dos Céus.</h1><p>O Azul em Sintonia conecta as equipes durante uma ocorrência e mantém o passageiro informado com atualizações claras e consistentes.</p>
       <div class="hero-actions">
       <a class="button primary" href="#${currentUser ? areaLink : '/cadastro'}">${currentUser ? 'Acessar minha área' : 'Criar conta de cliente'} <span>→</span></a><a class="button secondary" href="#/operacao/login">Sou da operação</a></div><small class="hero-note">Uma ocorrência compartilhada. A informação certa para cada pessoa.</small></div><div class="hero-art"><div class="art-glow"></div><div class="art-card"><div class="art-header"><span class="live-dot"></span> OCORRÊNCIA ATUALIZADA <span>09:42</span></div><h3>Voo AD 4281 <small>GRU <b>→</b> REC</small></h3><p>Inspeção técnica em andamento</p><div class="art-line"><i></i><span><b>Manutenção</b> atualizou o diagnóstico</span></div><div class="art-line"><i></i><span><b>Atendimento</b> recebeu a orientação</span></div><div class="art-message"><span>PARA O PASSAGEIRO</span><p>“Nossa equipe está trabalhando para liberar a aeronave com segurança.”</p><small>Próxima atualização em 4 min</small></div></div><div class="floating-chip">✦ &nbsp;Áreas alinhadas</div></div></section>
    <section id="como-funciona" class="how"><div><span class="eyebrow">COMO FUNCIONA</span><h2>Uma situação. Uma fonte confiável.</h2><p>As equipes acompanham a mesma ocorrência, registram o que mudou e deixam claro o próximo passo. O passageiro recebe uma versão simples, feita para ele.</p></div><div class="how-steps"><article><span>01</span><h3>Registrar</h3><p>A ocorrência ganha um histórico único com fonte e horário.</p></article><article><span>02</span><h3>Coordenar</h3><p>Cada área recebe seu espaço de trabalho e atualiza sua parte.</p></article><article><span>03</span><h3>Informar</h3><p>O passageiro acompanha atualizações publicadas em linguagem clara.</p></article></div></section>`;
}

function renderAuth(path) {
  const isSignup = path === '/cadastro';
  const isOps = path === '/operacao/login';
  appRoot.innerHTML = `<section class="auth-wrap"><div class="auth-card"><div class="auth-symbol">${isOps ? '⌘' : '✳'}</div><span class="eyebrow">${isOps ? 'ÁREA RESTRITA' : 'ÁREA DO PASSAGEIRO'}</span><h1>${isSignup ? 'Crie sua conta' : isOps ? 'Acesso operacional' : 'Boas-vindas de volta'}</h1><p>${isOps ? 'Entre com seu e-mail individual autorizado. Sua organização e área vêm do credenciamento.' : isSignup ? 'Acompanhe comunicados públicos sobre os voos que adicionar à sua conta.' : 'Entre para consultar as atualizações públicas dos seus voos.'}</p><form id="auth-form">${isSignup ? '<label>Nome completo<input name="name" autocomplete="name" required minlength="2" placeholder="Como podemos chamar você?" /></label>' : ''}<label>E-mail<input name="email" type="email" autocomplete="email" required placeholder="voce@exemplo.com" /></label><label>Senha<input name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="6" placeholder="Mínimo de 6 caracteres" /></label><p class="form-error" data-error></p><button class="button primary submit-button" ${configured ? '' : 'disabled'}>${isSignup ? 'Criar conta' : 'Entrar'} <span>→</span></button></form>${isOps ? '<div class="auth-note">O acesso operacional não é aberto por cadastro. Um administrador precisa criar a conta e vincular as áreas autorizadas.</div>' : `<div class="auth-switch">${isSignup ? 'Já tem conta? <a href="#/login">Entrar</a>' : 'Ainda não tem conta? <a href="#/cadastro">Criar conta</a>'}</div>`}${!configured ? '<div class="form-alert error">Configure primeiro o arquivo supabase-config.js com os dados do seu projeto Supabase.</div>' : ''}<a class="back-link auth-back" href="#/">← Voltar ao início</a></div></section>`;
  document.querySelector('#auth-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const email = String(form.get('email')).trim(); const password = String(form.get('password'));
    const button = formElement.querySelector('button'); button.disabled = true; showError(formElement, '');
    try {
      if (isSignup) {
        // O perfil de cliente é criado automaticamente pelo gatilho handle_new_user no banco.
        const data = await must(supabase.auth.signUp({ email, password, options: { data: { full_name: String(form.get('name')).trim() } } }));
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw { code: 'user_already_exists' };
        if (!data.session) { showError(formElement, 'Conta criada! Enviamos um link de confirmação para o seu e-mail. Confirme e depois entre.'); button.disabled = false; return; }
        currentUser = data.session.user;
      } else {
        const data = await must(supabase.auth.signInWithPassword({ email, password }));
        currentUser = data.user;
        const profile = await must(supabase.from('profiles').select('account_type').eq('id', data.user.id).maybeSingle());
        if (isOps && profile?.account_type !== 'employee') { await refreshProfile(); go('/operacao'); return; }
      }
      await refreshProfile();
      go(currentProfile?.accountType === 'employee' ? '/operacao' : '/cliente');
    } catch (error) { showError(formElement, errorText(error)); button.disabled = false; }
  });
}

function renderDenied(message) {
  appRoot.innerHTML = `<section class="denied">${brand()}<div class="auth-card"><div class="auth-symbol">!</div><h1>Acesso não autorizado</h1><p>${e(message)}</p><button class="button primary" id="signout">Sair da conta</button><a class="back-link" href="#/">Voltar ao início</a></div></section>`;
  document.querySelector('#signout')?.addEventListener('click', () => supabase.auth.signOut());
}

function shell(kind, profile, body) {
  const customer = kind === 'customer';
<<<<<<< HEAD
  const activeRoute = route();
  const activeView = activeRoute.params.get('view') || (activeRoute.params.has('org') || activeRoute.params.has('area') ? 'boards' : 'dashboard');
  return `<div class="app-shell"><aside class="app-sidebar">${brand()}<div class="sidebar-label">${customer ? 'MINHA CONTA' : 'ESPAÇO OPERACIONAL'}</div><nav>${customer ? '<a class="side-link selected" href="#/cliente">◫ &nbsp; Atualizações</a>' : `<a class="side-link ${activeView==='dashboard'?'selected':''}" href="#/operacao?view=dashboard">▦ &nbsp; Visão geral</a><a class="side-link ${activeView==='radar'?'selected':''}" href="#/operacao?view=radar">✈ &nbsp; Radar de voos</a><a class="side-link ${activeView==='reports'?'selected':''}" href="#/operacao?view=reports">▤ &nbsp; Relatórios</a><a class="side-link ${activeView==='boards'?'selected':''}" href="#/operacao?view=boards">◷ &nbsp; Organizações e quadros</a>`}</nav><div class="sidebar-user"><span class="user-avatar">${e((profile?.fullName || 'U').slice(0, 1).toUpperCase())}</span><div><b>${e(profile?.fullName || 'Conta')}</b><small>${customer ? 'Cliente' : 'Acesso operacional'}</small></div><button id="signout-side" title="Sair">↪</button></div></aside><section class="workspace"><header class="workspace-top"><div><span class="eyebrow">${customer ? 'INFORMAÇÕES DOS SEUS VOOS' : 'ORGANIZAÇÕES AUTORIZADAS'}</span><h1>${customer ? `Olá, ${e((profile?.fullName || 'bem-vindo').split(' ')[0])}` : 'Espaço operacional'}</h1><p>${customer ? 'Acompanhe comunicados públicos e atualizações dos voos vinculados à sua conta.' : 'Organizações, áreas e quadros liberados para sua conta.'}</p></div><button class="outline-button" id="signout-top">Sair</button></header>${body}</section></div>`;
=======
  return `<div class="app-shell"><aside class="app-sidebar">${brand()}<div class="sidebar-label">${customer ? 'MINHA CONTA' : 'ESPAÇO OPERACIONAL'}</div><nav>${customer ? '<a class="side-link selected" href="#/cliente">◫ &nbsp; Atualizações</a>' : '<a class="side-link selected" href="#/operacao">▦ &nbsp; Organizações e quadros</a><a class="side-link" href="#/operacao">◷ &nbsp; Ocorrências</a>'}</nav><div class="sidebar-user"><span class="user-avatar">${e((profile?.fullName || 'U').slice(0, 1).toUpperCase())}</span><div><b>${e(profile?.fullName || 'Conta')}</b><small>${customer ? 'Cliente' : 'Acesso operacional'}</small></div><button id="signout-side" title="Sair">↪</button></div></aside><section class="workspace"><header class="workspace-top"><div><span class="eyebrow">${customer ? 'INFORMAÇÕES DOS SEUS VOOS' : 'ORGANIZAÇÕES AUTORIZADAS'}</span><h1>${customer ? `Olá, ${e((profile?.fullName || 'bem-vindo').split(' ')[0])}` : 'Espaço operacional'}</h1><p>${customer ? 'Acompanhe comunicados públicos e atualizações dos voos vinculados à sua conta.' : 'Organizações, áreas e quadros liberados para sua conta.'}</p></div><button class="outline-button" id="signout-top">Sair</button></header>${body}</section></div>`;
>>>>>>> 715a347b7451b6a9039b20eac5a5937a3193b0ee
}

function bindSignOut() {
  document.querySelectorAll('#signout-side,#signout-top').forEach(button => button.addEventListener('click', () => supabase.auth.signOut()));
}

async function renderCustomer() {
  clearLiveSubscriptions();
  appRoot.innerHTML = shell('customer', currentProfile, '<section class="dashboard-section"><div class="empty-state"><span>◷</span><b>Carregando seus voos…</b></div></section>'); bindSignOut();
  try {
    const flightRows = await must(supabase.from('customer_flights').select('flight_key, flight_code, created_at').eq('user_id', currentUser.id).order('created_at', { ascending: true }));
    const flights = flightRows.map(item => ({ key: item.flight_key, flightCode: item.flight_code, createdAt: item.created_at }));
    const updatesByFlight = await Promise.all(flights.map(async flight => {
      const rows = await must(supabase.from('public_updates').select('id, status, message, published_at, next_update_at').eq('flight_key', flight.key).order('published_at', { ascending: false }).limit(10));
      return rows.map(item => ({ id: item.id, status: item.status, message: item.message, publishedAt: item.published_at, nextUpdateAt: item.next_update_at, flightKey: flight.key, flightCode: flight.flightCode }));
    }));
    const updates = updatesByFlight.flat().sort((a, b) => toMillis(b.publishedAt) - toMillis(a.publishedAt));
    const body = `<div class="customer-add panel"><div><h2>Acompanhar um voo</h2><p>Adicione um código para receber comunicados públicos quando disponíveis.</p></div><form id="flight-form"><input name="flight" placeholder="Ex.: AD 4281" aria-label="Código do voo" required /><button class="button primary">Acompanhar</button></form><p class="form-error" data-error></p></div><section class="dashboard-section"><div class="section-heading"><div><h2>Voos acompanhados</h2><p>${flights.length} voo(s) na sua lista</p></div></div>${flights.length ? `<div class="flight-chips">${flights.map(flight => `<span>✈ &nbsp;${e(flight.flightCode)}</span>`).join('')}</div>` : '<div class="empty-state"><span>✳</span><b>Sua lista está vazia</b><p>Adicione um código de voo para acompanhar comunicados públicos.</p></div>'}</section><section class="dashboard-section"><div class="section-heading"><div><h2>Atualizações publicadas</h2><p>Somente mensagens liberadas para passageiros aparecem aqui.</p></div><button class="outline-button" id="refresh-customer">Atualizar</button></div>${updates.length ? `<div class="update-list">${updates.map(update => `<article class="update-card"><div class="update-meta"><b>${e(update.flightCode)}</b><span>${formatDate(update.publishedAt)}</span></div><span class="public-status">${e(update.status)}</span><p>${e(update.message)}</p>${update.nextUpdateAt ? `<small>Próxima atualização prevista: ${formatTime(update.nextUpdateAt)}</small>` : ''}</article>`).join('')}</div>` : '<div class="empty-state"><span>✳</span><b>Nenhuma atualização disponível</b><p>Quando houver uma mensagem pública para seus voos, ela aparecerá aqui.</p></div>'}</section>`;
    appRoot.innerHTML = shell('customer', currentProfile, body); bindSignOut();
    document.querySelector('#flight-form').addEventListener('submit', async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget); const code = String(form.get('flight')).trim().toUpperCase(); const key = flightKey(code); const error = event.currentTarget.parentElement.querySelector('[data-error]');
      if (!key || key.length < 4) { error.textContent = 'Digite um código de voo válido.'; return; }
      const button = event.currentTarget.querySelector('button'); button.disabled = true; error.textContent = '';
      try {
        const flight = await must(supabase.from('flights').select('flight_key, flight_code').eq('flight_key', key).maybeSingle());
        if (!flight) { error.textContent = `Voo ${code} não encontrado. Confira o código (ex.: AD 4281).`; button.disabled = false; return; }
        const alreadyAdded = flights.some(item => item.key === key);
        if (!alreadyAdded) {
          const { error: insertError } = await supabase.from('customer_flights').insert({ user_id: currentUser.id, flight_key: flight.flight_key, flight_code: flight.flight_code });
          if (insertError && insertError.code !== '23505') throw insertError;
        }
        await renderCustomer();
      }
      catch (err) { error.textContent = errorText(err); button.disabled = false; }
    });
    document.querySelector('#refresh-customer').addEventListener('click', renderCustomer);
    if (flights.length) watchForChanges('public_updates', `flight_key=in.${inFilter(flights.map(flight => flight.key))}`, renderCustomer);
  } catch (error) { appRoot.querySelector('.workspace').insertAdjacentHTML('beforeend', `<div class="form-alert error">${e(errorText(error))}</div>`); }
}

async function loadMemberships() {
  const rows = await must(supabase.from('memberships').select('*').eq('user_id', currentUser.id).eq('active', true));
  return rows.map(mapMembership);
}

<<<<<<< HEAD
const airportCoordinates = {
  GRU: [-23.4356, -46.4731], CGH: [-23.6261, -46.6564], VCP: [-23.0074, -47.1345],
  REC: [-8.1265, -34.9236], BSB: [-15.8697, -47.9208], GIG: [-22.8099, -43.2506],
  SDU: [-22.9105, -43.1631], CNF: [-19.6338, -43.9689], SSA: [-12.9086, -38.3225],
  FOR: [-3.7763, -38.5326], POA: [-29.9944, -51.1714], CWB: [-25.5285, -49.1758],
  FLN: [-27.6703, -48.5525], BEL: [-1.3793, -48.4763], MAO: [-3.0386, -60.0497],
  NAT: [-5.7681, -35.3761], MCZ: [-9.5108, -35.7917], AJU: [-10.9840, -37.0703],
  THE: [-5.0599, -42.8235], JPA: [-7.1458, -34.9486], IGU: [-25.5969, -54.4872],
  IOS: [-14.8150, -39.0332], JDO: [-7.2189, -39.2701], LDB: [-23.3336, -51.1301],
  MOC: [-16.7069, -43.8189], PMW: [-10.2915, -48.3569], PVH: [-8.7093, -63.9023],
  RBR: [-9.5830, -67.4836], SJP: [-20.8166, -49.4065], RAO: [-21.1342, -47.7742]
};

function svgRouteMap(flights) {
  const points = flights.map(f => ({ flight: f, from: airportCoordinates[String(f.origin || '').toUpperCase()], to: airportCoordinates[String(f.destination || '').toUpperCase()] })).filter(p => p.from && p.to);
  if (!points.length) return '<div class="empty-state"><b>Mapa de rotas indisponível para este catálogo</b><p>Confira se os aeroportos possuem códigos IATA reconhecidos.</p></div>';
  const all = points.flatMap(p => [p.from, p.to]);
  const minLat = Math.min(...all.map(p => p[0])) - 2, maxLat = Math.max(...all.map(p => p[0])) + 2;
  const minLon = Math.min(...all.map(p => p[1])) - 2, maxLon = Math.max(...all.map(p => p[1])) + 2;
  const project = ([lat, lon]) => ({ x: 45 + (lon - minLon) / Math.max(.1, maxLon - minLon) * 710, y: 35 + (maxLat - lat) / Math.max(.1, maxLat - minLat) * 420 });
  const routes = points.map(({flight, from, to}, i) => {
    const a = project(from), b = project(to), bend = Math.max(20, Math.abs(a.x-b.x)*.12);
    return `<g class="radar-route"><path d="M ${a.x} ${a.y} Q ${(a.x+b.x)/2} ${Math.min(a.y,b.y)-bend} ${b.x} ${b.y}"/><circle cx="${a.x}" cy="${a.y}" r="5"/><circle cx="${b.x}" cy="${b.y}" r="5"/><text x="${(a.x+b.x)/2}" y="${(a.y+b.y)/2-12}">${e(flight.flight_code)}</text></g>`;
  }).join('');
  const airports = [...new Map(points.flatMap(p => [[String(p.flight.origin).toUpperCase(), p.from], [String(p.flight.destination).toUpperCase(), p.to]]).map(([code, coord]) => [code, {code, coord}])).values()];
  const labels = airports.map(({code, coord}) => { const p = project(coord); return `<text class="radar-airport" x="${p.x+8}" y="${p.y+4}">${e(code)}</text>`; }).join('');
  return `<svg class="radar-map" viewBox="0 0 800 490" role="img" aria-label="Mapa esquemático das rotas cadastradas">${routes}${labels}</svg>`;
}

async function getAnalyticsData() {
  const memberships = await loadMemberships();
  const areas = [];
  for (const membership of memberships) {
    const names = {...(membership.areaNames || {})};
    const ids = new Set(membership.areaIds || []);
    if (membership.canViewAll) {
      const rows = await must(supabase.from('areas').select('id,name,active').eq('org_id', membership.id).order('created_at', {ascending:true}));
      rows.forEach(area => { if (area.active !== false) { ids.add(area.id); names[area.id] = area.name; } });
    }
    for (const id of ids) areas.push({orgId: membership.id, orgName: membership.organizationName || membership.id, areaId:id, areaName:names[id] || id, membership});
  }
  const boardSets = await Promise.all(areas.map(async area => ({area, rows: await must(supabase.from('boards').select('incident_id,org_id,area_id,created_at').eq('org_id',area.orgId).eq('area_id',area.areaId))})));
  const incidentIds = [...new Set(boardSets.flatMap(item => item.rows.map(row => row.incident_id)))];
  const [incidentRows, flightRows] = await Promise.all([
    incidentIds.length ? must(supabase.from('incidents').select('*').in('id', incidentIds).order('created_at',{ascending:false})) : Promise.resolve([]),
    must(supabase.from('flights').select('flight_key,flight_code,origin,origin_city,destination,destination_city,scheduled_departure,scheduled_arrival,aircraft').order('scheduled_departure',{ascending:true}).limit(250))
  ]);
  const ids = incidentRows.map(row => row.id);
  const [statusRows, updateRows] = await Promise.all([
    ids.length ? must(supabase.from('area_status').select('incident_id,area_id,state,updated_at').in('incident_id',ids)) : Promise.resolve([]),
    ids.length ? must(supabase.from('internal_updates').select('incident_id,area_id,area_name,role,content,created_at').in('incident_id',ids).order('created_at',{ascending:false}).limit(500)) : Promise.resolve([])
  ]);
  const incidents = incidentRows.map(row => {
    const incident = mapIncident(row);
    const statuses = statusRows.filter(item => item.incident_id === row.id);
    const updates = updateRows.filter(item => item.incident_id === row.id);
    return {...incident, statuses, updates, waitingAreas: statuses.filter(item => item.state !== 'done').length, doneAreas: statuses.filter(item => item.state === 'done').length, lastActivity: updates[0]?.created_at || row.updated_at || row.created_at};
  });
  return {areas, incidents, flights:flightRows, statusRows, updateRows};
}

function metricCard(label, value, note, icon) {
  return `<article class="metric-card"><span class="metric-icon">${icon}</span><span class="metric-label">${label}</span><strong>${value}</strong><small>${note}</small></article>`;
}
function barChart(title, subtitle, entries) {
  const max = Math.max(1, ...entries.map(item => item.value));
  return `<section class="analytics-panel"><div class="analytics-panel-heading"><div><h3>${title}</h3><p>${subtitle}</p></div></div>${entries.length ? `<div class="chart-bars">${entries.map(item => `<div class="chart-bar-row"><span>${e(item.label)}</span><div class="chart-bar-track"><i style="width:${Math.max(item.value ? 3 : 0, item.value/max*100)}%"></i></div><b>${item.value}</b></div>`).join('')}</div>` : '<p class="muted-copy">Ainda não há dados suficientes.</p>'}</section>`;
}
function exportIncidentCsv(incidents) {
  const header = ['Código do voo','Título','Categoria','Prioridade','Status','Organização','Áreas atribuídas','Criada em','Última atividade','Áreas pendentes'];
  const rows = incidents.map(item => [item.flightCode,item.title,item.category,item.priority,item.status,item.organizationName,(item.assignedAreaIds||[]).map(id=>item.assignedAreaNames?.[id]||id).join('; '),item.createdAt,item.lastActivity,item.waitingAreas]);
  const csv = [header,...rows].map(row => row.map(value => `"${String(value ?? '').replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href=url; link.download=`azul-em-sintonia-relatorio-${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

async function renderAnalyticsView(view) {
  const titles = {dashboard:'Visão geral', reports:'Central de relatórios', radar:'Radar de voos'};
  appRoot.innerHTML = shell('operations', currentProfile, '<div class="empty-state"><span>◷</span><b>Preparando painel operacional…</b><p>Consultando apenas informações liberadas para seu credenciamento.</p></div>');
  bindSignOut();
  try {
    const data = await getAnalyticsData();
    const {incidents, flights} = data;
    const open = incidents.filter(item => !['closed','resolved','done','concluída','concluido'].includes(String(item.status).toLowerCase()));
    const critical = open.filter(item => item.priority === 'critical').length;
    const high = open.filter(item => item.priority === 'high').length;
    const completed = incidents.filter(item => item.doneAreas === (item.statuses || []).length && item.statuses.length > 0).length;
    const avgResolution = (() => { const resolved = incidents.filter(item => item.statuses.length && item.doneAreas === item.statuses.length); if (!resolved.length) return '—'; const mins = resolved.reduce((sum,item)=>sum+Math.max(0,(toMillis(item.lastActivity)-toMillis(item.createdAt))/60000),0)/resolved.length; return mins < 60 ? `${Math.round(mins)} min` : `${(mins/60).toFixed(1).replace('.',',')} h`; })();
    const byArea = new Map(); data.areas.forEach(area => byArea.set(area.areaName,0)); incidents.forEach(item => (item.assignedAreaIds||[]).forEach(id=>{ const name=item.assignedAreaNames?.[id]||data.areas.find(area=>area.areaId===id)?.areaName||id; byArea.set(name,(byArea.get(name)||0)+1); }));
    const byPriority = [{label:'Crítica',value:incidents.filter(item=>item.priority==='critical').length},{label:'Alta',value:incidents.filter(item=>item.priority==='high').length},{label:'Normal',value:incidents.filter(item=>item.priority==='normal').length}];
    const recent = [...incidents].sort((a,b)=>toMillis(b.lastActivity)-toMillis(a.lastActivity)).slice(0,5);
    let content = '';
    if (view === 'reports') {
      content = `<section class="analytics-intro"><div><span class="eyebrow">ANÁLISE OPERACIONAL</span><h2>Central de relatórios</h2><p>Indicadores calculados a partir das ocorrências que sua conta tem permissão para consultar.</p></div><div class="report-actions"><button class="button primary" id="export-report">Baixar CSV</button><button class="button secondary" id="print-report">Exportar / imprimir PDF</button></div></section><section class="metrics-grid">${metricCard('Ocorrências no período',incidents.length,'Registros acessíveis','▤')}${metricCard('Em aberto',open.length,'Aguardando conclusão','◷')}${metricCard('Prioridade crítica',critical,'Ocorrências críticas','!')}${metricCard('Tempo médio estimado',avgResolution,'Entre criação e última atividade dos casos concluídos','◴')}</section><div class="analytics-grid">${barChart('Ocorrências por área','Distribuição entre os setores envolvidos',[...byArea].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value))}${barChart('Distribuição por prioridade','Todas as ocorrências acessíveis',byPriority)}</div><section class="analytics-panel report-table-panel"><div class="analytics-panel-heading"><div><h3>Detalhamento das ocorrências</h3><p>Use o CSV para filtrar, compartilhar ou analisar os registros.</p></div><input id="report-filter" class="report-filter" placeholder="Buscar voo, título ou status…" aria-label="Filtrar relatório"></div><div class="table-scroll"><table class="report-table"><thead><tr><th>Voo</th><th>Ocorrência</th><th>Prioridade</th><th>Status</th><th>Áreas pendentes</th><th>Última atividade</th></tr></thead><tbody id="report-rows">${incidents.map(item=>`<tr data-search="${e(`${item.flightCode} ${item.title} ${item.status} ${item.category}`.toLowerCase())}"><td>${e(item.flightCode)}</td><td>${e(item.title)}</td><td><span class="priority-pill ${e(item.priority)}">${e(item.priority==='critical'?'Crítica':item.priority==='high'?'Alta':'Normal')}</span></td><td>${e(item.status)}</td><td>${item.waitingAreas}</td><td>${e(formatDate(item.lastActivity))}</td></tr>`).join('')||'<tr><td colspan="6">Nenhuma ocorrência disponível para este perfil.</td></tr>'}</tbody></table></div></section>`;
    } else if (view === 'radar') {
      const flightCards = flights.map(flight=>`<article class="radar-flight-card" data-flight-search="${e(`${flight.flight_code} ${flight.origin} ${flight.destination} ${flight.aircraft||''}`.toLowerCase())}"><div class="radar-flight-code">✈ ${e(flight.flight_code)}</div><div class="radar-route-codes"><b>${e(flight.origin)}</b><span>→</span><b>${e(flight.destination)}</b></div><p>${e(flight.origin_city||flight.origin)} para ${e(flight.destination_city||flight.destination)}</p><small>${flight.scheduled_departure ? `Partida prevista: ${e(formatDate(flight.scheduled_departure))}` : 'Horário não informado'}${flight.aircraft ? ` · ${e(flight.aircraft)}` : ''}</small></article>`).join('');
      content = `<section class="analytics-intro"><div><span class="eyebrow">MALHA AÉREA</span><h2>Radar de voos</h2><p>Visão esquemática das rotas cadastradas no catálogo de demonstração.</p></div><span class="demo-label">Dados de catálogo · sem GPS ao vivo</span></section><section class="analytics-panel radar-panel"><div class="analytics-panel-heading"><div><h3>Mapa de rotas</h3><p>Linhas representam rotas cadastradas com aeroportos mapeados, não a posição atual das aeronaves.</p></div><span class="radar-count">${flights.length} voos no catálogo</span></div>${svgRouteMap(flights)}</section><section class="analytics-panel"><div class="analytics-panel-heading"><div><h3>Voos cadastrados</h3><p>Busque por código, origem ou destino.</p></div><input id="radar-filter" class="report-filter" placeholder="Ex.: AD 4281, GRU, REC…" aria-label="Buscar voo"></div><div class="radar-flight-grid" id="radar-flight-grid">${flightCards||'<p class="muted-copy">Nenhum voo cadastrado.</p>'}</div></section>`;
    } else {
      const urgent = open.filter(item=>item.priority==='critical'||item.priority==='high').sort((a,b)=>(a.priority==='critical'?-1:0)-(b.priority==='critical'?-1:0)||toMillis(a.lastActivity)-toMillis(b.lastActivity)).slice(0,4);
      const trend = [];
      for(let offset=6;offset>=0;offset--){ const date=new Date(); date.setDate(date.getDate()-offset); const key=date.toLocaleDateString('sv-SE'); trend.push({label:date.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}),value:incidents.filter(item=>new Date(item.createdAt).toLocaleDateString('sv-SE')===key).length}); }
      content = `<section class="analytics-intro"><div><span class="eyebrow">CENTRO DE INTELIGÊNCIA OPERACIONAL</span><h2>Visão geral da operação</h2><p>Uma visão consolidada das ocorrências, prioridades e áreas que exigem acompanhamento.</p></div><span class="data-stamp">Atualizado em ${e(new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}))}</span></section><section class="metrics-grid">${metricCard('Ocorrências abertas',open.length,'Casos ainda em acompanhamento','◷')}${metricCard('Prioridade crítica',critical,'Exigem atenção prioritária','!')}${metricCard('Prioridade alta',high,'Precisam de acompanhamento','↗')}${metricCard('Concluídas por áreas',completed,'Todas as áreas vinculadas finalizaram','✓')}</section><div class="analytics-grid">${barChart('Ocorrências por área','Setores envolvidos nos registros',[...byArea].map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value))}${barChart('Prioridades','Distribuição das ocorrências',byPriority)}</div><section class="impact-panel"><div class="impact-header"><div><span class="eyebrow">DIFERENCIAL OPERACIONAL</span><h3>Central de Impacto Operacional</h3><p>Ocorrências que merecem atenção e o que precisa ser acompanhado.</p></div><span class="impact-symbol">✦</span></div>${urgent.length ? `<div class="impact-list">${urgent.map(item=>`<article class="impact-item"><span class="impact-level ${e(item.priority)}"></span><div><b>${e(item.flightCode)} · ${e(item.title)}</b><p>${e(item.summaryInternal)}</p><small>${item.waitingAreas} área(s) ainda não concluíram · última atividade: ${e(formatDate(item.lastActivity))}</small></div><span class="priority-pill ${e(item.priority)}">${e(item.priority==='critical'?'Crítica':'Alta')}</span></article>`).join('')}</div>`:'<div class="empty-state compact-empty"><b>Nenhuma ocorrência de alta prioridade aberta</b><p>Quando houver casos prioritários, eles aparecerão aqui.</p></div>'}</section><section class="analytics-panel"><div class="analytics-panel-heading"><div><h3>Atividade recente</h3><p>Últimas ocorrências atualizadas.</p></div><a class="text-action" href="#/operacao?view=boards">Abrir quadros →</a></div>${recent.length?`<div class="recent-incidents">${recent.map(item=>`<article><span class="recent-flight">${e(item.flightCode)}</span><div><b>${e(item.title)}</b><small>${e(item.category)} · ${e(formatDate(item.lastActivity))}</small></div><span class="priority-pill ${e(item.priority)}">${e(item.priority==='critical'?'Crítica':item.priority==='high'?'Alta':'Normal')}</span></article>`).join('')}</div>`:'<p class="muted-copy">Nenhuma ocorrência registrada para as áreas disponíveis.</p>'}</section><div class="dashboard-bottom-grid">${barChart('Novas ocorrências · últimos 7 dias','Volume por data de criação',trend)}<section class="analytics-panel quick-actions"><h3>Acesso rápido</h3><a href="#/operacao?view=radar">✈ &nbsp; Abrir radar de voos <span>→</span></a><a href="#/operacao?view=reports">▤ &nbsp; Gerar relatório <span>→</span></a><a href="#/operacao?view=boards">◷ &nbsp; Consultar quadros <span>→</span></a></section></div>`;
    }
    const body = `<div class="analytics-page" data-current-view="${e(view)}">${content}</div>`;
    appRoot.innerHTML = shell('operations',currentProfile,body); bindSignOut();
    if(view==='reports'){
      document.querySelector('#export-report')?.addEventListener('click',()=>exportIncidentCsv(incidents));
      document.querySelector('#print-report')?.addEventListener('click',()=>window.print());
      document.querySelector('#report-filter')?.addEventListener('input',event=>{const query=event.target.value.trim().toLowerCase();document.querySelectorAll('#report-rows tr[data-search]').forEach(row=>row.hidden=!row.dataset.search.includes(query));});
    }
    if(view==='radar') document.querySelector('#radar-filter')?.addEventListener('input',event=>{const query=event.target.value.trim().toLowerCase();document.querySelectorAll('#radar-flight-grid [data-flight-search]').forEach(card=>card.hidden=!card.dataset.flightSearch.includes(query));});
    if(view==='dashboard'||view==='reports'){
      watchForChanges('incidents',null,()=>{clearLiveSubscriptions();renderAnalyticsView(view);});
      watchForChanges('area_status',null,()=>{clearLiveSubscriptions();renderAnalyticsView(view);});
      watchForChanges('internal_updates',null,()=>{clearLiveSubscriptions();renderAnalyticsView(view);});
    }
  } catch(error) {
    appRoot.innerHTML = shell('operations',currentProfile,`<section class="analytics-panel"><span class="eyebrow">PAINEL OPERACIONAL</span><h2>Não foi possível carregar os indicadores</h2><p>${e(errorText(error))}</p><button class="button primary" id="retry-analytics">Tentar novamente</button></section>`); bindSignOut();
    document.querySelector('#retry-analytics')?.addEventListener('click',()=>renderAnalyticsView(view));
  }
}

async function renderOperations(params = new URLSearchParams(), subscribe = true) {
  if (subscribe) clearLiveSubscriptions();
  const requestedView = params.get('view') || ((!params.get('org') && !params.get('area')) ? 'dashboard' : 'boards');
  if (requestedView !== 'boards') {
    await renderAnalyticsView(requestedView);
    return;
  }
=======
async function renderOperations(params = new URLSearchParams(), subscribe = true) {
  if (subscribe) clearLiveSubscriptions();
>>>>>>> 715a347b7451b6a9039b20eac5a5937a3193b0ee
  const orgId = params.get('org'); const areaId = params.get('area');
  appRoot.innerHTML = shell('operations', currentProfile, '<div class="empty-state"><span>◷</span><b>Carregando seus quadros…</b></div>'); bindSignOut();
  try {
    const memberships = await loadMemberships();
    const areaChoices = [];
    for (const membership of memberships) {
      const names = membership.areaNames || {};
      const ids = new Set(membership.areaIds || []);
      if (membership.canViewAll) {
        const areas = await must(supabase.from('areas').select('id, name, active').eq('org_id', membership.id).order('created_at', { ascending: true }));
        areas.forEach(area => { if (area.active !== false) { ids.add(area.id); names[area.id] = area.name; } });
      }
      for (const id of ids) areaChoices.push({ orgId: membership.id, orgName: membership.organizationName || membership.id, areaId: id, areaName: names[id] || id, role: membership.roles?.[id] || (membership.canManageIncidents ? 'cco' : 'employee'), membership });
    }
    const chosen = areaChoices.find(item => item.orgId === orgId && item.areaId === areaId);
    let boardHtml = '';
    let cards = [];
    if (chosen) {
      const boardRows = await must(supabase.from('boards').select('incident_id').eq('org_id', chosen.orgId).eq('area_id', chosen.areaId));
      const incidentIds = boardRows.map(row => row.incident_id);
      const incidentRows = incidentIds.length ? await must(supabase.from('incidents').select('*').in('id', incidentIds)) : [];
      const statusRowsAll = incidentIds.length ? await must(supabase.from('area_status').select('incident_id, area_id, state').in('incident_id', incidentIds)) : [];
      cards = await Promise.all(incidentIds.map(async incidentId => {
        const row = incidentRows.find(item => item.id === incidentId);
        if (!row) return null;
        const incident = mapIncident(row);
        const statusRows = (incident.assignedAreaIds || []).map(assignedId => {
          const status = statusRowsAll.find(item => item.incident_id === incident.id && item.area_id === assignedId);
          return { areaId: assignedId, name: incident.assignedAreaNames?.[assignedId] || assignedId, state: status ? status.state : 'waiting' };
        });
        const ownStatus = statusRows.find(item => item.areaId === chosen.areaId);
        const updateRows = await must(supabase.from('internal_updates').select('area_id, area_name, role, content, created_at').eq('incident_id', incident.id).order('created_at', { ascending: false }).limit(3));
        return { ...incident, areaState: ownStatus?.state || 'waiting', areaStatuses: statusRows, updates: updateRows.map(item => ({ areaId: item.area_id, areaName: item.area_name, role: item.role, content: item.content, createdAt: item.created_at })) };
      }));
      const canCreate = ['cco', 'admin'].includes(chosen.role) || chosen.membership.canManageIncidents;
      boardHtml = `<section class="board panel"><div class="section-heading"><div><h2>Ocorrências da área</h2><p>Atualizações internas são compartilhadas com as demais áreas vinculadas.</p></div>${canCreate ? '<button class="button primary compact" id="new-incident">＋ Nova ocorrência</button>' : ''}</div>${cards.filter(Boolean).length ? cards.filter(Boolean).sort((a,b)=>toMillis(b.updatedAt)-toMillis(a.updatedAt)).map(card => incidentCard(card, chosen)).join('') : '<div class="empty-state"><span>✳</span><b>Nenhuma ocorrência atribuída</b><p>Novas ocorrências desta área aparecerão neste quadro.</p></div>'}</section>`;
    }
    const grouped = new Map();
    areaChoices.forEach(item => { if (!grouped.has(item.orgId)) grouped.set(item.orgId, { name: item.orgName, areas: [] }); grouped.get(item.orgId).areas.push(item); });
    const chooser = areaChoices.length ? [...grouped.entries()].map(([id, group]) => `<div class="org-group"><h3>${e(group.name)}</h3>${group.areas.map(item => `<a class="org-card ${chosen?.areaId === item.areaId && chosen?.orgId === item.orgId ? 'chosen' : ''}" href="#/operacao?org=${encodeURIComponent(item.orgId)}&area=${encodeURIComponent(item.areaId)}"><span class="org-icon">${e(item.areaName.slice(0,1))}</span><span><b>${e(item.areaName)}</b><small>${e(roleNames[item.role] || item.role)}</small></span><span class="org-arrow">→</span></a>`).join('')}</div>`).join('') : '<div class="empty-state"><span>⌑</span><b>Nenhum acesso operacional atribuído</b><p>Um administrador precisa criar seu vínculo com organização, área e papel.</p></div>';
    const body = `<div class="ops-layout"><section class="ops-main"><div class="section-heading"><div><h2>Organizações e áreas</h2><p>Os espaços disponíveis vêm do seu credenciamento.</p></div></div><div class="org-list">${chooser}</div>${boardHtml}</section><aside class="ops-aside panel"><span class="eyebrow">SUA CONTA</span><h2>${e(currentProfile?.fullName || 'Funcionário')}</h2><p>${e(currentUser.email || '')}</p><div class="permission-note"><b>Acesso vinculado à conta</b><span></span></div></aside></div>`;
    appRoot.innerHTML = shell('operations', currentProfile, body); bindSignOut();
    if (chosen && (['cco', 'admin'].includes(chosen.role) || chosen.membership.canManageIncidents)) {
      document.querySelector('#new-incident')?.addEventListener('click', () => openNewIncident(chosen));
    }
    document.querySelectorAll('[data-update-incident]').forEach(button => button.addEventListener('click', () => openIncidentUpdate(button.dataset.updateIncident, chosen)));
    document.querySelectorAll('[data-publish-incident]').forEach(button => button.addEventListener('click', () => openIncidentUpdate(button.dataset.publishIncident, chosen, true)));
    if (chosen && subscribe) {
      watchForChanges('boards', `area_id=eq.${chosen.areaId}`, () => renderOperations(params));
      const watchedIds = cards.filter(Boolean).map(card => card.id);
      if (watchedIds.length) {
        watchForChanges('internal_updates', `incident_id=in.${inFilter(watchedIds)}`, () => renderOperations(params));
        watchForChanges('area_status', `incident_id=in.${inFilter(watchedIds)}`, () => renderOperations(params));
      }
    }
  } catch (error) { appRoot.querySelector('.workspace')?.insertAdjacentHTML('beforeend', `<div class="form-alert error">${e(errorText(error))}</div>`); }
}

function incidentCard(card, area) {
  const high = ['high', 'critical'].includes(card.priority);
  const updates = card.updates.map(item => `<p><time>${formatDate(item.createdAt)}</time> <b>${e(item.areaName || roleNames[item.role] || item.areaId)}:</b> ${e(item.content)}</p>`).join('');
  const areaStatuses = (card.areaStatuses || []).map(item => `<span class="area-state">${e(item.name)}: <b>${areaStateName(item.state)}</b></span>`).join('');
  const role = area.role;
  const canPublish = ['cco', 'admin', 'customer_service', 'commercial'].includes(role);
  return `<article class="ops-incident"><div><span class="priority-dot ${high ? 'high' : ''}"></span><b>${e(card.flightCode)} · ${e(card.title)}</b><small>${e(card.category)} · ${e(card.status)} · Sua área: ${areaStateName(card.areaState)}</small><p>${e(card.summaryInternal)}</p><div class="area-state-list">${areaStatuses}</div>${updates ? `<div class="area-history">${updates}</div>` : ''}<div class="incident-actions"><button class="text-action" data-update-incident="${e(card.id)}">Registrar atualização da área →</button>${canPublish ? `<button class="text-action" data-publish-incident="${e(card.id)}">Publicar para passageiro ↗</button>` : ''}</div></div></article>`;
}

function areaStateName(value) { return ({ waiting: 'Aguardando', working: 'Em andamento', done: 'Concluída' })[value] || 'Aguardando'; }
function formatDate(value) { return toMillis(value) ? new Date(value).toLocaleString('pt-BR') : 'Agora'; }
function formatTime(value) { return toMillis(value) ? new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''; }

async function openNewIncident(area) {
  const canViewAll = area.membership.canViewAll;
  let areaDocs = [];
  try { const rows = await must(supabase.from('areas').select('id, name, active').eq('org_id', area.orgId).order('created_at', { ascending: true })); areaDocs = rows.filter(item => item.active !== false).map(item => ({ id: item.id, name: item.name })); }
  catch (error) { alert(errorText(error)); return; }
  if (!canViewAll) { alert('Seu credenciamento precisa permitir encaminhar ocorrências para outras áreas da organização.'); return; }
  const dialog = document.createElement('dialog'); dialog.className = 'modal';
  dialog.innerHTML = `<form id="new-incident-form"><button type="button" class="modal-close" aria-label="Fechar">×</button><span class="eyebrow">REGISTRO OPERACIONAL</span><h2>Nova ocorrência</h2><p>Selecione as áreas que precisam acompanhar. Todas recebem a mesma ocorrência e linha do tempo.</p><label>Voo<input name="flight" placeholder="AD 4281" required></label><label>Título<input name="title" placeholder="Resumo curto da ocorrência" required></label><div class="form-pair"><label>Categoria<select name="category"><option>Manutenção</option><option>Clima</option><option>Operação aeroportuária</option><option>Outro</option></select></label><label>Prioridade<select name="priority"><option value="normal">Normal</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label></div><fieldset class="area-picker"><legend>Áreas envolvidas</legend>${areaDocs.map(item => `<label><input type="checkbox" name="areas" value="${e(item.id)}" ${item.id === area.areaId ? 'checked disabled' : ''}>${e(item.name)}${item.id === area.areaId ? ' (sua área)' : ''}</label>`).join('')}</fieldset><label>Resumo interno<textarea name="summary" rows="3" placeholder="Contexto inicial e próximo passo" required></textarea></label><p class="form-error" data-error></p><button type="submit" class="button primary submit-button">Criar ocorrência</button></form>`;
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('.modal-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const button = formElement.querySelector('button[type="submit"]'); button.disabled = true; showError(formElement, '');
    const selectedAreas = [...new Set([area.areaId, ...form.getAll('areas').map(String)])];
    try {
      // Cria ocorrência + cartões dos quadros numa única transação validada no banco (função create_incident).
      await must(supabase.rpc('create_incident', { p_org_id: area.orgId, p_flight_code: String(form.get('flight')).trim().toUpperCase(), p_title: String(form.get('title')).trim(), p_category: String(form.get('category')), p_priority: String(form.get('priority')), p_summary: String(form.get('summary')).trim(), p_area_ids: selectedAreas }));
      dialog.close(); await render();
    } catch (error) { showError(formElement, errorText(error)); button.disabled = false; }
  });
}

async function openIncidentUpdate(incidentId, area, publishOnly = false) {
  let incidentRow = null;
  try { incidentRow = await must(supabase.from('incidents').select('*').eq('id', incidentId).maybeSingle()); }
  catch (error) { alert(errorText(error)); return; }
  if (!incidentRow) return;
  const incident = mapIncident(incidentRow);
  const dialog = document.createElement('dialog'); dialog.className = 'modal';
  const canPublish = ['cco', 'admin', 'customer_service', 'commercial'].includes(area.role);
  dialog.innerHTML = `<form id="update-form"><button type="button" class="modal-close" aria-label="Fechar">×</button><span class="eyebrow">${e(incident.flightCode)} · ${e(area.areaName)}</span><h2>${publishOnly ? 'Publicar atualização' : 'Atualizar ocorrência'}</h2><p>${publishOnly ? 'Escreva somente o que está confirmado e pode ser compartilhado com o passageiro.' : 'Registre o avanço da sua área. As equipes vinculadas compartilham o mesmo histórico.'}</p>${publishOnly ? '' : `<label>Atualização interna<textarea name="content" rows="3" placeholder="O que mudou? Qual é o próximo passo?"></textarea></label><label>Estado da sua área<select name="areaState"><option value="waiting">Aguardando</option><option value="working">Em andamento</option><option value="done">Concluída</option></select></label>`}${canPublish ? `<fieldset class="public-compose"><legend>Mensagem para o passageiro${publishOnly ? '' : ' (opcional)'}</legend><label>Status público<input name="publicStatus" placeholder="Ex.: Inspeção técnica em andamento" ${publishOnly ? 'required' : ''}></label><label>Mensagem<textarea name="publicMessage" rows="3" placeholder="Explique com linguagem simples." ${publishOnly ? 'required' : ''}></textarea></label><label>Próxima atualização prevista<input name="nextUpdate" type="datetime-local"></label></fieldset>` : ''}<p class="form-error" data-error></p><button type="submit" class="button primary submit-button">${publishOnly ? 'Publicar mensagem' : 'Salvar atualização'}</button></form>`;
  document.body.append(dialog); dialog.showModal(); dialog.querySelector('.modal-close').addEventListener('click', () => dialog.close()); dialog.addEventListener('close', () => dialog.remove());
  dialog.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const button = formElement.querySelector('button[type="submit"]'); button.disabled = true; showError(formElement, '');
    try {
      const content = String(form.get('content') || '').trim();
      const message = String(form.get('publicMessage') || '').trim();
      const publicStatus = String(form.get('publicStatus') || '').trim();
      if (message && !publicStatus) { showError(formElement, 'Informe o status público para publicar a mensagem.'); button.disabled = false; return; }
      const next = form.get('nextUpdate') ? new Date(String(form.get('nextUpdate'))) : null;
      // Histórico interno + estado da área + comunicado público numa única transação (função register_incident_update).
      await must(supabase.rpc('register_incident_update', { p_incident_id: incidentId, p_area_id: area.areaId, p_content: content || null, p_area_state: publishOnly ? null : String(form.get('areaState')), p_public_status: message ? publicStatus : null, p_public_message: message || null, p_next_update_at: next && !Number.isNaN(next.getTime()) ? next.toISOString() : null }));
      dialog.close(); await render();
    } catch (error) { showError(formElement, errorText(error)); button.disabled = false; }
  });
}

async function refreshProfile() {
  if (!currentUser) { currentProfile = null; return; }
  const row = await must(supabase.from('profiles').select('id, full_name, email, account_type, created_at').eq('id', currentUser.id).maybeSingle());
  currentProfile = row ? { id: row.id, fullName: row.full_name, email: row.email, accountType: row.account_type, createdAt: row.created_at } : null;
}

async function handleAuthChange(user) {
  currentUser = user;
  try { await refreshProfile(); } catch { currentProfile = null; }
  authReady = true;
  const { path } = route();
  if (user && currentProfile && ['/login', '/cadastro', '/operacao/login'].includes(path) && (path !== '/operacao/login' || currentProfile.accountType === 'employee')) {
    go(currentProfile.accountType === 'employee' ? '/operacao' : path === '/operacao/login' ? '/operacao' : '/cliente');
  } else await render();
}

if (supabase) {
  // Equivalente ao onAuthStateChanged: só reage quando a conta muda (não a cada renovação de token).
  let lastUserId;
  supabase.auth.onAuthStateChange((event, session) => {
    const user = session?.user || null;
    if (event !== 'INITIAL_SESSION' && (user?.id || null) === lastUserId) return;
    lastUserId = user?.id || null;
    setTimeout(() => handleAuthChange(user), 0);
  });
} else {
  authReady = true;
  render();
}
window.addEventListener('hashchange', () => { clearLiveSubscriptions(); render(); });

<<<<<<< HEAD
=======
const paragrafos = document.querySelectorAll('p');

paragrafos.forEach(function(p) {
  p.style.color = "purple";
});
>>>>>>> 715a347b7451b6a9039b20eac5a5937a3193b0ee
