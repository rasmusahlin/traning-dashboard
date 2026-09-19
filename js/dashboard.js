(() => {
  const $ = id => document.getElementById(id);
  const esc = value => escapeHtml(String(value ?? ''));
  let activities = [];
  let visible = 20;
  let chart;
  const today = Training.localDate(new Date());
  const number = (value, digits = 0) => Number(value).toLocaleString('sv-SE', { maximumFractionDigits: digits });
  const signed = (value, unit) => `${value > 0 ? '+' : ''}${number(value, 1)} ${unit} mot föregående period`;
  const link = id => `activity.html?id=${encodeURIComponent(id)}`;
  function withCoverage(list, profile) {
    list.coverage = { start: profile.coverageStart, through: profile.coverageThrough };
    return list;
  }

  async function init() {
    try {
      await TrainingProfile.load();
      activities = (await dbQueryAll('activities?order=activity_date.desc,id.desc')).filter(a => a.activity_date <= today);
      $('filter-from').value = Training.addDays(today, -90);
      $('filter-to').value = today;
      for (const id of ['filter-from','filter-to','type-filter']) $(id).addEventListener('change', () => { visible = 20; renderList(); });
      $('filter-all').addEventListener('click', () => { $('filter-from').value = ''; $('filter-to').value = today; visible = 20; renderList(); });
      $('show-more').addEventListener('click', () => { visible += 30; renderList(); });
      render();
    } catch (error) {
      $('data-status').textContent = 'Historiken kunde inte hämtas fullständigt. Kontrollera anslutningen och försök igen.';
      $('data-status').classList.add('warning');
      $('goal-card').textContent = 'Väntar på träningshistoriken.';
      $('next-card').textContent = 'Inga träningsråd visas utan hämtat underlag.';
    }
  }

  function render() {
    const profile = TrainingProfile.get();
    const rows = withCoverage(activities, profile);
    const latest = activities[0]?.activity_date;
    const age = latest ? Math.round((new Date(`${today}T12:00:00`) - new Date(`${latest}T12:00:00`)) / 86400000) : null;
    const coverage = profile.coverageStart && profile.coverageThrough
      ? `Bekräftat komplett ${profile.coverageStart}–${profile.coverageThrough}.`
      : 'Täckningen är inte bekräftad; tomma dagar kan vara saknade importer.';
    $('data-status').innerHTML = `${latest ? `Senaste registrerade pass: <strong>${esc(latest)}</strong>${age > 7 ? ` (${age} dagar sedan)` : ''}. ${activities.length} pass hämtade.` : 'Inga pass importerade ännu.'} ${esc(coverage)} <a class="insight-link" href="${latest ? 'settings.html' : 'upload.html'}">${latest ? 'Kontrollera underlaget' : 'Importera Garmin-filer'}</a>`;
    $('data-status').classList.toggle('warning', age === null || age > 7 || !profile.coverageThrough || profile.coverageThrough < today);
    renderGoal(profile);
    renderNext(profile);
    renderPeriods(rows, profile);
    renderComparable(profile);
    renderStrength(profile);
    renderList();
  }

  function renderGoal(profile) {
    const goal = profile.goal;
    const tests = activities.filter(a => a.activity_type === 'running' && ['test','race'].includes(profile.activityTags[a.id]?.kind) &&
      Math.abs(Number(a.distance_meters) / 1000 - goal.distanceKm) <= goal.distanceKm * .01 && Number(a.duration_seconds) > 0);
    const latest = tests[0];
    const actual = latest ? `${fmtDuration(latest.duration_seconds)} den ${latest.activity_date}` : 'Inget markerat test på måldistansen ännu';
    const gap = latest ? Number(latest.duration_seconds) - goal.targetSeconds : null;
    $('goal-card').innerHTML = `<div class="eyebrow">Mitt mål</div><h2 class="insight-title">${esc(goal.label || `${goal.distanceKm} km på ${fmtDuration(goal.targetSeconds)}`)}</h2>
      <p class="muted">${number(goal.distanceKm, 1)} km · ${esc(fmtDuration(goal.targetSeconds))} · ${esc(fmtPace(goal.targetSeconds / goal.distanceKm))}/km${goal.targetDate ? ` · ${esc(goal.targetDate)}` : ' · inget måldatum valt'}</p>
      <ul class="insight-list"><li><strong>Senaste test/tävling:</strong> ${latest ? `<a class="insight-link" href="${link(latest.id)}">${esc(actual)}</a>` : esc(actual)}</li>
      <li>${gap === null ? 'Markera ett test eller en tävling på passets detaljsida för att följa verkliga resultat.' : gap > 0 ? `${esc(fmtDuration(gap))} återstår till måltiden i det senaste resultatet.` : 'Det senaste markerade resultatet ligger på eller under måltiden.'}</li></ul>
      <div class="actions"><a class="btn" href="settings.html">Ändra mål</a><a class="insight-link" href="analysis.html#projection">Visa enkel trendprognos</a></div>`;
  }

  function renderNext(profile) {
    const proposal = PlanCore.proposeWeeklySchedule({ activities, profile, today });
    $('next-card').innerHTML = `<div class="eyebrow">Nästa steg</div><h2 class="insight-title">Din plan följer träningen</h2>
      <p class="muted">${esc(proposal.rationale)}</p>
      <p class="muted">${esc(proposal.cautions?.[0] || 'Förslaget behöver stämmas av mot hur du mår idag. Återhämtningsläge antas inte från passhistoriken.')}</p>
      <a class="btn btn-primary" href="plan/">Se vecka och nästa pass</a>`;
  }

  function renderPeriods(rows, profile) {
    const result = Training.comparePeriods(rows, today);
    const { current, previous, delta } = result;
    $('period-label').textContent = `${current.from}–${current.to}, jämfört med ${previous.from}–${previous.to}. Pågående vecka ingår inte i periodjämförelsen.`;
    const strengths = rows.filter(a => a.activity_type === 'strength' && a.activity_date >= current.from && a.activity_date <= current.to).length;
    const pastStrength = rows.filter(a => a.activity_type === 'strength' && a.activity_date >= previous.from && a.activity_date <= previous.to).length;
    $('period-metrics').innerHTML = [
      ['Löpdistans', `${number(current.km,1)} km`, signed(delta.km,'km')],
      ['Löptid', `${number(current.minutes)} min`, signed(delta.minutes,'min')],
      ['Löppass', current.runs, signed(delta.runs,'pass')],
      ['Styrkepass', strengths, signed(strengths-pastStrength,'pass')]
    ].map(([label,value,sub]) => `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-sub">${sub}</div></div>`).join('');
    $('period-conclusion').textContent = current.coverage !== 'confirmed' || previous.coverage !== 'confirmed'
      ? 'Detta är registrerad träning. Importluckor kan påverka skillnaden; mer eller mindre registrerad volym är inte i sig ett besked om formen.'
      : `Du har ${delta.km > 0 ? 'ökat' : delta.km < 0 ? 'minskat' : 'behållit'} löpvolymen mellan perioderna. Bedöm utvecklingen tillsammans med jämförbara pass och återhämtning.`;
    const weeks = Training.calendarWeeks(rows, Training.addDays(Training.monday(today), -77), today);
    const values = weeks.map(w => w.runs || w.coverage === 'confirmed' ? w.km : null);
    if (chart) chart.destroy();
    if (typeof Chart !== 'undefined') chart = new Chart($('chart-weekly'), { type: 'bar', data: {
      labels: weeks.map(w => w.date.slice(5)), datasets: [{ label: 'Registrerade km', data: values, backgroundColor: weeks.map(w => w.coverage === 'confirmed' ? '#185fa5' : '#8caecb'), borderRadius: 3 }]
    }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display:false }, tooltip:{ callbacks:{ afterLabel: item => weeks[item.dataIndex].coverage === 'confirmed' ? 'Bekräftad täckning' : 'Täckning inte bekräftad' } } }, scales:{ y:{beginAtZero:true}, x:{grid:{display:false}} } } });
    $('weekly-note').textContent = 'Mörka staplar: bekräftad täckning. Ljusa: registrerade pass med osäker täckning. Tomma luckor är inte bekräftad vila. Sista veckan pågår.';
    $('weekly-table').innerHTML = `<table class="splits-table"><thead><tr><th>Vecka från</th><th>Km</th><th>Pass</th><th>Underlag</th></tr></thead><tbody>${weeks.map(w => `<tr><td>${esc(w.date)}</td><td>${w.runs || w.coverage === 'confirmed' ? number(w.km,1) : '–'}</td><td>${w.runs}</td><td>${w.coverage === 'confirmed' ? 'Komplett' : 'Kan saknas pass'}</td></tr>`).join('')}</tbody></table>`;
  }

  function renderComparable(profile) {
    const result = Training.comparableRuns(activities, profile);
    const runs = result.runs.filter(r => r.paceSeconds > 0);
    const average = list => list.reduce((s,r) => s+r.paceSeconds,0)/list.length;
    const old = runs.slice(-6,-3), recent = runs.slice(-3);
    const diff = old.length === 3 && recent.length === 3 ? average(recent)-average(old) : null;
    const statement = diff === null ? 'Bygg en jämförbar serie' : Math.abs(diff) < 3 ? 'Ungefär samma tempo' : diff < 0 ? 'Snabbare på jämförbara pass' : 'Långsammare på jämförbara pass';
    $('comparable-card').innerHTML = `<div class="eyebrow">Utveckling på lugna pass</div><h2 class="insight-title">${statement}</h2>
      <p class="muted">${diff === null ? 'Minst sex matchande pass behövs för att jämföra två grupper om tre.' : `${Math.round(Math.abs(diff))} sek/km ${diff < 0 ? 'snabbare' : 'långsammare'} i de senaste tre jämfört med de tre föregående.`}</p>
      <p class="muted">${runs.length} matchande pass${result.latestDate ? ', senaste ' + esc(result.latestDate) : ''}. ${esc(result.limitations)} Märk gärna ut samma runda och underlag på passets detaljsida.</p>
      <a class="insight-link" href="analysis.html">Se urval och pass bakom jämförelsen</a>`;
  }

  function renderStrength(profile) {
    const rows = activities.filter(a => a.activity_type === 'strength');
    const entries = rows.map(a => ({a, set:profile.activityTags[a.id]?.strength})).filter(e => e.set?.exercise);
    const last = entries[0];
    const prior = last && entries.slice(1).find(e => e.set.exercise.toLowerCase() === last.set.exercise.toLowerCase());
    $('strength-card').innerHTML = `<div class="card-header"><h2 class="card-title">Styrka och kontinuitet</h2></div>
      <p class="muted">${rows.length ? `Senaste styrkepasset: ${esc(rows[0].activity_date)}.` : 'Inga styrkepass registrerade ännu.'} Antal pass visar vanan; belastning och repetitioner visar utveckling i en övning.</p>
      ${last ? `<p><strong>${esc(last.set.exercise)}</strong>: <a class="insight-link" href="${link(last.a.id)}">${number(last.set.weightKg,1)} kg × ${number(last.set.reps)} den ${esc(last.a.activity_date)}</a>${prior ? ` · föregående: ${number(prior.set.weightKg,1)} kg × ${number(prior.set.reps)} den ${esc(prior.a.activity_date)}` : ''}.</p><p class="muted">Jämför med samma teknik och liknande ansträngning. Ingen maxstyrka uppskattas från enstaka set.</p>` : '<p class="muted">Du kan frivilligt spara ett arbetsset på styrkepassets detaljsida. Ingen extra registrering krävs för att följa kontinuiteten.</p>'}`;
  }

  function renderList() {
    const from = $('filter-from').value, to = $('filter-to').value, type = $('type-filter').value;
    const list = activities.filter(a => (!from || a.activity_date >= from) && (!to || a.activity_date <= to) && (type === 'all' || a.activity_type === type));
    $('filter-count').textContent = `${list.length} pass`;
    $('show-more').hidden = list.length <= visible;
    $('activity-list').innerHTML = list.length ? list.slice(0,visible).map(a => {
      const pace = Training.paceSeconds(a);
      return `<div class="activity-item"><a href="${link(a.id)}" class="activity-main"><div class="activity-name">${esc(typeLabel(a.activity_type))} · ${esc(a.activity_date)}</div><div class="activity-meta">${esc(fmtDuration(a.moving_time_seconds || a.duration_seconds))}${a.avg_hr ? ` · ${esc(a.avg_hr)} bpm` : ''}${a.notes ? ` · ${esc(a.notes.slice(0,60))}` : ''}</div></a><a href="${link(a.id)}" class="activity-right"><div class="activity-dist">${esc(fmtDist(a.distance_meters))}</div><div class="activity-pace">${a.activity_type === 'running' ? `${esc(fmtPace(pace.seconds))}/km` : esc(typeLabel(a.activity_type))}</div></a><button class="btn btn-sm" type="button" data-delete="${esc(a.id)}" aria-label="Ta bort ${esc(typeLabel(a.activity_type))} ${esc(a.activity_date)}">Ta bort</button></div>`;
    }).join('') : '<p class="empty">Inga pass i urvalet. Ändra perioden eller importera dina Garmin-filer.</p>';
    for (const button of $('activity-list').querySelectorAll('[data-delete]')) button.addEventListener('click', async () => {
      if (!confirm('Ta bort detta pass och alla tillhörande detaljer? Detta går inte att ångra i dashboarden.')) return;
      button.disabled = true;
      try { await dbQuery(`activities?id=eq.${encodeURIComponent(button.dataset.delete)}`, { method:'DELETE' }); activities = activities.filter(a => a.id !== button.dataset.delete); render(); }
      catch (_) { toast('Passet kunde inte tas bort.'); button.disabled = false; }
    });
  }
  startApp(init);
})();
