const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
    this.dataset = {};
    this.listeners = {};
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  querySelectorAll() { return []; }
  querySelector() { return null; }
  click() {}
  remove() {}
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return typeof body === 'string' ? body : JSON.stringify(body); }
  };
}

function plan(id, title) {
  return {
    metadata: { name: title, startDate: '2026-09-01', endDate: '2026-12-31' },
    days: [{
      id: `${id}-day`, date: '2026-09-18', week: 1, weekday: 'Fredag', title: 'Lätt pass',
      category: 'easy', workoutType: 'running', optional: false, distanceRangeKm: '5',
      durationRange: '30 min', intensity: 'Lätt', workoutDetails: 'Lugnt', nutritionProfile: 'easy'
    }],
    nutritionProfiles: { easy: { label: 'Lätt', protein_g_per_kg: 1.6, carbs_g_per_kg: 3, fat_g_per_kg: 1 } },
    trainingRules: {}
  };
}

test('plan selector waits for an in-flight write and keeps its original block scope', { timeout: 5000 }, async () => {
  const ids = [
    'plan-loading', 'plan-error', 'plan-app', 'weight-kg', 'four-pass-mode', 'hide-optional',
    'prev-week', 'next-week', 'week-select', 'plan-history-select', 'checkin-form', 'checkin-status',
    'checkin-rpe', 'checkin-hip', 'checkin-sleep', 'checkin-stress', 'checkin-energy',
    'checkin-distance', 'checkin-duration', 'checkin-notes', 'mark-completed', 'mark-scaled',
    'mark-skipped', 'export-logs-btn', 'import-logs-btn', 'import-logs-file', 'import-legacy-local-logs',
    'export-summary-json', 'export-summary-csv', 'activity-link-panel', 'current-plan-proposal',
    'plan-block-label', 'plan-block-status', 'metric-distance-label', 'metric-week', 'metric-week-dates',
    'metric-distance', 'metric-distance-optional', 'metric-quality', 'metric-quality-sub', 'metric-block',
    'metric-block-sub', 'week-summary-label', 'today-card', 'week-plan', 'day-detail', 'nutrition-card',
    'readiness-card', 'block-summary', 'sync-note', 'current-plan-proposal'
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const storage = new FakeStorage();
  storage.setItem('training_plan_weight_kg', '99');
  storage.setItem('training_plan_four_pass_mode', '1');
  storage.setItem('training_plan_hide_optional', '1');
  const document = {
    currentScript: { src: 'https://app.test/plan/plan.js' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    listeners: {}
  };
  let releaseSyncGet;
  let syncGetStartedResolve;
  const syncStarted = new Promise(resolve => { syncGetStartedResolve = resolve; });
  let releaseBlockBPlan;
  let blockBPlanStartedResolve;
  const blockBPlanStarted = new Promise(resolve => { blockBPlanStartedResolve = resolve; });
  let blockBPlanFetches = 0;
  const writes = [];
  const fetch = async (url, options = {}) => {
    const textUrl = String(url);
    if (textUrl.includes('plan-blocks.json')) {
      return response({ activePlanBlockId: 'block-a', blocks: [
        { id: 'block-a', title: 'Aktiv plan', path: 'plan-a.json' },
        { id: 'block-b', title: 'Arkiv plan', path: 'plan-b.json' }
      ] });
    }
    if (textUrl.endsWith('/plan-a.json')) return response(plan('a', 'Aktiv plan'));
    if (textUrl.endsWith('/plan-b.json')) {
      blockBPlanFetches += 1;
      blockBPlanStartedResolve();
      await new Promise(resolve => { releaseBlockBPlan = resolve; });
      return response(plan('b', 'Arkiv plan'));
    }
    if (textUrl.includes('/training_plan_logs?')) {
      const isSyncRead = textUrl.includes('limit=1');
      if (isSyncRead && textUrl.includes('plan_block_id=eq.block-a')) {
        syncGetStartedResolve();
        await new Promise(resolve => { releaseSyncGet = resolve; });
        return response([]);
      }
      return response([]);
    }
    if (textUrl.endsWith('/training_plan_logs')) {
      writes.push({ url: textUrl, body: JSON.parse(options.body) });
      return response([{ ...JSON.parse(options.body), updated_at: '2026-09-18T12:00:00+00:00' }]);
    }
    throw new Error(`Unexpected fetch: ${textUrl}`);
  };
  const core = {
    planState: () => ({ state: 'active', reason: '' }),
    proposeWeeklySchedule: () => ({ startDate: '2026-09-14', endDate: '2026-09-20', sessions: [], cautions: [], rationale: 'Test' }),
    normalizeLogFromCloud: row => ({ ...row, updatedAt: row.updated_at, _cloudUpdatedAt: row.updated_at }),
    mergeLogs: (local, cloud) => ({ merged: { ...cloud, ...local }, pending: Object.keys(local).filter(key => local[key]?._pending), conflicts: [], conflictEntries: {} }),
    matchActivitiesToPlan: () => ({ proposals: [] })
  };
  let initPromise;
  const context = {
    document,
    window: { location: { href: 'https://app.test/plan/' } },
    localStorage: storage,
    fetch,
    PlanCore: core,
    SUPA_URL: 'https://supabase.test',
    authHeaders: () => ({}),
    getValidSession: async () => ({ user: { id: 'user-1' } }),
    dbQueryAll: async () => [],
    TrainingProfile: { load: async () => ({}) },
    toast() {},
    startApp(init) { initPromise = init(); return initPromise; },
    console,
    URL,
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('js/plan.js', 'utf8'), context, { filename: 'js/plan.js' });
  document.listeners.DOMContentLoaded();
  await initPromise;
  assert.equal(elements.get('weight-kg').value, '75', 'unscoped legacy preferences are not imported automatically');
  assert.equal(elements.get('four-pass-mode').checked, false);
  assert.equal(elements.get('hide-optional').checked, false);
  assert.match(elements.get('plan-history-select').innerHTML, /block-b/);

  const form = elements.get('checkin-form');
  elements.get('checkin-status').value = 'completed';
  elements.get('checkin-rpe').value = '4';
  form.listeners.submit({ preventDefault() {} });
  await syncStarted;

  // A second edit during the first request must remain queued locally.
  elements.get('checkin-rpe').value = '5';
  form.listeners.submit({ preventDefault() {} });

  const history = elements.get('plan-history-select');
  const changePromise = history.listeners.change({ target: { value: 'block-b' } });
  await Promise.resolve();
  assert.equal(blockBPlanFetches, 0, 'archive plan must wait for the pending write');

  releaseSyncGet();
  await blockBPlanStarted;
  const oldBlockLog = JSON.parse(storage.getItem('training_plan_logs_v2:user-1:block-a'));
  assert.equal(oldBlockLog['a-day'].rpe, 5);
  assert.equal(oldBlockLog['a-day']._pending, true);
  assert.match(elements.get('sync-note').textContent, /En ändring väntar/);
  assert.doesNotMatch(elements.get('sync-note').textContent, /Synkar/);
  releaseBlockBPlan();
  await changePromise;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.user_id, 'user-1');
  assert.equal(writes[0].body.plan_block_id, 'block-a');
  assert.equal(blockBPlanFetches, 1);
  const blockBLog = storage.getItem('training_plan_logs_v2:user-1:block-b');
  assert.equal(blockBLog, '{}', 'the old block log must not be applied to the new block');
});

test('plan backup preserves metadata and activity links while imported rows stay pending', async () => {
  const ids = [
    'plan-loading', 'plan-error', 'plan-app', 'weight-kg', 'four-pass-mode', 'hide-optional',
    'prev-week', 'next-week', 'week-select', 'plan-history-select', 'checkin-form', 'checkin-status',
    'checkin-rpe', 'checkin-hip', 'checkin-sleep', 'checkin-stress', 'checkin-energy',
    'checkin-distance', 'checkin-duration', 'checkin-notes', 'mark-completed', 'mark-scaled',
    'mark-skipped', 'export-logs-btn', 'import-logs-btn', 'import-logs-file', 'import-legacy-local-logs',
    'export-summary-json', 'export-summary-csv', 'activity-link-panel', 'current-plan-proposal',
    'plan-block-label', 'plan-block-status', 'metric-distance-label', 'metric-week', 'metric-week-dates',
    'metric-distance', 'metric-distance-optional', 'metric-quality', 'metric-quality-sub', 'metric-block',
    'metric-block-sub', 'week-summary-label', 'today-card', 'week-plan', 'day-detail', 'nutrition-card',
    'readiness-card', 'block-summary', 'sync-note', 'current-plan-proposal'
  ];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const storage = new FakeStorage();
  const logsKey = 'training_plan_logs_v2:user-1:block-a';
  const linksKey = 'training_plan_activity_links_v1:user-1:block-a';
  storage.setItem(logsKey, JSON.stringify({
    'a-day': {
      status: 'completed', rpe: 7, notes: 'Syntetisk backup', activityId: 'activity-1',
      planDate: '2026-09-18', planTitle: 'Originaltitel', planType: 'quality',
      updatedAt: '2026-09-18T10:00:00.000Z', _pending: false,
      _cloudUpdatedAt: '2026-09-18T12:00:00.000Z'
    }
  }));
  storage.setItem(linksKey, JSON.stringify({ 'a-day': 'activity-1' }));
  const document = {
    currentScript: { src: 'https://app.test/plan/plan.js' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    },
    createElement() { return new FakeElement('download'); },
    body: { appendChild() {} },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    listeners: {}
  };
  let downloaded = null;
  class TestURL extends URL {}
  TestURL.createObjectURL = blob => { downloaded = blob; return 'blob:test'; };
  TestURL.revokeObjectURL = () => {};
  let initPromise;
  const fetch = async url => {
    const textUrl = String(url);
    if (textUrl.includes('plan-blocks.json')) {
      return response({ activePlanBlockId: 'block-a', blocks: [{ id: 'block-a', title: 'Aktiv plan', path: 'plan-a.json' }] });
    }
    if (textUrl.endsWith('/plan-a.json')) return response(plan('a', 'Aktiv plan'));
    throw new Error(`Unexpected fetch: ${textUrl}`);
  };
  const context = {
    document,
    window: { location: { href: 'https://app.test/plan/' } },
    localStorage: storage,
    fetch,
    AppSecurity: require('../js/security.js'),
    PlanCore: {
      planState: () => ({ state: 'active', reason: '' }),
      proposeWeeklySchedule: () => ({ startDate: '2026-09-14', endDate: '2026-09-20', sessions: [], cautions: [], rationale: 'Test' }),
      normalizeLogFromCloud: row => ({ ...row, updatedAt: row.updated_at, _cloudUpdatedAt: row.updated_at }),
      mergeLogs: (local, cloud) => ({ merged: { ...cloud, ...local }, pending: Object.keys(local).filter(key => local[key]?._pending), conflicts: [], conflictEntries: {} }),
      matchActivitiesToPlan: () => ({ proposals: [] })
    },
    getValidSession: async () => ({ user: { id: 'user-1' } }),
    TrainingProfile: { load: async () => ({}) },
    toast() {},
    prompt: () => 'replace',
    startApp(init) { initPromise = init(); return initPromise; },
    console,
    URL: TestURL,
    Blob,
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('js/plan.js', 'utf8'), context, { filename: 'js/plan.js' });
  document.listeners.DOMContentLoaded();
  await initPromise;

  elements.get('export-logs-btn').listeners.click();
  const exported = JSON.parse(await downloaded.text());
  assert.deepEqual(exported.activityLinks, { 'a-day': 'activity-1' });
  assert.equal(exported.logs['a-day'].planTitle, 'Originaltitel');

  const importedFile = {
    async text() {
      return JSON.stringify({
        app: 'training-dashboard-plan', version: 1, planBlockId: 'block-a',
        logs: {
          'a-day': {
            status: 'completed', rpe: 8, notes: 'Återimporterad', activityId: 'activity-1',
            planDate: '2026-09-18', planTitle: 'Återimporterad titel', planType: 'test',
            updatedAt: '2026-09-19T10:00:00.000Z', _pending: false,
            _cloudUpdatedAt: '2026-09-18T12:00:00.000Z'
          }
        },
        activityLinks: { 'a-day': 'activity-1' }
      });
    }
  };
  const input = elements.get('import-logs-file');
  input.files = [importedFile];
  await input.listeners.change({ target: input });
  await Promise.resolve();
  const restored = JSON.parse(storage.getItem(logsKey));
  assert.equal(restored['a-day'].planDate, '2026-09-18');
  assert.equal(restored['a-day'].planTitle, 'Återimporterad titel');
  assert.equal(restored['a-day'].planType, 'test');
  assert.equal(restored['a-day'].activityId, 'activity-1');
  assert.equal(restored['a-day']._pending, true, 'backup data remains queued for account sync');
  assert.equal(restored['a-day']._cloudUpdatedAt, undefined, 'backup revision is not treated as this account cloud baseline');
  assert.deepEqual(JSON.parse(storage.getItem(linksKey)), { 'a-day': 'activity-1' });

  const beforeRejectedImport = storage.getItem(logsKey);
  input.files = [{
    async text() {
      return JSON.stringify({
        planBlockId: 'block-a',
        logs: { 'a-day': { status: 'completed', activityId: 'activity-1' } },
        activityLinks: { 'other-day': 'activity-1' }
      });
    }
  }];
  await input.listeners.change({ target: input });
  assert.equal(storage.getItem(logsKey), beforeRejectedImport, 'unknown activity links cannot replace account data');

  const historicalId = 'proposal:2026-08-31:2026-09-02';
  const historicalBackup = {
    planBlockId: 'block-a',
    logs: { [historicalId]: { status: 'completed', notes: 'Tidigare vecka', planDate: '2026-09-02', activityId: 'activity-old' } },
    activityLinks: { [historicalId]: 'activity-old' }
  };
  input.files = [{ text: async () => JSON.stringify(historicalBackup) }];
  await input.listeners.change({ target: input });
  const historicalRestored = JSON.parse(storage.getItem(logsKey));
  assert.equal(historicalRestored[historicalId].notes, 'Tidigare vecka');
  assert.equal(historicalRestored[historicalId]._pending, true);
  elements.get('export-logs-btn').listeners.click();
  const historicalExport = JSON.parse(await downloaded.text());
  assert.equal(historicalExport.activityLinks[historicalId], 'activity-old');
  input.files = [{ text: async () => JSON.stringify(historicalExport) }];
  await input.listeners.change({ target: input });
  assert.equal(JSON.parse(storage.getItem(logsKey))[historicalId].notes, 'Tidigare vecka', 'historical proposal export can be restored');

  const beforeInvalidDates = storage.getItem(logsKey);
  for (const invalidId of ['proposal:2026-02-30:2026-03-01', 'proposal:2026-08-31:2026-09-20', 'proposal:2026-08-31:2026-08-30']) {
    input.files = [{ text: async () => JSON.stringify({ planBlockId: 'block-a', logs: { [invalidId]: { status: 'completed' } } }) }];
    await input.listeners.change({ target: input });
    assert.equal(storage.getItem(logsKey), beforeInvalidDates, 'invalid historical identifiers cannot replace account data');
  }
});
