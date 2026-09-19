(() => {
  const scriptUrl = new URL(document.currentScript?.src || window.location.href);
  const registryUrl = new URL('../data/plan-blocks.json', scriptUrl);
  const STORAGE_PREFIX = 'training_plan';
  const DEFAULT_WEIGHT_KG = 75;
  const CORE = typeof PlanCore !== 'undefined' ? PlanCore : {};

  /**
   * @typedef {'rest'|'recovery'|'easy'|'quality'|'long'|'strength'|'test'} NutritionProfileKey
   * @typedef {'planned'|'completed'|'scaled_down'|'skipped'} CheckInStatus
   * @typedef {Object} PlanDay
   * @property {string} date
   * @property {number} week
   * @property {string} weekday
   * @property {string} title
   * @property {string} workoutType
   * @property {string} category
   * @property {boolean} optional
   * @property {string} distanceRangeKm
   * @property {string} durationRange
   * @property {string} intensity
   * @property {string} workoutDetails
   * @property {NutritionProfileKey} nutritionProfile
   * @property {string=} coachNotes
   * @property {string} _planDayId
   * @typedef {Object} NutritionProfile
   * @property {string} label
   * @property {number} protein_g_per_kg
   * @property {number} carbs_g_per_kg
   * @property {number} fat_g_per_kg
   * @property {string} timing
   * @property {string} hydration
   * @typedef {Object} PlanCheckIn
   * @property {CheckInStatus} status
   * @property {?number} rpe
   * @property {?number} hipPain
   * @property {?number} sleepQuality
   * @property {?number} stress
   * @property {?number} energy
   * @property {?number} actualDistanceKm
   * @property {?number} actualDurationMinutes
   * @property {string} notes
   */

  const state = {
    registry: null,
    blockInfo: null,
    plan: null,
    days: [],
    logs: {},
    selectedWeek: 1,
    selectedDayId: null,
    weightKg: DEFAULT_WEIGHT_KG,
    fourPassMode: false,
    hideOptional: false,
    syncDisabled: false,
    ownerId: null,
    syncStatus: 'local',
    pendingSync: {},
    conflicts: {},
    activities: [],
    profile: {},
    activityLinks: {},
    matchProposals: [],
    currentProposal: null,
    viewMode: 'static',
    syncPromise: null
  };

  const statusLabels = {
    planned: 'Planerad',
    completed: 'Klar',
    scaled_down: 'Nedskalad',
    skipped: 'Skippad'
  };

  const categoryLabels = {
    rest: 'Vila',
    recovery: 'Återhämtning',
    easy: 'Lätt',
    quality: 'Kvalitet',
    long: 'Långpass',
    strength: 'Styrka',
    test: 'Test'
  };

  const sessionTypeLabels = {
    easy: 'Lätt',
    quality: 'Kvalitet',
    long: 'Långpass',
    recovery: 'Återhämtning',
    rest: 'Vila',
    strength: 'Styrka',
    test: 'Test'
  };

  const NEUTRAL_DOWNGRADE_COPY = 'Inga specifika nedskalningsregler för detta pass. Håll passet mycket lätt, korta ned vid behov eller vila om kroppen känns sliten.';
  const IMPORT_MODE_PROMPT = [
    'Merge: lägger till importerade loggar. Om samma dag finns både lokalt och i backupen vinner backupens värde.',
    '',
    'Replace: ersätter alla lokala loggar för detta planblock med backupens loggar.',
    '',
    'Skriv "merge" eller "replace".'
  ].join('\n');

  const $ = id => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', () => {
    if (typeof startApp === 'function') startApp(init);
    else init();
  });

  async function init() {
    bindStaticControls();
    loadPreferences();

    try {
      await loadPlanBlock();
      await loadAccountContext();
      state.logs = loadLogs();
      state.activityLinks = loadActivityLinks();
      await Promise.all([loadCloudLogs(), loadTrainingContext()]);
      prepareCurrentProposal();
      state.viewMode = CORE.planState && CORE.planState(state.plan, todayLocalIso()).state === 'expired' ? 'current' : 'static';
      state.matchProposals = buildMatchProposals();
      setInitialSelection();
      render();
      retryPendingSync();
      $('plan-loading').hidden = true;
      $('plan-app').hidden = false;
    } catch (error) {
      $('plan-loading').hidden = true;
      const errorBox = $('plan-error');
      errorBox.hidden = false;
      errorBox.textContent = 'Kunde inte ladda träningsplanen. Kontrollera att data/plan-blocks.json och planens JSON-fil finns.';
      console.error(error);
    }
  }

  function bindStaticControls() {
    $('weight-kg').addEventListener('input', () => {
      const value = parseNumber($('weight-kg').value);
      if (value) {
        state.weightKg = value;
        savePreferencesToProfile();
        renderNutrition();
      }
    });

    $('four-pass-mode').addEventListener('change', event => {
      state.fourPassMode = event.target.checked;
      savePreferencesToProfile();
      ensureVisibleSelection();
      render();
    });

    $('hide-optional').addEventListener('change', event => {
      state.hideOptional = event.target.checked;
      savePreferencesToProfile();
      ensureVisibleSelection();
      render();
    });

    if (typeof window.addEventListener === 'function') {
      window.addEventListener('online', () => retryPendingSync());
    }

    $('prev-week').addEventListener('click', () => changeWeek(-1));
    $('next-week').addEventListener('click', () => changeWeek(1));
    $('week-select').addEventListener('change', event => {
      state.selectedWeek = Number(event.target.value);
      state.selectedDayId = firstVisibleDayForWeek(state.selectedWeek)?._planDayId || null;
      render();
    });

    $('plan-history-select')?.addEventListener('change', async event => {
      if (event.target.value === 'current') {
        if (state.syncPromise) await state.syncPromise;
        const activeBlock = (state.registry?.blocks || []).find(block => block.id === state.registry?.activePlanBlockId);
        if (activeBlock && state.blockInfo?.id !== activeBlock.id) {
          await setPlanBlock(activeBlock);
          state.logs = loadLogs();
          state.activityLinks = loadActivityLinks();
          state.pendingSync = pendingLogEntries(state.logs);
          state.conflicts = {};
          await loadCloudLogs();
        }
        state.viewMode = 'current';
        prepareCurrentProposal();
        state.matchProposals = buildMatchProposals();
        state.selectedDayId = state.currentProposal.sessions.find(session => session.date >= todayLocalIso())?.id || state.currentProposal.sessions[0]?.id || null;
        render();
      } else await selectPlanBlock(event.target.value);
    });

    $('checkin-form').addEventListener('submit', event => {
      event.preventDefault();
      saveCurrentCheckIn();
    });

    $('checkin-form').addEventListener('input', event => {
      if (['checkin-sleep', 'checkin-stress', 'checkin-hip', 'checkin-energy'].includes(event.target.id)) {
        renderReadiness();
      }
    });

    $('mark-completed').addEventListener('click', () => quickStatus('completed'));
    $('mark-scaled').addEventListener('click', () => quickStatus('scaled_down'));
    $('mark-skipped').addEventListener('click', () => quickStatus('skipped'));

    $('export-logs-btn').addEventListener('click', exportLogs);
    $('import-logs-btn').addEventListener('click', () => $('import-logs-file').click());
    $('import-logs-file').addEventListener('change', importLogs);
    $('import-legacy-local-logs')?.addEventListener('click', importLegacyLocalLogs);
    $('export-summary-json').addEventListener('click', () => exportBlockSummary('json'));
    $('export-summary-csv').addEventListener('click', () => exportBlockSummary('csv'));

    $('activity-link-panel')?.addEventListener('click', event => {
      if (event.target.closest('[data-refresh-activities]')) {
        loadTrainingContext().then(() => { state.matchProposals = buildMatchProposals(); render(); toast('Aktiviteter uppdaterade'); });
        return;
      }
      const confirmButton = event.target.closest('[data-confirm-activity]');
      if (confirmButton) confirmActivity(confirmButton.dataset.confirmActivity, confirmButton.dataset.dayId);
      const conflictButton = event.target.closest('[data-resolve-conflict]');
      if (conflictButton) resolveConflict(conflictButton.dataset.resolveConflict, conflictButton.dataset.choice);
    });

    $('current-plan-proposal')?.addEventListener('click', event => {
      const button = event.target.closest('[data-proposal-check]');
      if (button) toggleProposalCheck(button.dataset.proposalCheck);
    });
  }

  function loadPreferences() {
    // Legacy keys are unscoped; never import them automatically across accounts.
    state.weightKg = DEFAULT_WEIGHT_KG;
    state.fourPassMode = false;
    state.hideOptional = false;
    $('weight-kg').value = String(state.weightKg);
    $('four-pass-mode').checked = state.fourPassMode;
    $('hide-optional').checked = state.hideOptional;
  }

  async function loadPlanBlock() {
    const registry = await fetchJson(registryUrl);
    const activeId = registry.activePlanBlockId;
    const blockInfo = (registry.blocks || []).find(block => block.id === activeId) || registry.blocks?.[0];
    if (!blockInfo) throw new Error('No plan block configured.');
    state.registry = registry;
    await setPlanBlock(blockInfo);
  }

  async function selectPlanBlock(blockId) {
    const blockInfo = (state.registry?.blocks || []).find(block => block.id === blockId);
    if (!blockInfo) return;
    if (state.syncPromise) await state.syncPromise;
    await setPlanBlock(blockInfo);
    state.viewMode = 'static';
    state.logs = loadLogs();
    state.activityLinks = loadActivityLinks();
    state.pendingSync = pendingLogEntries(state.logs);
    state.conflicts = {};
    await loadCloudLogs();
    state.matchProposals = buildMatchProposals();
    setInitialSelection();
    render();
    retryPendingSync();
  }

  async function setPlanBlock(blockInfo) {
    const planUrl = new URL(blockInfo.path, registryUrl);
    const plan = await fetchJson(planUrl);
    const days = (plan.days || []).map(day => ({
      ...day,
      _planDayId: day.id || day.planDayId || day.date
    }));
    state.blockInfo = blockInfo;
    state.plan = plan;
    state.days = days;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    return res.json();
  }

  async function loadAccountContext() {
    let session = null;
    try { session = typeof getValidSession === 'function' ? await getValidSession() : null; } catch (_) { session = null; }
    state.ownerId = session?.user?.id || null;
    if (typeof TrainingProfile !== 'undefined' && typeof TrainingProfile.load === 'function') {
      try { state.profile = await TrainingProfile.load(); } catch (_) { state.profile = {}; }
    }
    const prefs = state.profile?.planPreferences || {};
    if (Number.isFinite(Number(prefs.weightKg))) state.weightKg = Number(prefs.weightKg);
    if (typeof prefs.fourPassMode === 'boolean') state.fourPassMode = prefs.fourPassMode;
    if (typeof prefs.hideOptional === 'boolean') state.hideOptional = prefs.hideOptional;
    const weightInput = $('weight-kg');
    if (weightInput) weightInput.value = String(state.weightKg);
    if ($('four-pass-mode')) $('four-pass-mode').checked = state.fourPassMode;
    if ($('hide-optional')) $('hide-optional').checked = state.hideOptional;
  }

  async function loadTrainingContext() {
    if (!state.ownerId || typeof dbQueryAll !== 'function') {
      state.activities = [];
      state.syncStatus = state.ownerId ? 'local' : 'local-only';
      return;
    }
    try {
      state.activities = await dbQueryAll('activities?order=activity_date.desc', 500) || [];
      state.syncStatus = state.syncStatus === 'synced' ? state.syncStatus : 'online';
    } catch (error) {
      state.activities = [];
      state.syncStatus = 'local-offline';
      console.debug('Kunde inte hämta aktiviteter:', error);
    }
  }

  function prepareCurrentProposal() {
    state.currentProposal = CORE.proposeWeeklySchedule
      ? CORE.proposeWeeklySchedule({ today: todayLocalIso(), activities: state.activities, profile: state.profile })
      : { sessions: [], startDate: todayLocalIso(), endDate: todayLocalIso(), cautions: [], rationale: '' };
    return state.currentProposal;
  }

  async function loadCloudLogs() {
    if (!state.ownerId || typeof SUPA_URL === 'undefined' || typeof authHeaders !== 'function') {
      state.syncStatus = 'local-only';
      return;
    }
    try {
      const query = `plan_block_id=eq.${encodeURIComponent(state.blockInfo.id)}&select=*`;
      const response = await fetch(`${SUPA_URL}/rest/v1/training_plan_logs?${query}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(await response.text());
      const rows = await response.json();
      const cloud = {};
      rows.forEach(row => {
        cloud[row.plan_day_id] = CORE.normalizeLogFromCloud ? CORE.normalizeLogFromCloud(row) : row;
        if (row.activity_id) state.activityLinks[row.plan_day_id] = String(row.activity_id);
      });
      saveActivityLinks();
      const result = CORE.mergeLogs ? CORE.mergeLogs(state.logs, cloud) : { merged: { ...cloud, ...state.logs }, pending: [], conflicts: [] };
      state.logs = result.merged;
      state.pendingSync = Object.fromEntries((result.pending || []).map(key => [key, true]));
      state.conflicts = result.conflictEntries || Object.fromEntries((result.conflicts || []).map(key => [key, true]));
      saveLogs();
      state.syncStatus = Object.keys(state.conflicts).length ? 'conflict' : 'synced';
    } catch (error) {
      state.syncStatus = 'local-offline';
      console.debug('Training plan cloud read failed:', error);
    }
  }

  function cloudLogPayload(day, checkIn, blockId = state.blockInfo.id, ownerId = state.ownerId) {
    return {
      user_id: ownerId,
      plan_block_id: blockId,
      plan_day_id: day._planDayId || day.id || day.date,
      plan_date: day.date,
      status: checkIn.status || 'planned',
      rpe: checkIn.rpe,
      hip_pain: checkIn.hipPain,
      sleep_quality: checkIn.sleepQuality,
      stress: checkIn.stress,
      energy: checkIn.energy,
      actual_distance_km: checkIn.actualDistanceKm,
      actual_duration_minutes: checkIn.actualDurationMinutes,
      notes: checkIn.notes || null,
      activity_id: checkIn.activityId || null,
      activity_link_status: checkIn.activityId ? 'confirmed' : 'manual',
      updated_at: checkIn.updatedAt || new Date().toISOString()
    };
  }

  function sameTimestamp(left, right) {
    return typeof left === 'string' && left.length > 0
      && typeof right === 'string' && right.length > 0
      && left === right;
  }

  async function syncOneLog(dayId) {
    if (!state.ownerId || !state.pendingSync[dayId]) return;
    const day = findAnyDay(dayId);
    const local = state.logs[dayId];
    if (!day || !local || typeof SUPA_URL === 'undefined' || typeof authHeaders !== 'function') return;
    // Keep an in-flight write tied to the scope it started in. A user can change
    // the archive selector while the request is in flight; that must never send
    // the old log to the newly selected block or mutate the new block's state.
    const scopeBlockId = state.blockInfo?.id;
    const scopeOwnerId = state.ownerId;
    const localUpdatedAt = local.updatedAt;
    const daySnapshot = { ...day };
    const base = `${SUPA_URL}/rest/v1/training_plan_logs`;
    try {
      const query = `plan_block_id=eq.${encodeURIComponent(scopeBlockId)}&plan_day_id=eq.${encodeURIComponent(dayId)}&select=*&limit=1`;
      const remoteResponse = await fetch(`${base}?${query}`, { headers: authHeaders() });
      if (!remoteResponse.ok) throw new Error(await remoteResponse.text());
      const remoteRows = await remoteResponse.json();
      const remote = remoteRows[0];
      const baseline = local._cloudUpdatedAt || null;
      if (state.blockInfo?.id !== scopeBlockId || state.ownerId !== scopeOwnerId) return;
      if ((baseline && !remote) || (baseline && remote && !sameTimestamp(remote.updated_at, baseline)) || (!baseline && remote)) {
        state.conflicts[dayId] = { local: { ...local }, cloud: CORE.normalizeLogFromCloud ? CORE.normalizeLogFromCloud(remote) : remote };
        state.syncStatus = 'conflict';
        return;
      }
      const payload = cloudLogPayload(daySnapshot, local, scopeBlockId, scopeOwnerId);
      const writeUrl = remote
        ? `${base}?user_id=eq.${encodeURIComponent(scopeOwnerId)}&plan_block_id=eq.${encodeURIComponent(scopeBlockId)}&plan_day_id=eq.${encodeURIComponent(dayId)}&updated_at=eq.${encodeURIComponent(remote.updated_at)}`
        : base;
      const response = await fetch(writeUrl, {
        method: remote ? 'PATCH' : 'POST',
        headers: authHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify(payload)
      });
      if (state.blockInfo?.id !== scopeBlockId || state.ownerId !== scopeOwnerId) return;
      if (!response.ok) {
        if (response.status === 409) {
          const latestResponse = await fetch(`${base}?${query}`, { headers: authHeaders() });
          if (state.blockInfo?.id !== scopeBlockId || state.ownerId !== scopeOwnerId) return;
          const latestRows = latestResponse.ok ? await latestResponse.json() : [];
          if (state.blockInfo?.id !== scopeBlockId || state.ownerId !== scopeOwnerId) return;
          const latest = latestRows[0] || remote;
          state.conflicts[dayId] = { local: { ...local }, cloud: CORE.normalizeLogFromCloud ? CORE.normalizeLogFromCloud(latest) : latest };
          state.syncStatus = 'conflict';
          return;
        }
        throw new Error(await response.text());
      }
      let saved = null;
      const changed = await response.json().catch(() => []);
      if (state.blockInfo?.id !== scopeBlockId || state.ownerId !== scopeOwnerId) return;
      if (remote) {
        if (!Array.isArray(changed) || !changed.length) {
          state.conflicts[dayId] = { local: { ...local }, cloud: CORE.normalizeLogFromCloud(remote) };
          state.syncStatus = 'conflict';
          return;
        }
        saved = changed[0];
      } else if (Array.isArray(changed) && changed.length) saved = changed[0];
      const current = state.logs[dayId];
      const savedAt = saved?.updated_at || payload.updated_at;
      if (!current) return;
      if (current !== local || current.updatedAt !== localUpdatedAt) {
        state.logs[dayId] = { ...current, _pending: true, _cloudUpdatedAt: savedAt };
        return;
      }
      state.logs[dayId] = { ...current, _pending: false, _cloudUpdatedAt: savedAt };
      delete state.pendingSync[dayId];
      delete state.conflicts[dayId];
    } catch (error) {
      if (state.blockInfo?.id === scopeBlockId && state.ownerId === scopeOwnerId) state.syncStatus = 'local-offline';
      console.debug('Training plan cloud write queued:', error);
    }
  }

  async function retryPendingSync() {
    if (state.syncPromise) return state.syncPromise;
    state.syncPromise = (async () => {
    const keys = Object.keys(state.pendingSync);
    if (!keys.length) return;
    state.syncStatus = 'syncing';
    for (const dayId of keys) await syncOneLog(dayId);
    saveLogs();
    if (Object.keys(state.conflicts).length) state.syncStatus = 'conflict';
    else if (Object.keys(state.pendingSync).length) state.syncStatus = 'local-pending';
    else state.syncStatus = 'synced';
    renderSyncStatus();
    })().finally(() => { state.syncPromise = null; });
    return state.syncPromise;
  }

  function buildMatchProposals() {
    if (!CORE.matchActivitiesToPlan) return [];
    const matchDays = state.viewMode === 'current'
      ? (state.currentProposal?.sessions || []).map(session => ({ ...session, _planDayId: session.id, category: session.type, workoutType: session.type }))
      : state.days;
    const result = CORE.matchActivitiesToPlan(state.activities, matchDays, { usedActivityIds: Object.values(state.activityLinks) });
    return result.proposals.filter(proposal => !state.activityLinks[proposal.planDayId]);
  }

  function findAnyDay(dayId) {
    const current = state.days.find(item => item._planDayId === dayId)
      || state.currentProposal?.sessions.find(item => item.id === dayId);
    if (current) return current;
    const log = state.logs[dayId];
    const match = String(dayId).match(/^proposal:\d{4}-\d{2}-\d{2}:(\d{4}-\d{2}-\d{2})$/);
    const date = log?.planDate || match?.[1];
    if (!date) return null;
    return { id: dayId, _planDayId: dayId, date, title: log?.planTitle || 'Aktuellt pass', type: log?.planType || 'easy', durationMinutes: log?.actualDurationMinutes || 0 };
  }

  function toggleProposalCheck(dayId) {
    const session = state.currentProposal?.sessions.find(item => item.id === dayId);
    if (!session) return;
    const current = state.logs[dayId] || { status: 'planned' };
    state.logs[dayId] = {
      ...current,
      status: current.status === 'completed' ? 'planned' : 'completed',
      planDate: session.date,
      planTitle: session.title,
      planType: session.type,
      updatedAt: new Date().toISOString(),
      _pending: true
    };
    state.pendingSync[dayId] = true;
    saveLogs();
    renderCurrentPlanProposal();
    renderSyncStatus();
    retryPendingSync();
    toast(state.logs[dayId].status === 'completed' ? 'Aktuellt pass markerat som klart' : 'Passet återställt till planerat');
  }

  function confirmActivity(activityId, dayId) {
    const day = findAnyDay(dayId);
    const activity = state.activities.find(item => String(item.id || item.activity_id) === String(activityId));
    if (!day || !activity) return;
    const alreadyUsed = Object.entries(state.activityLinks).some(([key, value]) => key !== dayId && String(value) === String(activityId));
    if (alreadyUsed) { toast('Aktiviteten är redan kopplad till ett annat pass.'); return; }
    const distance = Number(activity.distance_meters) > 0 ? Number(activity.distance_meters) / 1000 : Number(activity.distance_km) || null;
    const durationSeconds = Number(activity.moving_time_seconds) > 0 ? Number(activity.moving_time_seconds) : Number(activity.duration_seconds);
    const log = getLog(day);
    const values = {
      ...log,
      activityId: String(activity.id || activity.activity_id),
      planDate: day.date,
      planTitle: day.title,
      planType: day.type || day.category,
      actualDistanceKm: log.actualDistanceKm ?? (Number.isFinite(distance) ? Number(distance.toFixed(2)) : null),
      actualDurationMinutes: log.actualDurationMinutes ?? (Number.isFinite(durationSeconds) ? Number((durationSeconds / 60).toFixed(1)) : null),
      updatedAt: new Date().toISOString(),
      _pending: true
    };
    state.activityLinks[dayId] = values.activityId;
    state.logs[dayId] = values;
    state.pendingSync[dayId] = true;
    saveLogs();
    saveActivityLinks();
    state.matchProposals = buildMatchProposals();
    render();
    retryPendingSync();
    toast('Aktivitet föreslagen och värden ifyllda. Status ändras först när du sparar check-in.');
  }

  function resolveConflict(dayId, choice) {
    const conflict = state.conflicts[dayId];
    if (!conflict) return;
    if (choice === 'cloud') {
      state.logs[dayId] = { ...conflict.cloud, _pending: false, _cloudUpdatedAt: conflict.cloud?.updatedAt || conflict.cloud?.updated_at || null };
      delete state.pendingSync[dayId];
    } else {
      state.logs[dayId] = { ...conflict.local, _cloudUpdatedAt: conflict.cloud?.updatedAt || conflict.cloud?.updated_at || null, updatedAt: new Date().toISOString(), _pending: true };
      state.pendingSync[dayId] = true;
    }
    delete state.conflicts[dayId];
    saveLogs();
    render();
    retryPendingSync();
  }

  function setInitialSelection() {
    const today = todayLocalIso();
    if (state.viewMode === 'current') {
      state.selectedDayId = state.currentProposal?.sessions.find(session => session.date >= today)?.id || state.currentProposal?.sessions[0]?.id || null;
      state.selectedWeek = 0;
      return;
    }
    const todayDay = state.days.find(day => day.date === today);
    const weeks = weekNumbers();
    const firstWeek = weeks[0] || 1;
    const lastWeek = weeks[weeks.length - 1] || firstWeek;

    if (todayDay) {
      state.selectedWeek = todayDay.week;
      state.selectedDayId = todayDay._planDayId;
      return;
    }

    if (today < state.plan.metadata.startDate) {
      state.selectedWeek = firstWeek;
      state.selectedDayId = firstVisibleDayForWeek(firstWeek)?._planDayId || null;
      return;
    }

    const lastDay = lastPlanDay();
    state.selectedWeek = lastDay?.week || lastWeek;
    state.selectedDayId = lastDay?._planDayId || null;
  }

  function render() {
    if (state.viewMode === 'current') prepareCurrentProposal();
    renderArchiveControls();
    renderPlanHistory();
    renderHeader();
    renderWeekSelect();
    renderMetrics();
    renderToday();
    renderWeek();
    renderDayDetail();
    renderNutrition();
    renderCheckIn();
    renderReadiness();
    renderBlockSummary();
    renderCurrentPlanProposal();
    renderActivityLinks();
    renderSyncStatus();
  }

  function renderArchiveControls() {
    const isArchive = state.viewMode === 'static';
    ['archive-weight-control', 'archive-four-pass-control', 'archive-hide-optional-control'].forEach(id => {
      const control = $(id);
      if (control) control.hidden = !isArchive;
    });
    const label = $('metric-distance-label');
    if (label) label.textContent = isArchive ? 'Planerad distans' : 'Planerad träning';
  }

  function renderPlanHistory() {
    const select = $('plan-history-select');
    if (!select || !state.registry) return;
    const currentOption = `<option value="current"${state.viewMode === 'current' ? ' selected' : ''}>Aktuell vecka</option>`;
    select.innerHTML = currentOption + (state.registry.blocks || []).map(block => {
      const label = block.title || block.id;
      return `<option value="${escapeHtml(block.id)}"${state.viewMode === 'static' && block.id === state.blockInfo.id ? ' selected' : ''}>Arkiv: ${escapeHtml(label)}</option>`;
    }).join('');
  }

  function renderHeader() {
    const meta = state.plan.metadata;
    const today = todayLocalIso();
    if (state.viewMode === 'current') {
      $('plan-block-label').textContent = `Aktuell vecka · ${formatDate(state.currentProposal.startDate)} - ${formatDate(state.currentProposal.endDate)}`;
      if ($('plan-block-status')) $('plan-block-status').textContent = 'Dynamiskt förslag från dina senaste löppass, mål, tillgängliga dagar och veckotid. Historiskt planblock finns i planhistoriken.';
      return;
    }
    let suffix = `${formatDate(meta.startDate)} - ${formatDate(meta.endDate)}`;
    if (today < meta.startDate) suffix += ` · startar ${formatDate(meta.startDate)}`;
    if (today > meta.endDate) suffix += ' · planblock avslutat';
    const status = CORE.planState ? CORE.planState(state.plan, today) : null;
    $('plan-block-label').textContent = `${meta.name || state.blockInfo.title} · ${suffix}`;
    if ($('plan-block-status')) $('plan-block-status').textContent = status?.reason || '';
  }

  function renderWeekSelect() {
    if (state.viewMode === 'current') {
      $('week-select').innerHTML = '<option value="0" selected>Aktuell vecka</option>';
      return;
    }
    $('week-select').innerHTML = weekNumbers()
      .map(week => `<option value="${week}"${week === state.selectedWeek ? ' selected' : ''}>Vecka ${week}</option>`)
      .join('');
  }

  function renderMetrics() {
    if (state.viewMode === 'current') {
      const proposal = state.currentProposal;
      const minutes = proposal.sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
      const completed = proposal.sessions.filter(session => state.logs[session.id]?.status === 'completed').length;
      $('metric-week').textContent = 'Nu';
      $('metric-week-dates').textContent = `${formatDate(proposal.startDate)} - ${formatDate(proposal.endDate)}`;
      $('metric-distance').textContent = `${minutes} min`;
      $('metric-distance-optional').textContent = 'föreslagen veckotid';
      $('metric-quality').textContent = String(proposal.sessions.filter(session => session.type === 'quality').length);
      $('metric-quality-sub').textContent = `${proposal.sessions.length} planerade pass · ${completed} klara`;
      $('metric-block').textContent = `${completed}/${proposal.sessions.length}`;
      $('metric-block-sub').textContent = 'aktuella pass klara';
      $('week-summary-label').textContent = `${minutes} minuter inom tillgänglig tid`;
      return;
    }
    const weekDays = daysForWeek(state.selectedWeek);
    const totals = summarizeDays(weekDays);
    const block = summarizeBlock();
    $('metric-week').textContent = String(state.selectedWeek);
    $('metric-week-dates').textContent = weekDays.length ? `${formatDate(weekDays[0].date)} - ${formatDate(weekDays[weekDays.length - 1].date)}` : '';
    $('metric-distance').textContent = `${formatNumber(totals.requiredKm, 1)} km`;
    $('metric-distance-optional').textContent = totals.optionalKm ? `+ ${formatNumber(totals.optionalKm, 1)} km valfritt` : 'inga valfria kilometer';
    $('metric-quality').textContent = String(totals.quality);
    $('metric-quality-sub').textContent = `${totals.longRuns} långpass · ${totals.strength} styrka`;
    $('metric-block').textContent = `${block.completedRequired}/${block.requiredDays}`;
    $('metric-block-sub').textContent = `obligatoriska klara/nedskalade · ${block.optionalSkipped} valfria skippade`;
    $('week-summary-label').textContent = `${formatNumber(totals.requiredKm, 1)} km + ${formatNumber(totals.optionalKm, 1)} valfritt`;
  }

  function renderToday() {
    if (state.viewMode === 'current') {
      const proposal = state.currentProposal;
      const today = todayLocalIso();
      const todaySession = proposal.sessions.find(session => session.date === today);
      const session = todaySession || proposal.sessions.find(item => item.date >= today) || proposal.sessions[0];
      if (!session) {
        $('today-card').innerHTML = '<div class="today-title">Ingen aktuell dag ryms inom profilen</div><p class="nutrition-copy">Kontrollera tillgängliga dagar och veckotid under Mål &amp; inställningar.</p>';
        return;
      }
      const log = state.logs[session.id] || { status: 'planned' };
      $('today-card').innerHTML = `<div class="card-header"><span class="card-title">${todaySession ? 'Dagens pass' : 'Första aktuella passet'}</span><span class="status-badge status-${log.status || 'planned'}">${log.status === 'completed' ? 'Klar' : 'Planerad'}</span></div><div class="today-title">${escapeHtml(session.title)}</div><div class="today-meta">${formatDate(session.date)} · ${session.durationMinutes} min · ${escapeHtml(sessionTypeLabel(session.type))}</div><p class="nutrition-copy">${escapeHtml(session.rationale || proposal.rationale)}</p><button class="btn btn-primary btn-sm" data-current-today-check="${escapeHtml(session.id)}" type="button">${log.status === 'completed' ? 'Ångra klar' : 'Markera klar'}</button>`;
      const todayButton = $('today-card').querySelector('[data-current-today-check]');
      todayButton?.addEventListener('click', () => toggleProposalCheck(todayButton.dataset.currentTodayCheck));
      return;
    }
    const today = todayLocalIso();
    const todayDay = state.days.find(day => day.date === today);
    const meta = state.plan.metadata;
    let day = todayDay;
    let note = '';

    if (today > meta.endDate) {
      $('today-card').innerHTML = `<div class="card-header"><span class="card-title">Dagens plan</span><span class="status-badge">Arkiverad</span></div><div class="today-title">Planblocket är avslutat</div><p class="nutrition-copy">Det här historiska blocket används inte som dagens rekommendation. Välj nästa veckas förslag eller ett annat block i planhistoriken.</p>`;
      return;
    }

    if (!day && today < meta.startDate) {
      $('today-card').innerHTML = `<div class="card-header"><span class="card-title">Dagens plan</span><span class="status-badge">Framtida</span></div><div class="today-title">Planen har inte startat</div><p class="nutrition-copy">Det här planblocket börjar ${formatDate(meta.startDate)} och används inte som dagens rekommendation.</p>`;
      return;
    }

    if (!day) {
      $('today-card').innerHTML = '<div class="today-title">Ingen planerad dag hittades</div>';
      return;
    }

    const log = getLog(day);
    $('today-card').innerHTML = `
      <div class="card-header">
        <span class="card-title">${todayDay ? 'Dagens pass' : 'Planläge'}</span>
        <span class="status-badge status-${log.status || 'planned'}">${statusLabels[log.status || 'planned']}</span>
      </div>
      <div class="today-title">${escapeHtml(day.title)}</div>
      <div class="today-meta">${escapeHtml(day.weekday)} ${formatDate(day.date)} · ${escapeHtml(day.durationRange || '')} · ${escapeHtml(day.distanceRangeKm || '0')} km</div>
      <div class="pill-row">${renderPills(day)}</div>
      <p class="nutrition-copy">${escapeHtml(note || day.workoutDetails || '')}</p>
    `;
  }

  function renderCurrentPlanProposal() {
    const box = $('current-plan-proposal');
    if (!box) return;
    const today = todayLocalIso();
    const status = CORE.planState ? CORE.planState(state.plan, today) : null;
    const proposal = CORE.proposeWeeklySchedule ? CORE.proposeWeeklySchedule({ today, activities: state.activities, profile: state.profile }) : null;
    if (!proposal) { box.innerHTML = ''; return; }
    state.currentProposal = proposal;
    const isExpired = status?.state === 'expired';
    const title = state.viewMode === 'current' ? 'Underlag för aktuell vecka' : (isExpired ? 'Ny vecka att föreslå' : 'Nästa veckas förslag');
    const caution = proposal.cautions.length ? `<ul class="proposal-cautions">${proposal.cautions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
    const sessions = proposal.sessions.map(session => {
      const log = state.logs[session.id] || { status: 'planned' };
      const done = log.status === 'completed';
      return `<div class="proposal-session"><strong>${escapeHtml(session.date)}</strong><span>${escapeHtml(session.title)}</span><span>${session.durationMinutes} min</span><span class="status-badge status-${done ? 'completed' : 'planned'}">${done ? 'Klar' : 'Planerad'}</span><button class="btn btn-sm" data-proposal-check="${escapeHtml(session.id)}" type="button">${done ? 'Ångra' : 'Markera klar'}</button></div>`;
    }).join('');
    if (state.viewMode === 'current') {
      box.innerHTML = `<div class="card-header"><span class="card-title">${title}</span><span class="plan-muted">${escapeHtml(proposal.startDate)}–${escapeHtml(proposal.endDate)}</span></div><p class="nutrition-copy">${escapeHtml(proposal.rationale)}</p>${caution}<p class="plan-muted">Veckokalendern ovan är aktuell. Markera varje pass där.</p>`;
      return;
    }
    box.innerHTML = `
      <div class="card-header"><span class="card-title">${title}</span><span class="plan-muted">${escapeHtml(proposal.startDate)}–${escapeHtml(proposal.endDate)}</span></div>
      <p class="nutrition-copy">${escapeHtml(proposal.rationale)}</p>
      <div class="proposal-sessions" aria-label="Aktuell veckokalender">${sessions || '<p class="plan-muted">Inga dagar ryms inom vald veckotid.</p>'}</div>
      ${caution}
      <p class="plan-muted">Förslaget är ett underlag. Spara det inte som ny plan innan du har granskat dagarna.</p>`;
  }

  function renderActivityLinks() {
    const box = $('activity-link-panel');
    if (!box) return;
    const proposals = state.matchProposals || [];
    const conflicts = Object.entries(state.conflicts || {});
    if (!proposals.length && !conflicts.length) {
      box.innerHTML = '<div class="card-header"><span class="card-title">Aktivitetskoppling</span><button class="btn btn-sm" data-refresh-activities type="button">Uppdatera aktiviteter</button></div><p class="nutrition-copy">Inga nya föreslagna kopplingar. Importerade aktiviteter ändrar inte dina manuella check-ins automatiskt.</p>';
      return;
    }
    const proposalHtml = proposals.map(proposal => {
      const day = findAnyDay(proposal.planDayId);
      const buttons = proposal.candidates.map(candidate => `<button class="btn btn-sm" data-confirm-activity="${escapeHtml(candidate.activityId)}" data-day-id="${escapeHtml(proposal.planDayId)}">Koppla ${escapeHtml(candidate.date)} · ${candidate.distanceKm == null ? 'distans saknas' : `${formatNumber(candidate.distanceKm, 1)} km`}</button>`).join(' ');
      return `<div class="link-proposal"><strong>${escapeHtml(day?.title || proposal.planDate)}</strong><span>${proposal.status === 'ambiguous' ? 'Flera möjliga aktiviteter – välj en:' : 'Föreslagen aktivitet:'}</span><div>${buttons}</div></div>`;
    }).join('');
    const conflictHtml = conflicts.map(([dayId, value]) => `<div class="link-proposal conflict"><strong>Konflikt: ${escapeHtml(dayId)}</strong><span>En nyare molnversion finns. Välj vilken version som ska behållas.</span><div><button class="btn btn-sm" data-resolve-conflict="${escapeHtml(dayId)}" data-choice="cloud">Använd molnversion</button><button class="btn btn-sm" data-resolve-conflict="${escapeHtml(dayId)}" data-choice="local">Behåll lokal version</button></div></div>`).join('');
    box.innerHTML = `<div class="card-header"><span class="card-title">Aktivitetskoppling</span><button class="btn btn-sm" data-refresh-activities type="button">Uppdatera aktiviteter</button></div>${proposalHtml}${conflictHtml}`;
  }

  function renderSyncStatus() {
    const note = $('sync-note');
    if (!note) return;
    const labels = {
      synced: 'Synkat mellan dina enheter.', syncing: 'Synkar…', 'local-pending': 'Sparat lokalt. En ändring väntar på ny synkning.', online: 'Aktiviteter hämtade.',
      'local-only': 'Lokal kopia – logga in för synkning.', local: 'Sparar lokalt i webbläsaren.',
      'local-offline': 'Sparat lokalt. Försök synka igen när anslutningen fungerar.', conflict: 'Konflikt kräver ett uttryckligt val.'
    };
    const pending = Object.keys(state.pendingSync).length;
    note.textContent = `${labels[state.syncStatus] || labels.local}${pending ? ` ${pending} ändring${pending === 1 ? '' : 'ar'} väntar.` : ''}`;
    const legacyButton = $('import-legacy-local-logs');
    if (legacyButton) legacyButton.disabled = !state.ownerId || !Object.keys(readLegacyLogs()).length;
  }

  function renderWeek() {
    if (state.viewMode === 'current') {
      const sessions = state.currentProposal?.sessions || [];
      $('week-plan').innerHTML = sessions.map(session => {
        const log = state.logs[session.id] || { status: 'planned' };
        const selected = session.id === state.selectedDayId;
        return `<button class="week-day${selected ? ' active' : ''}" type="button" data-day-id="${escapeHtml(session.id)}"><div><div class="week-day-date">${escapeHtml(session.date)}</div><div class="week-day-meta">Aktuell vecka</div></div><div><div class="week-day-title">${escapeHtml(session.title)}</div><div class="week-day-meta">${session.durationMinutes} min · ${escapeHtml(sessionTypeLabel(session.type))}</div></div><span class="status-badge status-${log.status || 'planned'}">${log.status === 'completed' ? 'Klar' : 'Planerad'}</span></button>`;
      }).join('') || '<div class="empty">Inga dagar ryms inom vald veckotid.</div>';
      $('week-plan').querySelectorAll('[data-day-id]').forEach(button => {
        button.addEventListener('click', () => { state.selectedDayId = button.dataset.dayId; render(); });
      });
      return;
    }
    const days = visibleDays(daysForWeek(state.selectedWeek));
    $('week-plan').innerHTML = days.map(day => {
      const log = getLog(day);
      const isToday = day.date === todayLocalIso();
      const isSelected = day._planDayId === state.selectedDayId;
      const muted = state.fourPassMode && isOptionalRecovery(day);
      return `
        <button class="week-day${isToday ? ' today' : ''}${isSelected ? ' active' : ''}${muted ? ' optional-muted' : ''}" type="button" data-day-id="${escapeHtml(day._planDayId)}">
          <div>
            <div class="week-day-date">${escapeHtml(day.weekday)}</div>
            <div class="week-day-meta">${formatDate(day.date)}</div>
          </div>
          <div>
            <div class="week-day-title">${escapeHtml(day.title)}</div>
            <div class="week-day-meta">${escapeHtml(day.distanceRangeKm || '0')} km · ${escapeHtml(day.intensity || '')}</div>
          </div>
          <span class="status-badge status-${log.status || 'planned'}">${statusLabels[log.status || 'planned']}</span>
        </button>`;
    }).join('') || '<div class="empty">Inga dagar att visa i detta läge.</div>';

    $('week-plan').querySelectorAll('[data-day-id]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedDayId = button.dataset.dayId;
        render();
      });
    });
  }

  function renderDayDetail() {
    const day = selectedDay();
    if (!day) {
      $('day-detail').innerHTML = '<div class="empty">Välj en dag i veckovyn.</div>';
      return;
    }

    if (state.viewMode === 'current') {
      const log = getLog(day);
      $('day-detail').innerHTML = `<div class="card-header"><span class="card-title">Aktuellt pass</span><span class="plan-muted">${escapeHtml(day.date)}</span></div><h2 class="today-title">${escapeHtml(day.title)}</h2><div class="detail-meta">${escapeHtml(sessionTypeLabel(day.type))} · ${day.durationMinutes} minuter</div><div class="detail-section"><h3>Varför detta pass</h3><p>${escapeHtml(day.rationale || state.currentProposal?.rationale || '')}</p></div><div class="detail-section"><h3>Status</h3><p>${log.status === 'completed' ? 'Klar' : 'Planerad'}. Checka av passet när du har genomfört det.</p></div>`;
      return;
    }

    const rules = state.plan.trainingRules || {};
    const downgradeRules = downgradeRulesFor(day);
    const downgradeCopy = downgradeRules.length
      ? `<ul>${downgradeRules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>`
      : `<p>${escapeHtml(NEUTRAL_DOWNGRADE_COPY)}</p>`;
    $('day-detail').innerHTML = `
      <div class="card-header">
        <span class="card-title">Passdetaljer</span>
        <span class="plan-muted">${escapeHtml(day.weekday)} ${formatDate(day.date)}</span>
      </div>
      <h2 class="today-title">${escapeHtml(day.title)}</h2>
      <div class="detail-meta">${escapeHtml(categoryLabels[day.category] || day.category)} · ${escapeHtml(day.durationRange || '')} · ${escapeHtml(day.distanceRangeKm || '0')} km</div>
      <div class="pill-row">${renderPills(day)}</div>
      <div class="detail-section">
        <h3>Upplägg</h3>
        <p>${escapeHtml(day.workoutDetails || '')}</p>
      </div>
      <div class="detail-section">
        <h3>Intensitet</h3>
        <p>${escapeHtml(day.intensity || '-')}</p>
      </div>
      <div class="detail-section">
        <h3>Nedskalning</h3>
        ${downgradeCopy}
      </div>
      <div class="detail-section">
        <h3>Höftregel</h3>
        <p>${escapeHtml(rules.hipRule || '')}</p>
      </div>
      <div class="detail-section">
        <h3>Coachkommentar</h3>
        <p>${escapeHtml(day.coachNotes || 'Ingen kommentar.')}</p>
      </div>
    `;
  }

  function renderNutrition() {
    if (state.viewMode === 'current') {
      $('nutrition-card').innerHTML = '<div class="card-header"><span class="card-title">Mat och energi</span></div><p class="nutrition-copy">Den aktuella veckan använder ingen gammal nutritionsprofil. Anpassa måltider efter passets längd, hunger och återhämtning.</p>';
      return;
    }
    const day = selectedDay();
    if (!day) return;
    const profile = state.plan.nutritionProfiles?.[day.nutritionProfile];
    if (!profile) {
      $('nutrition-card').innerHTML = '<div class="card-title">Nutrition</div><p class="nutrition-copy">Ingen nutritionprofil för dagen.</p>';
      return;
    }
    const nutrition = calculateNutrition(profile, state.weightKg);
    $('nutrition-card').innerHTML = `
      <div class="card-header">
        <span class="card-title">Nutrition</span>
        <span class="plan-muted">${escapeHtml(profile.label)}</span>
      </div>
      <div class="nutrition-grid">
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.kcal}</div><div class="nutrition-label">kcal · grovt estimat</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.carbs} g</div><div class="nutrition-label">kolhydrater</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.protein} g</div><div class="nutrition-label">protein</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.fat} g</div><div class="nutrition-label">fett</div></div>
      </div>
      <p class="nutrition-copy"><strong>Timing:</strong> ${escapeHtml(profile.timing || '')}</p>
      <p class="nutrition-copy"><strong>Vätska:</strong> ${escapeHtml(profile.hydration || '')}</p>
      <p class="plan-muted">Makro- och energivärdena är grova planeringsuppskattningar, inte individuella råd.</p>
    `;
  }

  function renderCheckIn() {
    const day = selectedDay();
    if (!day) return;
    const log = getLog(day);
    $('checkin-date').textContent = `${day.weekday || formatDate(day.date)} ${state.viewMode === 'current' ? '' : formatDate(day.date)}`;
    $('checkin-status').value = log.status || 'planned';
    $('checkin-rpe').value = valueOrEmpty(log.rpe);
    $('checkin-hip').value = valueOrEmpty(log.hipPain);
    $('checkin-sleep').value = valueOrEmpty(log.sleepQuality);
    $('checkin-stress').value = valueOrEmpty(log.stress);
    $('checkin-energy').value = valueOrEmpty(log.energy);
    $('checkin-distance').value = valueOrEmpty(log.actualDistanceKm);
    $('checkin-duration').value = valueOrEmpty(log.actualDurationMinutes);
    $('checkin-notes').value = log.notes || '';
  }

  function renderReadiness() {
    const day = selectedDay();
    const values = currentCheckInValues();
    const readiness = getReadiness(values);
    const suggestion = readinessSuggestion(readiness.level, day);
    const rules = suggestion.rules?.length
      ? `<ul class="readiness-copy">${suggestion.rules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('')}</ul>`
      : '';
    $('readiness-card').innerHTML = `
      <div class="card-header">
        <span class="card-title">Dagsform</span>
        <span class="plan-muted">${readiness.label}</span>
      </div>
      <div class="readiness-indicator">
        <span class="readiness-dot readiness-${readiness.level}"></span>
        <strong>${escapeHtml(suggestion.title)}</strong>
      </div>
      <p class="readiness-copy">${escapeHtml(suggestion.body)}</p>
      ${rules}
    `;
  }

  function renderBlockSummary() {
    if (state.viewMode === 'current') {
      const proposal = state.currentProposal;
      const completed = proposal.sessions.filter(session => state.logs[session.id]?.status === 'completed').length;
      const minutes = proposal.sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
      const generatedHistory = Object.entries(state.logs).filter(([key]) => key.startsWith('proposal:') && !proposal.sessions.some(session => session.id === key));
      const historyCopy = generatedHistory.length ? ` ${generatedHistory.length} äldre aktuella pass finns i exporten och kan synkas igen.` : '';
      $('block-summary').innerHTML = `<div class="summary-grid"><div class="summary-item"><div class="summary-value">${proposal.sessions.length}</div><div class="summary-label">aktuella pass</div></div><div class="summary-item"><div class="summary-value">${completed}</div><div class="summary-label">klara pass</div></div><div class="summary-item"><div class="summary-value">${minutes} min</div><div class="summary-label">föreslagen veckotid</div></div><div class="summary-item"><div class="summary-value">${proposal.evidence?.recentCount || 0}</div><div class="summary-label">färska löppass i underlaget</div></div></div><p class="plan-muted">Historiska veckor och äldre check-ins finns kvar när du väljer ett arkivblock.${historyCopy}</p>`;
      return;
    }
    const summary = summarizeBlock();
    const weeks = weekNumbers().map(week => summarizeDays(daysForWeek(week)));
    $('block-summary').innerHTML = `
      <div class="summary-grid">
        <div class="summary-item"><div class="summary-value">${summary.requiredDays}</div><div class="summary-label">obligatoriska dagar</div></div>
        <div class="summary-item"><div class="summary-value">${summary.completedRequired}</div><div class="summary-label">klara/nedskalade obligatoriska</div></div>
        <div class="summary-item"><div class="summary-value">${formatNumber(summary.requiredKm, 1)} km</div><div class="summary-label">obligatorisk distans</div></div>
        <div class="summary-item"><div class="summary-value">${formatNumber(summary.optionalKm, 1)} km</div><div class="summary-label">valfri distans</div></div>
      </div>
      <table class="summary-table">
        <thead>
          <tr>
            <th>Vecka</th>
            <th>Distans</th>
            <th>Optional</th>
            <th>Kvalitet</th>
            <th>Långpass</th>
            <th>Styrka</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${weeks.map(week => `
            <tr>
              <td>${week.week}</td>
              <td>${formatNumber(week.requiredKm, 1)} km</td>
              <td>${formatNumber(week.optionalKm, 1)} km</td>
              <td>${week.quality}</td>
              <td>${week.longRuns}</td>
              <td>${week.strength}</td>
              <td>${week.completedRequired}/${week.requiredDays}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
  }

  function saveCurrentCheckIn() {
    const day = selectedDay();
    if (!day) return;
    const dayId = day._planDayId || day.id || day.date;
    const values = currentCheckInValues();
    const existing = getLog(day);
    if (existing.activityId) values.activityId = existing.activityId;
    if (existing._cloudUpdatedAt) values._cloudUpdatedAt = existing._cloudUpdatedAt;
    values.planDate = day.date;
    values.planTitle = day.title;
    values.planType = day.type || day.category;
    values.updatedAt = new Date().toISOString();
    values._pending = true;
    state.logs[dayId] = values;
    state.pendingSync[dayId] = true;
    saveLogs();
    syncCheckIn(day, values);
    savePreferencesToProfile();
    render();
    toast('Check-in sparad lokalt');
  }

  function quickStatus(status) {
    $('checkin-status').value = status;
    saveCurrentCheckIn();
  }

  function currentCheckInValues() {
    return {
      status: $('checkin-status')?.value || 'planned',
      rpe: parseNumber($('checkin-rpe')?.value),
      hipPain: parseNumber($('checkin-hip')?.value),
      sleepQuality: parseNumber($('checkin-sleep')?.value),
      stress: parseNumber($('checkin-stress')?.value),
      energy: parseNumber($('checkin-energy')?.value),
      actualDistanceKm: parseNumber($('checkin-distance')?.value),
      actualDurationMinutes: parseNumber($('checkin-duration')?.value),
      notes: $('checkin-notes')?.value.trim() || ''
    };
  }

  async function syncCheckIn(day, checkIn) {
    if (!state.ownerId) return;
    await retryPendingSync();
    saveLogs();
    renderSyncStatus();
  }

  function savePreferencesToProfile() {
    if (typeof TrainingProfile === 'undefined' || typeof TrainingProfile.save !== 'function') return;
    TrainingProfile.save({ planPreferences: {
      weightKg: state.weightKg,
      fourPassMode: state.fourPassMode,
      hideOptional: state.hideOptional
    } }).catch(error => console.debug('Plan preferences queued locally:', error));
  }

  function importLegacyLocalLogs() {
    if (!state.ownerId) {
      toast('Logga in innan äldre lokala loggar kopieras till kontot.');
      return;
    }
    const legacy = readLegacyLogs();
    const keys = Object.keys(legacy);
    if (!keys.length) {
      toast('Inga äldre lokala loggar hittades för detta planblock.');
      return;
    }
    if (!window.confirm(`Kopiera ${keys.length} äldre lokala loggar till detta konto? Befintliga kontologgar lämnas orörda.`)) return;
    const importedAt = new Date().toISOString();
    keys.forEach(key => {
      if (state.logs[key]) return;
      state.logs[key] = { ...legacy[key], updatedAt: legacy[key].updatedAt || importedAt, _pending: true, importedFromLegacy: true };
      state.pendingSync[key] = true;
    });
    saveLogs();
    render();
    retryPendingSync();
    toast('Äldre lokala loggar kopierades till kontot.');
  }

  function exportLogs() {
    const payload = {
      app: 'training-dashboard-plan',
      version: 1,
      exportedAt: new Date().toISOString(),
      planBlockId: state.blockInfo.id,
      logs: state.logs
    };
    downloadJson(`training-plan-logs-${state.blockInfo.id}.json`, payload);
  }

  async function importLogs(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const importedLogs = parsed.logs;
      if (!parsed.planBlockId || parsed.planBlockId !== state.blockInfo.id) {
        toast('Import blockerad: backupen hör inte till aktuellt planblock.');
        return;
      }
      if (!isPlainObject(importedLogs)) {
        toast('Import blockerad: backupen saknar giltiga loggar.');
        return;
      }

      const mode = (prompt(IMPORT_MODE_PROMPT, 'merge') || '').trim().toLowerCase();
      if (!mode) {
        toast('Import avbruten');
        return;
      }
      if (!['merge', 'replace'].includes(mode)) {
        toast('Import blockerad: välj merge eller replace.');
        return;
      }

      const importedAt = new Date().toISOString();
      if (mode === 'replace') state.pendingSync = {};
      const nextLogs = mode === 'replace' ? {} : { ...state.logs };
      Object.entries(importedLogs).forEach(([dayId, imported]) => {
        if (mode === 'merge' && state.logs[dayId]) return;
        nextLogs[dayId] = { ...imported, updatedAt: imported.updatedAt || importedAt, _pending: true };
        state.pendingSync[dayId] = true;
      });
      state.logs = nextLogs;
      saveLogs();
      render();
      retryPendingSync();
      toast(mode === 'replace' ? 'Backup importerad och ersatte loggar' : 'Backup importerad och ihopslagen');
    } catch (error) {
      toast('Kunde inte importera backup');
      console.warn('Training plan import failed:', error);
    }
  }

  function exportBlockSummary(format) {
    const summary = blockSummaryPayload();
    if (format === 'csv') {
      downloadText(`training-plan-summary-${state.blockInfo.id}.csv`, summaryToCsv(summary), 'text/csv');
    } else {
      downloadJson(`training-plan-summary-${state.blockInfo.id}.json`, summary);
    }
  }

  function blockSummaryPayload() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      planBlockId: state.blockInfo.id,
      metadata: state.plan.metadata,
      totals: summarizeBlock(),
      weeks: weekNumbers().map(week => summarizeDays(daysForWeek(week)))
    };
  }

  function summaryToCsv(summary) {
    const rows = [
      ['week', 'required_km', 'optional_km', 'quality', 'long_runs', 'strength', 'required_days', 'completed_required']
    ];
    summary.weeks.forEach(week => rows.push([
      week.week,
      week.requiredKm,
      week.optionalKm,
      week.quality,
      week.longRuns,
      week.strength,
      week.requiredDays,
      week.completedRequired
    ]));
    return rows.map(row => row.map(csvCell).join(',')).join('\n');
  }

  function summarizeBlock() {
    const base = summarizeDays(state.days);
    base.optionalSkipped = state.days.filter(day => day.optional && getLog(day).status === 'skipped').length;
    return base;
  }

  function summarizeDays(days) {
    return days.reduce((summary, day) => {
      const km = plannedKm(day.distanceRangeKm);
      const log = getLog(day);
      const completed = ['completed', 'scaled_down'].includes(log.status);
      const required = !day.optional;

      summary.week = day.week;
      if (required) summary.requiredKm += km;
      else summary.optionalKm += km;
      if (isQuality(day)) summary.quality += 1;
      if (day.category === 'long') summary.longRuns += 1;
      if (day.category === 'strength') summary.strength += 1;
      if (required) summary.requiredDays += 1;
      if (required && completed) summary.completedRequired += 1;
      return summary;
    }, {
      week: days[0]?.week || 0,
      requiredKm: 0,
      optionalKm: 0,
      quality: 0,
      longRuns: 0,
      strength: 0,
      requiredDays: 0,
      completedRequired: 0,
      optionalSkipped: 0
    });
  }

  function getReadiness(values) {
    if (CORE.readiness) return CORE.readiness(values);
    const sleep = values.sleepQuality;
    const stress = values.stress;
    const hipPain = values.hipPain;
    const energy = values.energy;
    const hasSleep = Number.isFinite(sleep);
    const hasStress = Number.isFinite(stress);
    const hasHipPain = Number.isFinite(hipPain);
    const hasEnergy = Number.isFinite(energy);

    if ((hasHipPain && hipPain >= 4) || (hasEnergy && energy === 1) || (hasSleep && hasStress && sleep <= 2 && stress >= 4)) {
      return { level: 'red', label: 'Röd' };
    }
    if ((hasHipPain && hipPain >= 3) || (hasSleep && sleep <= 2) || (hasStress && stress >= 4) || (hasEnergy && energy <= 2)) {
      return { level: 'yellow', label: 'Gul' };
    }
    return { level: 'green', label: 'Grön' };
  }

  function readinessSuggestion(level, day) {
    if (level === 'unknown') {
      return {
        title: 'Readiness okänd',
        body: 'Fyll i sömn, stress, energi och obehag innan du väljer intensitet. Grönt läge antas inte.'
      };
    }
    if (level === 'red') {
      return {
        title: 'Recovery eller kraftigt nedskalat',
        body: 'Välj vila, recovery eller kort version. Höftsmärta och låg energi prioriteras framför planerad belastning.'
      };
    }
    if (level === 'yellow') {
      const rules = downgradeRulesFor(day);
      return {
        title: 'Kör konservativt',
        body: rules.length
          ? 'Utgå från planerat pass men använd dessa nedskalningsregler vid behov. Det är en rekommendation, inte en spärr.'
          : NEUTRAL_DOWNGRADE_COPY,
        rules
      };
    }
    return {
      title: 'Kör planerat',
      body: 'Readiness är grön. Följ dagens pass och håll intensiteten enligt coachkommentaren.'
    };
  }

  function calculateNutrition(profile, weightKg) {
    const protein = Math.round(profile.protein_g_per_kg * weightKg);
    const carbs = Math.round(profile.carbs_g_per_kg * weightKg);
    const fat = Math.round(profile.fat_g_per_kg * weightKg);
    const kcal = Number.isFinite(Number(profile.kcal_per_kg_estimate))
      ? Math.round(Number(profile.kcal_per_kg_estimate) * weightKg)
      : protein * 4 + carbs * 4 + fat * 9;
    return { protein, carbs, fat, kcal };
  }

  function changeWeek(delta) {
    const weeks = weekNumbers();
    const currentIndex = weeks.indexOf(state.selectedWeek);
    const nextWeek = weeks[Math.min(Math.max(currentIndex + delta, 0), weeks.length - 1)];
    if (!nextWeek || nextWeek === state.selectedWeek) return;
    state.selectedWeek = nextWeek;
    state.selectedDayId = firstVisibleDayForWeek(nextWeek)?._planDayId || null;
    render();
  }

  function ensureVisibleSelection() {
    if (state.viewMode === 'current') {
      if (!state.currentProposal?.sessions.some(item => item.id === state.selectedDayId)) state.selectedDayId = state.currentProposal?.sessions.find(item => item.date >= todayLocalIso())?.id || state.currentProposal?.sessions[0]?.id || null;
      return;
    }
    const day = selectedDay();
    if (!day || !visibleDays(daysForWeek(state.selectedWeek)).some(item => item._planDayId === day._planDayId)) {
      state.selectedDayId = firstVisibleDayForWeek(state.selectedWeek)?._planDayId || null;
    }
  }

  function selectedDay() {
    if (state.viewMode === 'current') return state.currentProposal?.sessions.find(item => item.id === state.selectedDayId) || state.currentProposal?.sessions[0] || null;
    return state.days.find(day => day._planDayId === state.selectedDayId) || firstVisibleDayForWeek(state.selectedWeek);
  }

  function firstVisibleDayForWeek(week) {
    if (state.viewMode === 'current') return state.currentProposal?.sessions[0] || null;
    return visibleDays(daysForWeek(week))[0] || daysForWeek(week)[0] || null;
  }

  function lastPlanDay() {
    return state.days[state.days.length - 1] || null;
  }

  function visibleDays(days) {
    if (!state.hideOptional) return days;
    return days.filter(day => !isOptionalRecovery(day));
  }

  function daysForWeek(week) {
    if (state.viewMode === 'current') return state.currentProposal?.sessions || [];
    return state.days.filter(day => day.week === week);
  }

  function weekNumbers() {
    if (state.viewMode === 'current') return [0];
    return [...new Set(state.days.map(day => day.week))].sort((a, b) => a - b);
  }

  function getLog(day) {
    const key = day?._planDayId || day?.id || day?.date;
    return state.logs[key] || { status: 'planned' };
  }

  function loadLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(logsKey()) || '{}');
      return isPlainObject(value) ? value : {};
    } catch (error) {
      localStorage.removeItem(logsKey());
      return {};
    }
  }

  function pendingLogEntries(logs) {
    return Object.fromEntries(Object.entries(logs || {})
      .filter(([, log]) => log && log._pending)
      .map(([dayId]) => [dayId, true]));
  }

  function saveLogs() {
    localStorage.setItem(logsKey(), JSON.stringify(state.logs));
  }

  function logsKey() {
    return `${STORAGE_PREFIX}_logs_v2:${state.ownerId || 'local'}:${state.blockInfo.id}`;
  }

  function legacyLogsKey() {
    return `${STORAGE_PREFIX}_logs_v1:${state.blockInfo.id}`;
  }

  function readLegacyLogs() {
    try {
      const value = JSON.parse(localStorage.getItem(legacyLogsKey()) || '{}');
      return isPlainObject(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function activityLinksKey() {
    return `${STORAGE_PREFIX}_activity_links_v1:${state.ownerId || 'local'}:${state.blockInfo.id}`;
  }

  function loadActivityLinks() {
    try {
      const value = JSON.parse(localStorage.getItem(activityLinksKey()) || '{}');
      return isPlainObject(value) ? value : {};
    } catch (_) {
      localStorage.removeItem(activityLinksKey());
      return {};
    }
  }

  function saveActivityLinks() {
    localStorage.setItem(activityLinksKey(), JSON.stringify(state.activityLinks));
  }

  function renderPills(day) {
    return [
      `<span class="plan-pill pill-${escapeHtml(day.category)}">${escapeHtml(categoryLabels[day.category] || day.category)}</span>`,
      day.optional ? '<span class="plan-pill">Valfritt</span>' : '<span class="plan-pill">Obligatoriskt</span>',
      `<span class="plan-pill">${escapeHtml(day.nutritionProfile || '')}</span>`
    ].join('');
  }

  function sessionTypeLabel(type) {
    return sessionTypeLabels[type] || categoryLabels[type] || type || 'Pass';
  }

  function isOptionalRecovery(day) {
    return !!day.optional && ['recovery', 'easy'].includes(day.category);
  }

  function isQuality(day) {
    return day.category === 'quality' || day.category === 'test' || String(day.workoutType || '').includes('quality');
  }

  function downgradeRulesFor(day) {
    const candidates = [
      day?.downgradeIfTired,
      day?.downgradeRules,
      day?.scalingOptions,
      day?.scaling?.downgradeIfTired,
      day?.scaling?.downgradeRules,
      day?.scaling?.options,
      day?.workout?.downgradeIfTired,
      day?.workout?.downgradeRules,
      day?.workout?.scalingOptions
    ];

    for (const candidate of candidates) {
      const rules = normalizeRuleList(candidate);
      if (rules.length) return rules;
    }
    return [];
  }

  function normalizeRuleList(value) {
    if (!value) return [];
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
      return value.map(normalizeRuleEntry).filter(Boolean);
    }
    if (!isPlainObject(value)) return [];

    const nestedKeys = ['downgradeIfTired', 'downgradeRules', 'ifTired', 'yellow', 'tired', 'options', 'rules'];
    for (const key of nestedKeys) {
      const rules = normalizeRuleList(value[key]);
      if (rules.length) return rules;
    }

    const entry = normalizeRuleEntry(value);
    return entry ? [entry] : [];
  }

  function normalizeRuleEntry(value) {
    if (typeof value === 'string') return value.trim();
    if (!isPlainObject(value)) return '';
    const text = value.text || value.rule || value.description || value.label || value.title;
    return typeof text === 'string' ? text.trim() : '';
  }

  function plannedKm(value = '') {
    const normalized = String(value).replace(/,/g, '.').replace(/[–—]/g, '-');
    const matches = [...normalized.matchAll(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/g)];
    if (!matches.length) return 0;
    const ranges = matches.map(match => {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;
      return (start + end) / 2;
    }).filter(Number.isFinite);
    const nonZero = ranges.filter(km => km > 0);
    return nonZero.length ? nonZero[nonZero.length - 1] : 0;
  }

  function parseNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(String(value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function valueOrEmpty(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function todayLocalIso() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  }

  function parseIsoLocal(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function formatDate(dateStr) {
    return parseIsoLocal(dateStr).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  }

  function formatNumber(value, decimals = 0) {
    return Number(value || 0).toLocaleString('sv-SE', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  function downloadJson(filename, data) {
    downloadText(filename, JSON.stringify(data, null, 2), 'application/json');
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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
})();
