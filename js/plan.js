(() => {
  const scriptUrl = new URL(document.currentScript.src);
  const registryUrl = new URL('../data/plan-blocks.json', scriptUrl);
  const STORAGE_PREFIX = 'training_plan';
  const DEFAULT_WEIGHT_KG = 75;

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
    syncDisabled: false
  };

  const statusLabels = {
    planned: 'Planerad',
    completed: 'Klar',
    scaled_down: 'Nedskalad',
    skipped: 'Skippad'
  };

  const categoryLabels = {
    rest: 'Vila',
    recovery: 'Recovery',
    easy: 'Lätt',
    quality: 'Kvalitet',
    long: 'Långpass',
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

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    bindStaticControls();
    loadPreferences();

    try {
      await loadPlanBlock();
      state.logs = loadLogs();
      setInitialSelection();
      render();
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
        localStorage.setItem(`${STORAGE_PREFIX}_weight_kg`, String(value));
        renderNutrition();
      }
    });

    $('four-pass-mode').addEventListener('change', event => {
      state.fourPassMode = event.target.checked;
      localStorage.setItem(`${STORAGE_PREFIX}_four_pass_mode`, state.fourPassMode ? '1' : '0');
      ensureVisibleSelection();
      render();
    });

    $('hide-optional').addEventListener('change', event => {
      state.hideOptional = event.target.checked;
      localStorage.setItem(`${STORAGE_PREFIX}_hide_optional`, state.hideOptional ? '1' : '0');
      ensureVisibleSelection();
      render();
    });

    $('prev-week').addEventListener('click', () => changeWeek(-1));
    $('next-week').addEventListener('click', () => changeWeek(1));
    $('week-select').addEventListener('change', event => {
      state.selectedWeek = Number(event.target.value);
      state.selectedDayId = firstVisibleDayForWeek(state.selectedWeek)?._planDayId || null;
      render();
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
    $('export-summary-json').addEventListener('click', () => exportBlockSummary('json'));
    $('export-summary-csv').addEventListener('click', () => exportBlockSummary('csv'));
  }

  function loadPreferences() {
    const savedWeight = parseNumber(localStorage.getItem(`${STORAGE_PREFIX}_weight_kg`));
    state.weightKg = savedWeight || DEFAULT_WEIGHT_KG;
    state.fourPassMode = localStorage.getItem(`${STORAGE_PREFIX}_four_pass_mode`) === '1';
    state.hideOptional = localStorage.getItem(`${STORAGE_PREFIX}_hide_optional`) === '1';
    $('weight-kg').value = String(state.weightKg);
    $('four-pass-mode').checked = state.fourPassMode;
    $('hide-optional').checked = state.hideOptional;
  }

  async function loadPlanBlock() {
    const registry = await fetchJson(registryUrl);
    const activeId = registry.activePlanBlockId;
    const blockInfo = (registry.blocks || []).find(block => block.id === activeId) || registry.blocks?.[0];
    if (!blockInfo) throw new Error('No plan block configured.');

    const planUrl = new URL(blockInfo.path, registryUrl);
    const plan = await fetchJson(planUrl);
    const days = (plan.days || []).map(day => ({
      ...day,
      _planDayId: day.id || day.planDayId || day.date
    }));

    state.registry = registry;
    state.blockInfo = blockInfo;
    state.plan = plan;
    state.days = days;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    return res.json();
  }

  function setInitialSelection() {
    const today = todayLocalIso();
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
  }

  function renderHeader() {
    const meta = state.plan.metadata;
    const today = todayLocalIso();
    let suffix = `${formatDate(meta.startDate)} - ${formatDate(meta.endDate)}`;
    if (today < meta.startDate) suffix += ` · startar ${formatDate(meta.startDate)}`;
    if (today > meta.endDate) suffix += ' · planblock avslutat';
    $('plan-block-label').textContent = `${meta.name || state.blockInfo.title} · ${suffix}`;
  }

  function renderWeekSelect() {
    $('week-select').innerHTML = weekNumbers()
      .map(week => `<option value="${week}"${week === state.selectedWeek ? ' selected' : ''}>Vecka ${week}</option>`)
      .join('');
  }

  function renderMetrics() {
    const weekDays = daysForWeek(state.selectedWeek);
    const totals = summarizeDays(weekDays);
    const block = summarizeBlock();
    $('metric-week').textContent = String(state.selectedWeek);
    $('metric-week-dates').textContent = weekDays.length ? `${formatDate(weekDays[0].date)} - ${formatDate(weekDays[weekDays.length - 1].date)}` : '';
    $('metric-distance').textContent = `${formatNumber(totals.requiredKm, 1)} km`;
    $('metric-distance-optional').textContent = totals.optionalKm ? `+ ${formatNumber(totals.optionalKm, 1)} km optional` : 'inga optional-km';
    $('metric-quality').textContent = String(totals.quality);
    $('metric-quality-sub').textContent = `${totals.longRuns} långpass · ${totals.strength} styrka`;
    $('metric-block').textContent = `${block.completedRequired}/${block.requiredDays}`;
    $('metric-block-sub').textContent = `required klara/nedskalade · ${block.optionalSkipped} optional skippade`;
    $('week-summary-label').textContent = `${formatNumber(totals.requiredKm, 1)} km + ${formatNumber(totals.optionalKm, 1)} optional`;
  }

  function renderToday() {
    const today = todayLocalIso();
    const todayDay = state.days.find(day => day.date === today);
    const meta = state.plan.metadata;
    let day = todayDay;
    let note = '';

    if (!day && today < meta.startDate) {
      day = state.days[0];
      note = `Planen startar ${formatDate(meta.startDate)}. Visar första planerade dagen.`;
    } else if (!day && today > meta.endDate) {
      day = state.days[state.days.length - 1];
      note = 'Planblock avslutat - dags att utvärdera.';
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

  function renderWeek() {
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
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.kcal}</div><div class="nutrition-label">kcal</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.carbs} g</div><div class="nutrition-label">kolhydrater</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.protein} g</div><div class="nutrition-label">protein</div></div>
        <div class="nutrition-item"><div class="nutrition-value">${nutrition.fat} g</div><div class="nutrition-label">fett</div></div>
      </div>
      <p class="nutrition-copy"><strong>Timing:</strong> ${escapeHtml(profile.timing || '')}</p>
      <p class="nutrition-copy"><strong>Vätska:</strong> ${escapeHtml(profile.hydration || '')}</p>
    `;
  }

  function renderCheckIn() {
    const day = selectedDay();
    if (!day) return;
    const log = getLog(day);
    $('checkin-date').textContent = `${day.weekday} ${formatDate(day.date)}`;
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
        <span class="card-title">Readiness</span>
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
    const summary = summarizeBlock();
    const weeks = weekNumbers().map(week => summarizeDays(daysForWeek(week)));
    $('block-summary').innerHTML = `
      <div class="summary-grid">
        <div class="summary-item"><div class="summary-value">${summary.requiredDays}</div><div class="summary-label">required dagar</div></div>
        <div class="summary-item"><div class="summary-value">${summary.completedRequired}</div><div class="summary-label">klara/nedskalade required</div></div>
        <div class="summary-item"><div class="summary-value">${formatNumber(summary.requiredKm, 1)} km</div><div class="summary-label">required distans</div></div>
        <div class="summary-item"><div class="summary-value">${formatNumber(summary.optionalKm, 1)} km</div><div class="summary-label">optional distans</div></div>
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
    const values = currentCheckInValues();
    values.updatedAt = new Date().toISOString();
    state.logs[day._planDayId] = values;
    saveLogs();
    syncCheckIn(day, values);
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
    if (state.syncDisabled) return;
    try {
      if (typeof getValidSession !== 'function' || typeof authHeaders !== 'function' || typeof SUPA_URL === 'undefined') return;
      const session = await getValidSession();
      const userId = session?.user?.id;
      if (!session?.access_token || !userId) return;

      const payload = {
        user_id: userId,
        plan_block_id: state.blockInfo.id,
        plan_day_id: day._planDayId,
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
        updated_at: new Date().toISOString()
      };

      const res = await fetch(`${SUPA_URL}/rest/v1/training_plan_logs?on_conflict=user_id,plan_block_id,plan_day_id`, {
        method: 'POST',
        headers: authHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (error) {
      state.syncDisabled = true;
      console.debug('Training plan Supabase sync disabled:', error);
    }
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

      state.logs = mode === 'replace' ? { ...importedLogs } : { ...state.logs, ...importedLogs };
      saveLogs();
      render();
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
    const kcal = protein * 4 + carbs * 4 + fat * 9;
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
    const day = selectedDay();
    if (!day || !visibleDays(daysForWeek(state.selectedWeek)).some(item => item._planDayId === day._planDayId)) {
      state.selectedDayId = firstVisibleDayForWeek(state.selectedWeek)?._planDayId || null;
    }
  }

  function selectedDay() {
    return state.days.find(day => day._planDayId === state.selectedDayId) || firstVisibleDayForWeek(state.selectedWeek);
  }

  function firstVisibleDayForWeek(week) {
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
    return state.days.filter(day => day.week === week);
  }

  function weekNumbers() {
    return [...new Set(state.days.map(day => day.week))].sort((a, b) => a - b);
  }

  function getLog(day) {
    return state.logs[day._planDayId] || { status: 'planned' };
  }

  function loadLogs() {
    try {
      return JSON.parse(localStorage.getItem(logsKey()) || '{}');
    } catch (error) {
      localStorage.removeItem(logsKey());
      return {};
    }
  }

  function saveLogs() {
    localStorage.setItem(logsKey(), JSON.stringify(state.logs));
  }

  function logsKey() {
    return `${STORAGE_PREFIX}_logs_v1:${state.blockInfo.id}`;
  }

  function renderPills(day) {
    return [
      `<span class="plan-pill pill-${escapeHtml(day.category)}">${escapeHtml(categoryLabels[day.category] || day.category)}</span>`,
      day.optional ? '<span class="plan-pill">Optional</span>' : '<span class="plan-pill">Required</span>',
      `<span class="plan-pill">${escapeHtml(day.nutritionProfile || '')}</span>`
    ].join('');
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
