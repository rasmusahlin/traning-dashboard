const SUPA_URL = 'https://mpmtvydpiihfltldaxkt.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wbXR2eWRwaWloZmx0bGRheGt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MDM2MDgsImV4cCI6MjA5MjA3OTYwOH0.b6-ozK_9nqc3tJE4Lq29imWnfWcCcn3x3WITOa_QLDk';
const AUTH_STORAGE_KEY = 'training_dashboard_auth_session';

const DB_BASE_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPA_KEY
};

let authSession = loadAuthSession();
let appStartCallback = null;
let appStarted = false;
let authGateState = null;

function loadAuthSession() {
  try {
    const current = sessionStorage.getItem(AUTH_STORAGE_KEY);
    const legacy = current ? null : localStorage.getItem(AUTH_STORAGE_KEY);
    const raw = current || legacy;
    if (!raw) return null;
    const normalized = AppSecurity.normalizeAuthSession(JSON.parse(raw));
    if (!normalized) throw new Error('Invalid stored auth session.');
    if (legacy) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(normalized));
      localStorage.removeItem(AUTH_STORAGE_KEY);
    }
    return normalized;
  } catch(e) {
    sessionStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function saveAuthSession(data) {
  const normalized = AppSecurity.normalizeAuthSession(data);
  if (!normalized) throw new Error('Supabase returnerade en ogiltig session.');
  authSession = normalized;
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authSession));
  localStorage.removeItem(AUTH_STORAGE_KEY);
  return authSession;
}

function clearAuthSession() {
  authSession = null;
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function authHeaders(extra = {}) {
  const token = authSession?.access_token || SUPA_KEY;
  return { ...DB_BASE_HEADERS, 'Authorization': 'Bearer ' + token, ...extra };
}

function sessionIsFresh(session) {
  const expiresAt = Number(session?.expires_at || 0);
  const expiresMs = expiresAt < 1000000000000 ? expiresAt * 1000 : expiresAt;
  return !!(session?.access_token && expiresMs > Date.now() + 60000);
}

async function authRequest(path, opts = {}) {
  return fetch(SUPA_URL + '/auth/v1/' + path, {
    ...opts,
    headers: {
      ...DB_BASE_HEADERS,
      ...(authSession?.access_token ? { 'Authorization': 'Bearer ' + authSession.access_token } : {}),
      ...(opts.headers || {})
    }
  });
}

function authErrorMessage(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed.msg || parsed.message || parsed.error_description || parsed.error || raw;
  } catch(e) {
    return raw || 'Inloggningen misslyckades.';
  }
}

async function refreshAuthSession() {
  if (!authSession?.refresh_token) return null;
  const res = await authRequest('token?grant_type=refresh_token', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: authSession.refresh_token })
  });
  if (!res.ok) {
    clearAuthSession();
    return null;
  }
  return saveAuthSession(await res.json());
}

async function getValidSession() {
  if (sessionIsFresh(authSession)) return authSession;
  return refreshAuthSession();
}

async function requireAuth() {
  const session = await getValidSession();
  if (!session) {
    showAuthGate();
    throw new Error('Logga in för att komma åt databasen.');
  }
  return session;
}

async function signIn(email, password) {
  const res = await authRequest('token?grant_type=password', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) throw new Error(authErrorMessage(await res.text()));
  saveAuthSession(await res.json());
  hideAuthGate();
  injectAuthControls();
  await runStartedApp();
}

async function signOut() {
  try {
    if (authSession?.access_token) await authRequest('logout', { method: 'POST' });
  } catch(e) {}
  clearAuthSession();
  location.reload();
}

function showAuthGate(message = '') {
  const existing = document.getElementById('auth-gate');
  if (existing) {
    const err = document.getElementById('auth-error');
    if (err && message) err.textContent = message;
    return;
  }
  const gate = document.createElement('div');
  gate.id = 'auth-gate';
  gate.className = 'auth-gate';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-labelledby', 'auth-title');
  gate.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-title" id="auth-title">Logga in</div>
      <div class="auth-copy">Använd Supabase-kontot som äger dashboardens data.</div>
      <label class="auth-label" for="auth-email">E-post</label>
      <input id="auth-email" type="email" autocomplete="email" required>
      <label class="auth-label" for="auth-password">Lösenord</label>
      <input id="auth-password" type="password" autocomplete="current-password" required>
      <button class="btn btn-primary auth-submit" type="submit">Logga in</button>
      <div class="auth-error" id="auth-error">${escapeHtml(message)}</div>
    </form>`;
  authGateState = {
    activeElement: document.activeElement,
    background: [...document.body.children].map(element => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden')
    }))
  };
  authGateState.background.forEach(({ element }) => {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  });
  document.body.appendChild(gate);

  document.getElementById('auth-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector('button[type="submit"]');
    const err = document.getElementById('auth-error');
    btn.disabled = true;
    btn.textContent = 'Loggar in...';
    err.textContent = '';
    try {
      await signIn(
        document.getElementById('auth-email').value.trim(),
        document.getElementById('auth-password').value
      );
    } catch(error) {
      err.textContent = error.message;
      btn.disabled = false;
      btn.textContent = 'Logga in';
    }
  });
  document.getElementById('auth-email').focus();
}

function hideAuthGate() {
  document.getElementById('auth-gate')?.remove();
  if (authGateState) {
    authGateState.background.forEach(({ element, inert, ariaHidden }) => {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    });
    if (authGateState.activeElement?.isConnected) authGateState.activeElement.focus();
    authGateState = null;
  }
}

function injectAuthControls() {
  if (document.getElementById('auth-status')) return;
  const nav = document.querySelector('.nav-links');
  if (!nav || !authSession?.user?.email) return;
  const wrap = document.createElement('span');
  wrap.id = 'auth-status';
  wrap.className = 'auth-status';
  wrap.innerHTML = `
    <span class="auth-email" title="${escapeHtml(authSession.user.email)}">${escapeHtml(authSession.user.email)}</span>
    <button class="auth-signout" type="button" onclick="signOut()">Logga ut</button>`;
  nav.appendChild(wrap);
}

async function runStartedApp() {
  if (appStarted || !appStartCallback) return;
  appStarted = true;
  await appStartCallback();
}

async function startApp(onReady) {
  appStartCallback = onReady || null;
  const session = await getValidSession();
  if (!session) {
    showAuthGate();
    return;
  }
  injectAuthControls();
  await runStartedApp();
}

async function dbFetch(path, opts = {}) {
  await requireAuth();
  const res = await fetch(SUPA_URL + '/rest/v1/' + path, {
    ...opts,
    headers: authHeaders(opts.headers || {})
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearAuthSession();
      showAuthGate('Sessionen har gått ut. Logga in igen.');
    }
    throw new Error(AppSecurity.safeErrorMessage(await res.text(), 'Databasförfrågan misslyckades.'));
  }
  return res;
}

async function dbQuery(path, opts = {}) {
  const res = await dbFetch(path, opts);
  return res.status === 204 ? null : res.json();
}

async function dbQueryWithMeta(path, opts = {}) {
  const res = await dbFetch(path, opts);
  const contentRange = res.headers.get('content-range') || '';
  const totalMatch = contentRange.match(/\/(\d+|\*)$/);
  return {
    data: res.status === 204 ? null : await res.json(),
    total: totalMatch && totalMatch[1] !== '*' ? Number(totalMatch[1]) : null
  };
}

async function dbQueryAll(path, options = {}) {
  const pageSize = Math.min(1000, Math.max(1, Number(options.pageSize) || 1000));
  const maxRows = Math.max(pageSize, Number(options.maxRows) || 100000);
  const rows = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    const page = await dbQuery(path, {
      headers: { ...(options.headers || {}), Range: `${from}-${from + pageSize - 1}` }
    });
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (typeof options.onPage === 'function') options.onPage(rows.length);
    if (page.length < pageSize) break;
  }
  if (rows.length >= maxRows) throw new Error(`Datamängden överskrider säkerhetsgränsen ${maxRows} rader.`);
  return rows;
}

async function dbCount(table) {
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error('Ogiltigt tabellnamn.');
  const result = await dbQueryWithMeta(`${table}?select=id&limit=1`, {
    headers: { Prefer: 'count=exact', Range: '0-0' }
  });
  return result.total === null ? (Array.isArray(result.data) ? result.data.length : 0) : result.total;
}

async function dbRpc(name, data) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Ogiltigt RPC-namn.');
  return dbQuery(`rpc/${name}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data || {})
  });
}

async function dbInsert(table, data, opts = {}) {
  return dbQuery(table, {
    method: 'POST',
    headers: { 'Prefer': opts.upsert ? 'resolution=merge-duplicates,return=representation' : 'return=representation' },
    body: JSON.stringify(data)
  });
}

// HR zone config (editable via settings). Uses the Karvonen method / HR reserve.
const DEFAULT_HR_MAX = 190;
const DEFAULT_HR_REST = 60;
const HR_ZONE_DEFS = [
  { num: 1, name: 'Z1 Återhämtning', minPct: 0.00, maxPct: 0.60, label: '<60% HRR',   color: '#1d9e75' },
  { num: 2, name: 'Z2 Aerob bas',    minPct: 0.60, maxPct: 0.70, label: '60–70% HRR', color: '#185FA5' },
  { num: 3, name: 'Z3 Tempo',        minPct: 0.70, maxPct: 0.80, label: '70–80% HRR', color: '#ba7517' },
  { num: 4, name: 'Z4 Tröskel',      minPct: 0.80, maxPct: 0.90, label: '80–90% HRR', color: '#d85a30' },
  { num: 5, name: 'Z5 Max',          minPct: 0.90, maxPct: 1.00, label: '90–100% HRR', color: '#e24b4a' }
];

function validInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function buildHRConfig(maxInput = DEFAULT_HR_MAX, restInput = DEFAULT_HR_REST) {
  const max = validInt(maxInput, DEFAULT_HR_MAX, 100, 240);
  const rest = Math.min(validInt(restInput, DEFAULT_HR_REST, 30, 120), max - 1);
  const reserve = max - rest;
  const bpmAt = pct => rest + reserve * pct;
  return {
    method: 'karvonen',
    max,
    rest,
    resting: rest,
    reserve,
    zones: HR_ZONE_DEFS.map(z => ({
      ...z,
      min: bpmAt(z.minPct),
      max: z.num === 5 ? Infinity : bpmAt(z.maxPct)
    }))
  };
}

function getHRConfig() {
  return buildHRConfig(
    localStorage.getItem('hr_max') || DEFAULT_HR_MAX,
    localStorage.getItem('hr_rest') || DEFAULT_HR_REST
  );
}

function hrZone(bpm) {
  const { zones } = getHRConfig();
  return zones.find(z => bpm >= z.min && bpm < z.max) || zones[0];
}

// Format helpers
function fmtPace(secPerKm) {
  if (!secPerKm || secPerKm <= 0) return '–';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function fmtDuration(seconds) {
  if (!seconds) return '–';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function fmtDist(meters) {
  if (!meters) return '–';
  return (meters / 1000).toFixed(2) + ' km';
}

function fmtDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function toast(msg, duration = 3000) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function activityType(raw = '') {
  const r = raw.toLowerCase();
  if (r.includes('run') || r.includes('löp')) return 'running';
  if (r.includes('strength') || r.includes('gym') || r.includes('styrke')) return 'strength';
  return 'hiking';
}

function typeLabel(t) {
  return { running: 'Löpning', strength: 'Styrketräning', hiking: 'Vandring' }[t] || t;
}

function typeDot(t) {
  return { running: 'RUN', strength: 'STY', hiking: 'VAN' }[t] || '?';
}

function typeDotClass(t) {
  return { running: 'dot-running', strength: 'dot-strength', hiking: 'dot-hiking' }[t] || 'dot-running';
}
