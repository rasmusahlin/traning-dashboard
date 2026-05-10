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

function loadAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function saveAuthSession(data) {
  const providedExpiry = data.expires_at ? Number(data.expires_at) : null;
  const expiresAt = providedExpiry
    ? (providedExpiry < 1000000000000 ? providedExpiry * 1000 : providedExpiry)
    : (Date.now() + ((data.expires_in || 3600) * 1000));
  authSession = { ...data, expires_at: expiresAt };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authSession));
  return authSession;
}

function clearAuthSession() {
  authSession = null;
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

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
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
  gate.innerHTML = `
    <form class="auth-card" id="auth-form">
      <div class="auth-title">Logga in</div>
      <div class="auth-copy">Använd Supabase-kontot som äger dashboardens data.</div>
      <label class="auth-label" for="auth-email">E-post</label>
      <input id="auth-email" type="email" autocomplete="email" required>
      <label class="auth-label" for="auth-password">Lösenord</label>
      <input id="auth-password" type="password" autocomplete="current-password" required>
      <button class="btn btn-primary auth-submit" type="submit">Logga in</button>
      <div class="auth-error" id="auth-error">${escapeHtml(message)}</div>
    </form>`;
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
}

function hideAuthGate() {
  document.getElementById('auth-gate')?.remove();
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

async function dbQuery(path, opts = {}) {
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
    throw new Error(await res.text());
  }
  return res.status === 204 ? null : res.json();
}

async function dbInsert(table, data, opts = {}) {
  return dbQuery(table, {
    method: 'POST',
    headers: { 'Prefer': opts.upsert ? 'resolution=merge-duplicates,return=representation' : 'return=representation' },
    body: JSON.stringify(data)
  });
}

// HR zone config (editable via settings)
function getHRConfig() {
  const max = parseInt(localStorage.getItem('hr_max') || '190');
  return {
    max,
    zones: [
      { num: 1, name: 'Z1 Återhämtning', min: 0,        max: max * 0.60, color: '#1d9e75' },
      { num: 2, name: 'Z2 Aerob bas',    min: max * 0.60, max: max * 0.70, color: '#185FA5' },
      { num: 3, name: 'Z3 Tempo',        min: max * 0.70, max: max * 0.80, color: '#ba7517' },
      { num: 4, name: 'Z4 Tröskel',      min: max * 0.80, max: max * 0.90, color: '#d85a30' },
      { num: 5, name: 'Z5 Max',          min: max * 0.90, max: Infinity,   color: '#e24b4a' }
    ]
  };
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
