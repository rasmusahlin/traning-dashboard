/* Account-scoped cache. Pending edits are never silently replayed over a newer cloud profile. */
const TrainingProfile = (() => {
  const defaults = () => ({
    goal: { distanceKm: 10, targetSeconds: 2400, targetDate: '', label: '10 km under 40 minuter' },
    daysPerWeek: 4, weeklyMinutes: 240, availableDays: [1, 3, 5, 6],
    coverageStart: '', coverageThrough: '', hrRest: 60, hrMax: 190,
    activityOverrides: {}, activityTags: {}, planPreferences: {}
  });
  let owner = null;
  let current = defaults();
  let revision = 0;
  let pending = null;
  let loaded = false;
  let status = 'Inställningar har inte hämtats.';
  let saveQueue = Promise.resolve();
  const copy = value => JSON.parse(JSON.stringify(value));
  const key = () => `training_profile_v1:${owner}`;
  const merge = (base, patch) => ({ ...base, ...patch,
    goal: { ...base.goal, ...patch.goal },
    activityTags: { ...base.activityTags, ...patch.activityTags },
    activityOverrides: { ...base.activityOverrides, ...patch.activityOverrides },
    planPreferences: { ...base.planPreferences, ...patch.planPreferences }
  });
  function mergePatch(base, patch) {
    const result = { ...base, ...patch };
    for (const name of ['goal', 'activityTags', 'activityOverrides', 'planPreferences']) {
      if (base[name] || patch[name]) result[name] = { ...base[name], ...patch[name] };
    }
    return result;
  }
  function persist() {
    if (!owner) return;
    localStorage.setItem(key(), JSON.stringify({ settings: current, revision, pending }));
  }
  function notify() {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('training-profile-change', { detail: { status } }));
  }
  function validate(profile) {
    if (!Number.isFinite(profile.hrRest) || profile.hrRest < 30 || profile.hrRest > 120 ||
        !Number.isFinite(profile.hrMax) || profile.hrMax < 100 || profile.hrMax > 240 || profile.hrRest >= profile.hrMax) throw new Error('Kontrollera vilopuls och maxpuls.');
    if (!Number.isFinite(profile.goal.distanceKm) || profile.goal.distanceKm < 1 || profile.goal.distanceKm > 200 ||
        !Number.isFinite(profile.goal.targetSeconds) || profile.goal.targetSeconds < 60 || profile.goal.targetSeconds > 172800) throw new Error('Ange en giltig måldistans och måltid.');
    if (!Number.isInteger(profile.daysPerWeek) || profile.daysPerWeek < 1 || profile.daysPerWeek > 7 ||
        !Number.isFinite(profile.weeklyMinutes) || profile.weeklyMinutes < 20 || profile.weeklyMinutes > 3000) throw new Error('Kontrollera antal pass och tillgänglig träningstid.');
    if (!Array.isArray(profile.availableDays) || !profile.availableDays.length ||
        new Set(profile.availableDays).size !== profile.availableDays.length ||
        profile.availableDays.some(n => !Number.isInteger(n) || n < 0 || n > 6) || profile.availableDays.length < profile.daysPerWeek) throw new Error('Välj minst lika många tillgängliga dagar som önskat antal löppass.');
    const validDate = value => { const date = new Date(`${value}T12:00:00Z`); return !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value); };
    if (![profile.goal.targetDate, profile.coverageStart, profile.coverageThrough].every(validDate)) throw new Error('Kontrollera datumen.');
    if (profile.coverageStart && profile.coverageThrough && profile.coverageStart > profile.coverageThrough) throw new Error('Startdatum måste komma före slutdatum.');
  }
  function enqueue(work) {
    const result = saveQueue.catch(() => {}).then(work);
    saveQueue = result;
    return result;
  }
  async function loadNow() {
    const session = await getValidSession();
    const id = session?.user?.id;
    if (!id) { owner = null; current = defaults(); loaded = false; pending = null; status = 'Logga in för personliga inställningar.'; return get(); }
    if (owner !== id) {
      owner = id; current = defaults(); revision = 0; pending = null; loaded = false;
      try {
        const cached = JSON.parse(localStorage.getItem(key()) || 'null');
        if (cached) { current = merge(defaults(), cached.settings || {}); revision = cached.revision || 0; pending = cached.pending || null; }
      } catch (_) { status = 'Den lokala inställningskopian kunde inte läsas.'; }
    }
    try {
      const rows = await dbQuery('training_profiles?select=settings,revision,updated_at');
      const row = rows[0] || { settings: {}, revision: 0 };
      if (pending) {
        status = row.revision === revision
          ? 'Lokala ändringar väntar på synkning. Spara igen under Mål & inställningar.'
          : 'Konflikt: både lokala och gemensamma inställningar har ändrats. Välj version under Mål & inställningar.';
      } else {
        current = merge(defaults(), row.settings); revision = row.revision;
        status = 'Synkat mellan dina enheter.';
      }
    } catch (_) { status = 'Endast lokal kopia. Gemensamma inställningar kunde inte hämtas.'; }
    loaded = true;
    persist(); notify();
    return get();
  }
  function get() { return copy(current); }
  function load() { return enqueue(loadNow); }
  async function saveNow(patch) {
      const session = await getValidSession();
      if (!session?.user?.id) throw new Error('Logga in innan du sparar.');
      if (owner !== session.user.id || !loaded) await loadNow();
      const next = merge(current, patch);
      validate(next);
      pending = pending ? mergePatch(pending, patch) : copy(patch);
      current = next;
      persist();
      try {
        const result = await dbQuery('rpc/save_training_profile', { method: 'POST', body: JSON.stringify({ p_patch: pending, p_revision: revision }) });
        current = merge(defaults(), result.settings); revision = result.revision; pending = null;
        status = 'Sparat och synkat mellan dina enheter.';
      } catch (error) {
        status = String(error.message).includes('PROFILE_CONFLICT')
          ? 'Konflikt: nyare uppgifter finns på en annan enhet. Din ändring finns lokalt; välj version nedan.'
          : 'Sparat lokalt, inte synkat. Kontrollera anslutningen och att databasuppdateringen är installerad.';
      }
      persist(); notify(); return { synced: !pending, status };
  }
  function save(patch) { return enqueue(() => saveNow(copy(patch))); }
  function useCloud() { return enqueue(async () => {
    const session = await getValidSession();
    if (!session?.user?.id || owner !== session.user.id) throw new Error('Ladda om sidan innan du väljer inställningar.');
    const rows = await dbQuery('training_profiles?select=settings,revision,updated_at');
    pending = null;
    current = merge(defaults(), rows[0]?.settings || {});
    revision = rows[0]?.revision || 0;
    status = 'Gemensamma inställningar hämtade.';
    persist(); notify();
    return get();
  }); }
  function retryLocal() { return enqueue(async () => {
    const session = await getValidSession();
    if (!session?.user?.id || owner !== session.user.id) throw new Error('Ladda om sidan innan du väljer inställningar.');
    if (!pending) return { synced: true, status };
    const rows = await dbQuery('training_profiles?select=settings,revision');
    revision = rows[0]?.revision || 0;
    // Only the explicit pending edits overwrite the cloud version; retain all other cloud fields.
    const edits = copy(pending);
    current = merge(merge(defaults(), rows[0]?.settings || {}), edits);
    return saveNow(edits);
  }); }
  return { load, get, save, useCloud, retryLocal, validate, defaults,
    get status() { return status; }, get hasPending() { return !!pending; } };
})();
