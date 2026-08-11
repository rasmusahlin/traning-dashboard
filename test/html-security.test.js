const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlFiles = [
  'index.html',
  'activity.html',
  'analysis.html',
  'planning.html',
  'upload.html',
  'settings.html',
  'plan/index.html'
];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('all inline page scripts compile', () => {
  for (const file of htmlFiles) {
    const html = read(file);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(match => !/\bsrc\s*=/.test(match[1]));
    scripts.forEach((match, index) => {
      assert.doesNotThrow(
        () => new vm.Script(match[2], { filename: `${file}#inline-${index + 1}` }),
        `${file} contains invalid inline JavaScript`
      );
    });
  }
});

test('every page applies the CSP and loads the security boundary before database code', () => {
  for (const file of htmlFiles) {
    const html = read(file);
    assert.match(html, /http-equiv="Content-Security-Policy"/i, `${file} lacks CSP`);
    assert.match(html, /object-src 'none'/, `${file} allows object embeds`);
    assert.match(html, /connect-src 'self' https:\/\/mpmtvydpiihfltldaxkt\.supabase\.co/);
    assert.doesNotMatch(html, /https:\/\/\*\.supabase\.co/);
    assert.ok(html.indexOf('security.js') < html.indexOf('db.js'), `${file} loads db.js before security.js`);
  }
});

test('known untrusted rendering paths stay outside raw HTML sinks', () => {
  const index = read('index.html');
  const activity = read('activity.html');
  const upload = read('upload.html');
  const plan = read('js/plan.js');

  assert.doesNotMatch(index, /\$\{a\.notes/);
  assert.match(index, /main\.appendChild\(makeTextElement\('div', 'activity-name'/);
  assert.match(activity, /escapeHtml\(v\)/);
  assert.doesNotMatch(activity, /\$\{e\.message\}/);
  assert.doesNotMatch(upload, /msg\.innerHTML\s*=[\s\S]{0,250}file\.name/);
  assert.doesNotMatch(upload, /batchResults\.errors[\s\S]{0,120}join\('<br>'\)/);
  assert.match(upload, /MAX_FIT_FILE_BYTES = 50 \* 1024 \* 1024/);
  assert.match(upload, /MAX_BATCH_FILES = 100/);
  assert.match(plan, /AppSecurity\.normalizePlanLogs/);
});

test('database bootstrap is fail-closed and contains no committed owner address', () => {
  const schema = read('schema.sql');
  const ownerMigration = read('supabase/migrations/001_owner_rls_auth.sql');
  const planMigration = read('supabase/migrations/002_training_plan_logs.sql');

  for (const table of ['activities', 'laps', 'km_splits', 'time_series', 'nutrition_logs']) {
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
    assert.match(schema, new RegExp(`revoke all on table public\\.${table} from public, anon`, 'i'));
  }
  assert.match(planMigration, /revoke all on table public\.training_plan_logs from public, anon/i);
  assert.match(planMigration, /conrelid = 'public\.training_plan_logs'::regclass/i);
  assert.doesNotMatch(ownerMigration, /'[A-Z0-9._%+-]+@(?!example\.invalid)[A-Z0-9.-]+\.[A-Z]{2,}'/i);
  assert.match(ownerMigration, /Replace the owner email placeholder/);
});

test('FIT import is atomic, authenticated and idempotent at the database boundary', () => {
  const upload = read('upload.html');
  const migration = read('supabase/migrations/003_atomic_activity_import.sql');

  assert.match(upload, /dbRpc\('import_activity_bundle'/);
  assert.match(upload, /crypto\.subtle\.digest\('SHA-256'/);
  assert.doesNotMatch(upload, /dbInsert\('laps'/);
  assert.doesNotMatch(upload, /dbInsert\('km_splits'/);
  assert.doesNotMatch(upload, /dbInsert\('time_series'/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /auth\.uid\(\)/i);
  assert.match(migration, /activities_user_source_hash_idx/i);
  assert.match(migration, /revoke all on function public\.import_activity_bundle[\s\S]*from public, anon/i);
  assert.match(migration, /grant execute on function public\.import_activity_bundle[\s\S]*to authenticated/i);
});

test('unsafe setup shortcuts and silent row caps do not return', () => {
  const settings = read('settings.html');
  assert.doesNotMatch(settings, /create table if not exists laps/i);
  assert.match(settings, /Kör aldrig fristående tabell-SQL utan RLS/);

  for (const file of ['index.html', 'analysis.html', 'planning.html']) {
    const html = read(file);
    assert.match(html, /dbQueryAll\(/, `${file} does not use paginated loading`);
    assert.doesNotMatch(html, /activities\?[^'"`]*limit=(1000|2000)/, `${file} has a silent activity cap`);
  }
});

test('auth and destructive controls keep accessible interaction boundaries', () => {
  const db = read('js/db.js');
  const index = read('index.html');
  const upload = read('upload.html');

  assert.match(db, /gate\.setAttribute\('role', 'dialog'\)/);
  assert.match(db, /gate\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(db, /element\.inert = true/);
  assert.match(index, /modal\.setAttribute\('role', 'dialog'\)/);
  assert.match(index, /const link = makeTextElement\('a', 'activity-link'\)/);
  assert.doesNotMatch(index, /row\.setAttribute\('role', 'link'\)/);
  assert.match(upload, /<label for="f-date"/);
  assert.match(upload, /id="drop-zone" role="button" tabindex="0"/);
});

test('plan sync is two-way and analysis copy stays descriptive', () => {
  const plan = read('js/plan.js');
  const analysis = read('analysis.html');
  const planHtml = read('plan/index.html');
  const migration = read('supabase/migrations/004_monotonic_plan_sync.sql');
  assert.match(plan, /loadAndMergeRemoteLogs/);
  assert.match(plan, /AppData\.mergePlanLogs/);
  assert.match(plan, /syncAllLogsToCloud/);
  assert.match(plan, /enqueueSync/);
  assert.match(plan, /rpc\/upsert_training_plan_log/);
  assert.doesNotMatch(plan, /training_plan_logs\?on_conflict/);
  assert.match(plan, /AppSecurity\.normalizePlanLog\(currentCheckInValues\(\)\)/);
  assert.doesNotMatch(plan, /localStorage\.removeItem\(logsKey\(\)\)/);
  assert.match(plan, /Sparat lokalt, men inte synkat/);
  assert.match(planHtml, /id="checkin-distance"[^>]*max="1000"/);
  assert.match(planHtml, /id="checkin-duration"[^>]*max="10080"/);
  assert.match(planHtml, /id="checkin-notes"[^>]*maxlength="4000"/);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /where excluded\.updated_at >= public\.training_plan_logs\.updated_at/i);
  assert.match(migration, /revoke all on function public\.upsert_training_plan_log\(jsonb\) from public, anon/i);
  assert.match(migration, /grant execute on function public\.upsert_training_plan_log\(jsonb\) to authenticated/i);
  assert.doesNotMatch(analysis, /optimala träningsfönstret|hög skaderisk|förbättras hjärtats slagvolym/i);
  assert.match(analysis, /Teoretiskt sub-40-scenario/);
  assert.match(analysis, /extrapolation, inte en tävlingsprognos/i);
  assert.match(analysis, /estimateDateTarget/);
  assert.match(analysis, /id="analysis-period"/);
  assert.match(analysis, /id="analysis-comparison"/);
  assert.match(analysis, /Sub-40-underlag – tre separata signaler/);
  assert.match(analysis, /Väder, underlag, vind, sömn och sjukdom registreras inte/);
  assert.match(analysis, /estimateTargetStability/);
  assert.match(analysis, /filterAnalysisRuns/);
});
