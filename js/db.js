const SUPA_URL = 'https://mpmtvydpiihfltldaxkt.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1wbXR2eWRwaWloZmx0bGRheGt0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY1MDM2MDgsImV4cCI6MjA5MjA3OTYwOH0.b6-ozK_9nqc3tJE4Lq29imWnfWcCcn3x3WITOa_QLDk';

const DB_HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPA_KEY,
  'Authorization': 'Bearer ' + SUPA_KEY
};

async function dbQuery(path, opts = {}) {
  const res = await fetch(SUPA_URL + '/rest/v1/' + path, {
    ...opts,
    headers: { ...DB_HEADERS, ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error(await res.text());
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
