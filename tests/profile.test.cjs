const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../js/profile.js'), 'utf8');

function setup(hooks = {}) {
  const storage = new Map();
  let user = 'user-a';
  let online = true;
  const cloud = new Map();
  const context = vm.createContext({
    console, Date, JSON, Promise, Number, Set, CustomEvent: class {},
    window: { dispatchEvent() {} },
    localStorage: { getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value) },
    getValidSession: async () => user ? { user: { id: user } } : null,
    dbQuery: async (url, options) => {
      if (!online) throw new Error('Offline');
      const row = cloud.get(user) || { settings: {}, revision: 0 };
      if (!options) {
        if (hooks.beforeProfileRead) await hooks.beforeProfileRead({ user, row });
        return cloud.has(user) ? [row] : [];
      }
      if (url === 'rpc/save_training_profile' && hooks.beforeProfileWrite) {
        await hooks.beforeProfileWrite({ user, row });
      }
      const { p_revision, p_patch } = JSON.parse(options.body);
      if (row.revision !== p_revision) throw new Error('PROFILE_CONFLICT');
      const settings = { ...row.settings, ...p_patch };
      for (const k of ['activityTags','activityOverrides']) if (p_patch[k]) settings[k] = { ...row.settings[k], ...p_patch[k] };
      const next = { settings, revision: row.revision + 1 };
      cloud.set(user, next); return next;
    }
  });
  vm.runInContext(source + '\nthis.api = TrainingProfile;', context);
  return { api: context.api, storage, cloud, setUser: id => { user = id; }, offline: () => { online = false; }, online: () => { online = true; } };
}

test('account caches and pending changes do not cross accounts or signed-out state', async () => {
  const h = setup(); await h.api.load();
  h.offline(); await h.api.save({ hrRest: 52 });
  assert.equal(h.api.hasPending, true);
  h.setUser('user-b'); h.online(); await h.api.load();
  assert.equal(h.api.get().hrRest, 60);
  assert.equal(h.api.hasPending, false);
  h.setUser('user-a'); await h.api.load();
  assert.equal(h.api.get().hrRest, 52);
  h.setUser(null); await h.api.load();
  assert.equal(h.api.get().hrRest, 60);
});

test('a newer cloud revision never silently loses pending local work', async () => {
  const h = setup(); await h.api.load(); h.offline();
  await h.api.save({ hrRest: 52 });
  h.cloud.set('user-a', { settings: { hrRest: 65, hrMax: 198 }, revision: 1 });
  h.online(); await h.api.load();
  assert.equal(h.api.get().hrRest, 52);
  assert.match(h.api.status, /Konflikt/);
  const failed = await h.api.save({ weeklyMinutes: 200 });
  assert.equal(failed.synced, false);
  assert.equal(h.cloud.get('user-a').settings.hrRest, 65);
  const resolved = await h.api.retryLocal();
  assert.equal(resolved.synced, true);
  assert.equal(h.cloud.get('user-a').settings.hrRest, 52);
  assert.equal(h.api.get().hrMax, 198);
  assert.equal(h.api.get().goal.targetSeconds, 2400);
});

test('failed cloud resolution retains queued edits for retry', async () => {
  const h = setup(); await h.api.load(); h.offline(); await h.api.save({ hrRest: 53 });
  await assert.rejects(h.api.useCloud());
  assert.equal(h.api.hasPending, true);
  assert.equal(h.api.get().hrRest, 53);
});

test('serialized saves preserve independent edits and profile object cannot be mutated by callers', async () => {
  const h = setup(); await h.api.load();
  await Promise.all([h.api.save({ hrRest: 55 }), h.api.save({ weeklyMinutes: 180 })]);
  assert.equal(h.api.get().hrRest, 55);
  assert.equal(h.api.get().weeklyMinutes, 180);
  const copy = h.api.get(); copy.goal.distanceKm = 99;
  assert.equal(h.api.get().goal.distanceKm, 10);
  await assert.rejects(h.api.save({ hrRest: 200 }), /puls/);
  await assert.rejects(h.api.save({ availableDays: [1], daysPerWeek: 4 }), /dagar/);
  await assert.rejects(h.api.save({ goal: { targetDate: '2026-02-31' } }), /datumen/);
});

test('cloud selection waits for an in-flight save and keeps the saved revision', async () => {
  let releaseWrite;
  let releaseRead;
  let writeStarted;
  let readStartedResolve;
  const writeReady = new Promise(resolve => { writeStarted = resolve; });
  const readStarted = new Promise(resolve => { readStartedResolve = resolve; });
  let race = false;
  let firstWrite = true;
  let firstRead = true;
  const h = setup({
    beforeProfileWrite: async () => {
      if (!race || !firstWrite) return;
      firstWrite = false;
      writeStarted();
      await new Promise(resolve => { releaseWrite = resolve; });
    },
    beforeProfileRead: async () => {
      if (!race || !firstRead) return;
      firstRead = false;
      readStartedResolve();
      await new Promise(resolve => { releaseRead = resolve; });
    }
  });
  await h.api.load();
  race = true;
  const saving = h.api.save({ hrRest: 55 });
  await writeReady;
  const choosingCloud = h.api.useCloud();
  await Promise.resolve();
  releaseWrite();
  await saving;
  await readStarted;
  releaseRead();
  await choosingCloud;
  assert.equal(h.api.get().hrRest, 55);
  assert.equal(h.api.hasPending, false);
});

test('retryLocal does not read or enqueue a second save during an in-flight save', async () => {
  let releaseWrite;
  let writeStarted;
  const writeReady = new Promise(resolve => { writeStarted = resolve; });
  let blockWrite = false;
  let profileReads = 0;
  const h = setup({
    beforeProfileWrite: async () => {
      if (!blockWrite) return;
      blockWrite = false;
      writeStarted();
      await new Promise(resolve => { releaseWrite = resolve; });
    },
    beforeProfileRead: async () => { profileReads += 1; }
  });
  await h.api.load();
  h.offline();
  await h.api.save({ hrRest: 52 });
  h.online();
  blockWrite = true;
  const saving = h.api.save({ weeklyMinutes: 180 });
  await writeReady;
  const retrying = h.api.retryLocal();
  await Promise.resolve();
  assert.equal(profileReads, 1, 'the initial load is the only profile read before the queued save finishes');
  releaseWrite();
  await Promise.all([saving, retrying]);
  assert.equal(h.cloud.get('user-a').settings.weeklyMinutes, 180);
});
