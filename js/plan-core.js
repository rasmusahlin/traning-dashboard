/* Pure plan/check-in helpers. Works in browsers and in Node without DOM APIs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlanCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const TYPE_ALIASES = {
    running: ['run', 'running', 'löp', 'jog', 'trail'],
    strength: ['strength', 'styrke', 'gym', 'weight'],
    hiking: ['hike', 'hiking', 'vandring', 'walk', 'promenade']
  };

  function toIso(value) {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function parseLocalIso(iso) {
    const [year, month, day] = String(iso || '').split('-').map(Number);
    if (![year, month, day].every(Number.isFinite)) return null;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function addDays(iso, amount) {
    const date = parseLocalIso(iso);
    if (!date) return '';
    date.setDate(date.getDate() + Number(amount || 0));
    return toIso(date);
  }

  function monday(iso) {
    const date = parseLocalIso(iso);
    if (!date) return '';
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return toIso(date);
  }

  function dateDistance(a, b) {
    const left = parseLocalIso(toIso(a));
    const right = parseLocalIso(toIso(b));
    if (!left || !right) return Infinity;
    return Math.abs(Math.round((left.getTime() - right.getTime()) / DAY_MS));
  }

  function asNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  function hasNumber(value) {
    return Number.isFinite(asNumber(value));
  }

  function readiness(values = {}) {
    const sleep = asNumber(values.sleepQuality ?? values.sleep);
    const stress = asNumber(values.stress);
    const energy = asNumber(values.energy);
    const discomfort = asNumber(values.hipPain ?? values.discomfort);
    const missing = [];
    if (!hasNumber(sleep)) missing.push('sömn');
    if (!hasNumber(stress)) missing.push('stress');
    if (!hasNumber(energy)) missing.push('energi');
    if (!hasNumber(discomfort)) missing.push('obehag');
    if ((hasNumber(discomfort) && discomfort >= 4) || (hasNumber(energy) && energy <= 1) || (hasNumber(sleep) && hasNumber(stress) && sleep <= 2 && stress >= 4)) {
      return { level: 'red', label: 'Röd', missing: [], rationale: 'Högt obehag eller låg återhämtning talar för vila eller tydlig nedskalning.' };
    }
    if ((hasNumber(discomfort) && discomfort >= 3) || (hasNumber(sleep) && sleep <= 2) || (hasNumber(stress) && stress >= 4) || (hasNumber(energy) && energy <= 2)) {
      return { level: 'yellow', label: 'Gul', missing: [], rationale: 'Håll passet konservativt och skala volym eller intensitet vid behov.' };
    }
    if (missing.length) {
      return {
        level: 'unknown',
        label: 'Okänd',
        missing,
        rationale: `Fyll i ${missing.join(', ')} för en readiness-bedömning. Grönt läge antas inte.`
      };
    }
    return { level: 'green', label: 'Grön', missing: [], rationale: 'Alla readiness-fält finns och visar inga tydliga varningssignaler.' };
  }

  function planState(plan, today) {
    const now = toIso(today) || toIso(new Date());
    const metadata = plan && plan.metadata ? plan.metadata : plan || {};
    const startDate = toIso(metadata.startDate);
    const endDate = toIso(metadata.endDate);
    if (!startDate || !endDate) return { state: 'unknown', reason: 'Planen saknar giltiga start- eller slutdatum.' };
    if (endDate < now) return { state: 'expired', reason: 'Planblocket är avslutat och används inte som dagens rekommendation.', startDate, endDate };
    if (startDate > now) return { state: 'future', reason: `Planblocket börjar ${startDate}.`, startDate, endDate };
    return { state: 'current', reason: 'Planblocket ligger inom dagens datumintervall.', startDate, endDate };
  }

  function recommendToday(plan, today) {
    const state = planState(plan, today);
    if (state.state !== 'current') return { ...state, day: null };
    const day = (plan?.days || []).find(item => toIso(item.date) === toIso(today));
    return day ? { ...state, day } : { ...state, day: null, reason: 'Ingen planerad dag finns för dagens datum.' };
  }

  function classifyType(activity) {
    const raw = [activity?.activity_type, activity?.sport, activity?.sub_sport, activity?.name, activity?.title]
      .filter(Boolean).join(' ').toLowerCase();
    for (const [type, aliases] of Object.entries(TYPE_ALIASES)) {
      if (aliases.some(alias => raw.includes(alias))) return type;
    }
    return 'unknown';
  }

  function normalizeAvailability(profile = {}) {
    const days = Array.isArray(profile.availableDays) ? profile.availableDays : [];
    const normalizedDays = [...new Set(days.map(Number).filter(day => day >= 0 && day <= 6))];
    const daysPerWeek = Number(profile.daysPerWeek);
    return {
      days: normalizedDays.length ? normalizedDays : [1, 3, 5, 6],
      daysPerWeek: Number.isFinite(daysPerWeek) && daysPerWeek > 0 ? Math.min(7, Math.round(daysPerWeek)) : 4,
      weeklyMinutes: Number.isFinite(Number(profile.weeklyMinutes)) && Number(profile.weeklyMinutes) > 0 ? Number(profile.weeklyMinutes) : null
    };
  }

  function weekday(iso) {
    const date = parseLocalIso(iso);
    if (!date) return null;
    return date.getDay();
  }

  function recentEvidence(activities, today, days = 42) {
    const now = toIso(today) || toIso(new Date());
    return (activities || []).filter(activity => {
      const date = toIso(activity.activity_date || activity.date || activity.started_at);
      const age = dateDistance(date, now);
      return date && date <= now && age <= days;
    }).sort((a, b) => String(b.activity_date || b.date || '').localeCompare(String(a.activity_date || a.date || '')));
  }

  function proposeWeeklySchedule(input = {}) {
    const today = toIso(input.today) || toIso(new Date());
    const profile = input.profile || {};
    const availability = normalizeAvailability(profile);
    const lookbackDays = Math.max(7, Number(input.lookbackDays) || 42);
    const recent = recentEvidence(input.activities || [], today, lookbackDays - 1);
    const running = recent.filter(activity => classifyType(activity) === 'running');
    const byType = recent.reduce((acc, activity) => {
      const type = classifyType(activity);
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    const goal = profile.goal || input.goal || {};
    const targetKm = asNumber(goal.distanceKm);
    const targetSeconds = asNumber(goal.targetSeconds);
    const targetDate = toIso(goal.targetDate);
    const daysToGoal = targetDate && targetDate >= today ? dateDistance(today, targetDate) : null;
    const nearGoal = daysToGoal !== null && daysToGoal <= 14;
    const goalFocus = targetKm !== null && targetKm <= 10 ? 'kontrollerad fart nära måldistansen' : 'uthållighet och lugn volym';
    const evidenceCount = running.length;
    const recentMinutes = running.reduce((sum, activity) => {
      const seconds = asNumber(activity.moving_time_seconds) ?? asNumber(activity.duration_seconds);
      return sum + (seconds && seconds > 0 ? seconds / 60 : 0);
    }, 0);
    const latest = running[0];
    const latestDate = toIso(latest?.activity_date || latest?.date || latest?.started_at);
    const latestAge = latestDate ? dateDistance(latestDate, today) : Infinity;
    const hasCoverage = Boolean(profile.coverageStart && profile.coverageThrough && profile.coverageStart <= addDays(today, -(lookbackDays - 1)) && profile.coverageThrough >= today);
    const recentWeeklyMinutes = Math.round(recentMinutes * 7 / lookbackDays);
    const qualityAllowed = evidenceCount >= 6 && recentWeeklyMinutes >= 90 && latestAge <= 14 && hasCoverage;
    const requestedMinutes = availability.weeklyMinutes || 120;
    const coldOrSparse = !evidenceCount || evidenceCount < 3 || latestAge > 14 || !hasCoverage;
    const baseCap = coldOrSparse
      ? Math.min(requestedMinutes, 60)
      : Math.min(requestedMinutes, recentWeeklyMinutes);
    const cap = nearGoal ? Math.min(requestedMinutes, Math.max(20, Math.floor(baseCap * 0.8))) : baseCap;
    const sessionLimit = coldOrSparse ? Math.min(2, availability.daysPerWeek) : availability.daysPerWeek;
    // Keep the same selected weekdays throughout a week; advancing a day must
    // not silently move already scheduled sessions to different weekdays.
    const selectedWeekdays = availability.days.slice().sort((a,b) => ((a+6)%7)-((b+6)%7)).slice(0,sessionLimit);
    let proposalStart = monday(today);
    const weekDates = start => selectedWeekdays.map(day => addDays(start,(day+6)%7));
    if (!weekDates(proposalStart).some(date => date >= today)) proposalStart = addDays(proposalStart,7);
    const proposalEnd = addDays(proposalStart,6);
    const dates = weekDates(proposalStart);
    const sessions = dates.map((date, index) => {
      let type = 'easy';
      let title = 'Lätt pass';
      let minutes = coldOrSparse ? Math.min(30, Math.max(20, Math.round(cap / Math.max(1, sessionLimit)))) : Math.round(cap / Math.max(1, availability.daysPerWeek));
      if (index === dates.length - 1 && dates.length >= 3) { type = 'long'; title = 'Långt lugnt pass'; minutes = Math.max(minutes, coldOrSparse ? 30 : 55); }
      else if (index === 0 && dates.length >= 3 && qualityAllowed) { type = 'quality'; title = targetKm !== null && targetKm <= 10 ? 'Kontrollerad fart mot målet' : 'Kontrollerad kvalitet'; minutes = Math.min(Math.max(minutes + 5, 35), 60); }
      return { id: `proposal:${proposalStart}:${date}`, date, type, title, durationMinutes: minutes, rationale: 'Fördelad inom tillgängliga dagar och veckotid.' };
    });
    while (sessions.length && cap < sessions.length * 20) sessions.pop();
    const total = sessions.reduce((sum, session) => sum + session.durationMinutes, 0);
    if (total > cap && total > 0) {
      const factor = cap / total;
      sessions.forEach(session => { session.durationMinutes = Math.max(20, Math.floor(session.durationMinutes * factor)); });
      while (sessions.reduce((sum, session) => sum + session.durationMinutes, 0) > cap) {
        const longest = sessions.slice().sort((a, b) => b.durationMinutes - a.durationMinutes)[0];
        if (!longest || longest.durationMinutes <= 20) break;
        longest.durationMinutes -= 5;
      }
    }
    const cautions = [];
    if (!evidenceCount) cautions.push('Inga färska löppass finns: börja försiktigt och lägg inte in hård kvalitet ännu.');
    if (latestDate && latestAge > 14) cautions.push('Senaste löppasset är äldre än två veckor: öka gradvis när färska data finns.');
    if (byType.quality >= 2) cautions.push('Kvalitet i underlaget ger ingen automatisk hårdare plan; nästa vecka hålls konservativ.');
    if (!hasCoverage) cautions.push('Datatäckningen är inte bekräftad för perioden: kvalitetspass föreslås inte.');
    if (availability.weeklyMinutes === null) cautions.push('Veckotid saknas i profilen: tidsförslagen är grova startvärden.');
    if (nearGoal) cautions.push('Måldatumet ligger nära: volymen hålls något lägre och kvalitet föreslås bara med komplett, färskt underlag.');
    const goalText = targetKm ? `Målet är ${targetKm} km${targetSeconds ? ` på ${Math.round(targetSeconds / 60)} minuter` : ''}.` : 'Måldistans och måltid saknas.';
    return {
      kind: 'weekly_proposal',
      startDate: proposalStart,
      endDate: proposalEnd,
      sessions,
      availability,
      evidence: { recentWeeklyMinutes, coverageConfirmed: hasCoverage, recentCount: evidenceCount, byType, latestDate, targetKm, targetSeconds, targetDate, daysToGoal, goalFocus },
      cautions,
      rationale: evidenceCount
        ? `Bygger på ${evidenceCount} färska löppass och profilen (${availability.daysPerWeek} pass, ${availability.days.length} möjliga veckodagar). ${goalText} Fokus: ${goalFocus}. Tidsförslag hålls inom ${cap} minuter.`
        : `Underlaget är tomt eller inaktuellt. ${goalText} Därför föreslås bara en försiktig start.`
    };
  }

  function activityDate(activity) {
    return toIso(activity?.activity_date || activity?.date || activity?.started_at);
  }

  function activityMatchesDay(activity, day) {
    const activityType = classifyType(activity);
    const dayType = classifyType({ activity_type: day?.workoutType, name: day?.title, category: day?.category });
    if (day?.category === 'rest') return false;
    if (day?.category === 'strength') return activityType === 'strength';
    if (day?.category === 'long' || day?.category === 'quality' || day?.category === 'easy' || day?.category === 'recovery') {
      return activityType === 'running';
    }
    return dayType === 'unknown' || activityType === dayType;
  }

  function matchActivitiesToPlan(activities = [], days = [], options = {}) {
    const used = new Set(options.usedActivityIds || []);
    const proposals = [];
    const unmatched = [];
    for (const day of days) {
      if (day?.category === 'rest') continue;
      const candidates = activities.filter(activity => {
        const id = String(activity.id || activity.activity_id || '');
        return id && !used.has(id) && activityMatchesDay(activity, day) && dateDistance(activityDate(activity), day.date) <= (options.maxDateDistance ?? 1);
      }).sort((a, b) => {
        const dateDiff = dateDistance(activityDate(a), day.date) - dateDistance(activityDate(b), day.date);
        return dateDiff || String(a.id).localeCompare(String(b.id));
      });
      if (!candidates.length) { unmatched.push(day); continue; }
      const bestDistance = dateDistance(activityDate(candidates[0]), day.date);
      const best = candidates.filter(candidate => dateDistance(activityDate(candidate), day.date) === bestDistance);
      const proposal = {
        planDayId: day._planDayId || day.id || day.date,
        planDate: day.date,
        status: best.length === 1 ? 'proposed' : 'ambiguous',
        candidates: best.map(candidate => ({
          activityId: String(candidate.id || candidate.activity_id),
          date: activityDate(candidate),
          type: classifyType(candidate),
          distanceKm: asNumber(candidate.distance_meters) === null ? asNumber(candidate.distance_km) : asNumber(candidate.distance_meters) / 1000,
          durationSeconds: asNumber(candidate.moving_time_seconds) ?? asNumber(candidate.timer_duration_seconds) ?? asNumber(candidate.duration_seconds) ?? asNumber(candidate.duration)
        }))
      };
      proposals.push(proposal);
      if (best.length === 1) used.add(proposal.candidates[0].activityId);
    }
    return { proposals, unmatched, usedActivityIds: [...used] };
  }

  function mergeLogs(local = {}, cloud = {}) {
    const merged = {}, conflicts = [], pending = [], conflictEntries = {};
    const stamp = row => row?.updatedAt || row?.updated_at || null;
    // Keep the server's full microsecond precision: timestamps are row revisions.
    const sameStamp = (a,b) => typeof a === 'string' && a.length > 0 && a === b;
    const fields = [['status','status'],['rpe','rpe'],['hipPain','hip_pain'],['sleepQuality','sleep_quality'],['stress','stress'],['energy','energy'],['actualDistanceKm','actual_distance_km'],['actualDurationMinutes','actual_duration_minutes'],['notes','notes'],['activityId','activity_id']];
    const content = row => JSON.stringify(fields.map(([camel,snake]) => row?.[camel] ?? row?.[snake] ?? (camel === 'notes' ? '' : camel === 'status' ? 'planned' : null)));
    for (const key of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
      const left = local[key], right = cloud[key];
      if (!right) { if (left) { merged[key] = {...left}; if (left._pending !== false) pending.push(key); } continue; }
      const fromCloud = {...left, ...right, _pending:false, _cloudUpdatedAt:stamp(right)};
      delete fromCloud._conflict; delete fromCloud._localConflict;
      if (!left || left._pending === false || (sameStamp(stamp(left),stamp(right)) && content(left) === content(right))) {
        merged[key] = fromCloud;
      } else if (sameStamp(left._cloudUpdatedAt,stamp(right))) {
        merged[key] = {...left,_pending:true}; pending.push(key);
      } else {
        // Preserve both versions. Device clocks never decide who wins a conflict.
        merged[key] = {...left,_pending:true,_conflict:true};
        conflicts.push(key); conflictEntries[key] = {local:{...left},cloud:{...right}};
      }
    }
    return {merged,conflicts,conflictEntries,pending};
  }

  function normalizeLogFromCloud(row) {
    if (!row) return null;
    return {
      status: row.status || 'planned', rpe: row.rpe ?? null, hipPain: row.hip_pain ?? null,
      sleepQuality: row.sleep_quality ?? null, stress: row.stress ?? null, energy: row.energy ?? null,
      actualDistanceKm: row.actual_distance_km ?? null, actualDurationMinutes: row.actual_duration_minutes ?? null,
      notes: row.notes || '', activityId: row.activity_id || null,
      updatedAt: row.updated_at || row.created_at || null, _pending: false
    };
  }

  return {
    addDays, monday, toIso, dateDistance, readiness, planState, recommendToday, classifyType,
    proposeWeeklySchedule, matchActivitiesToPlan, mergeLogs, normalizeLogFromCloud
  };
}));
