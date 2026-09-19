const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../js/plan-core.js');

test('readiness is unknown until all primary check-in inputs exist', () => {
  assert.equal(core.readiness({}).level, 'unknown');
  assert.equal(core.readiness({ sleepQuality: 4, stress: 2, energy: 4 }).level, 'unknown');
  assert.equal(core.readiness({ sleepQuality: 4, stress: 2, energy: 4, hipPain: 0 }).level, 'green');
  assert.equal(core.readiness({ sleepQuality: 2, stress: 4, energy: 4, hipPain: 0 }).level, 'red');
  assert.equal(core.readiness({ hipPain: 4 }).level, 'red');
});

test('expired plan is archived and never recommended as today', () => {
  const result = core.planState({ metadata: { startDate: '2026-05-25', endDate: '2026-07-19' } }, '2026-09-18');
  assert.equal(result.state, 'expired');
  assert.match(result.reason, /avslutat/);
  assert.equal(core.recommendToday({ metadata: { startDate: '2026-05-25', endDate: '2026-07-19' }, days: [] }, '2026-09-18').day, null);
});

test('weekly proposal uses recent training and profile availability', () => {
  const proposal = core.proposeWeeklySchedule({
    today: '2026-09-18',
    activities: [
      { id: 'r1', activity_date: '2026-09-15', activity_type: 'running', duration_seconds: 2400, distance_meters: 6000 },
      { id: 'r2', activity_date: '2026-09-12', activity_type: 'running', duration_seconds: 3600, distance_meters: 9000 }
    ],
    profile: { daysPerWeek: 3, weeklyMinutes: 150, availableDays: [1, 3, 6], goal: { distanceKm: 10, targetSeconds: 2400 } }
  });
  assert.equal(proposal.sessions.length, 2);
  assert.deepEqual(proposal.sessions.map(session => new Date(`${session.date}T12:00:00`).getDay()).sort((a, b) => a - b), [1, 3]);
  assert.ok(proposal.sessions.every(session => session.id.startsWith('proposal:2026-09-21:')));
  assert.equal(proposal.evidence.recentCount, 2);
  assert.ok(proposal.rationale.includes('2'));
});

test('thin or unconfirmed data never gets a fixed quality session', () => {
  const proposal = core.proposeWeeklySchedule({
    today: '2026-09-18',
    activities: [{ id: 'h1', activity_date: '2026-09-17', activity_type: 'hiking', duration_seconds: 7200, distance_meters: 20000 }],
    profile: { daysPerWeek: 4, weeklyMinutes: 240, availableDays: [1, 3, 5, 6], coverageStart: '', coverageThrough: '' }
  });
  assert.equal(proposal.sessions.some(session => session.type === 'quality'), false);
  assert.ok(proposal.cautions.some(text => text.includes('kvalitet')));
  assert.ok(proposal.sessions.length <= 2);
  assert.ok(proposal.sessions.every(session => session.durationMinutes <= 30));
});

test('proposal IDs stay stable within a calendar week', () => {
  const profile = { daysPerWeek: 2, weeklyMinutes: 120, availableDays: [1, 3], coverageStart: '', coverageThrough: '' };
  const thursday = core.proposeWeeklySchedule({ today: '2026-09-17', profile });
  const friday = core.proposeWeeklySchedule({ today: '2026-09-18', profile });
  assert.deepEqual(thursday.sessions.map(session => session.id), friday.sessions.map(session => session.id));
});

test('quality is only proposed with enough recent running evidence and coverage', () => {
  const proposal = core.proposeWeeklySchedule({
    today: '2026-09-18',
    activities: Array.from({length:18}, (_,index) => ({
      id: `r${index}`, activity_date: core.addDays('2026-09-17', -index*2),
      activity_type: 'running', duration_seconds: 2400, distance_meters: 6000
    })),
    profile: { daysPerWeek: 4, weeklyMinutes: 240, availableDays: [1, 3, 5, 6], coverageStart: '2026-08-01', coverageThrough: '2026-09-18' }
  });
  assert.equal(proposal.sessions.filter(session => session.type === 'quality').length, 1);
});

test('matching proposes ambiguity and never reuses an activity', () => {
  const days = [{ _planDayId: 'd1', date: '2026-09-17', category: 'easy' }, { _planDayId: 'd2', date: '2026-09-18', category: 'quality' }];
  const activities = [
    { id: 'a1', activity_date: '2026-09-17', activity_type: 'running', distance_meters: 6000, duration_seconds: 2000 },
    { id: 'a2', activity_date: '2026-09-17', activity_type: 'running', distance_meters: 6100, duration_seconds: 2050 },
    { id: 'a3', activity_date: '2026-09-18', activity_type: 'running', distance_meters: 8000, duration_seconds: 2800 }
  ];
  const result = core.matchActivitiesToPlan(activities, days);
  assert.equal(result.proposals[0].status, 'ambiguous');
  assert.deepEqual(result.proposals[1].candidates.map(item => item.activityId), ['a3']);
  assert.deepEqual(result.usedActivityIds.sort(), ['a3']);
});

test('hiking cannot be silently matched to a running workout', () => {
  const result = core.matchActivitiesToPlan(
    [{ id: 'h1', activity_date: '2026-09-18', activity_type: 'hiking', distance_meters: 8000, duration_seconds: 3600 }],
    [{ _planDayId: 'run', date: '2026-09-18', category: 'easy' }]
  );
  assert.equal(result.proposals.length, 0);
  assert.equal(result.unmatched.length, 1);
});

test('conflicting offline edits retain both versions regardless of device clocks', () => {
  const result = core.mergeLogs(
    {
      d1: { status: 'completed', updatedAt: '2026-09-18T10:00:00Z', _pending: true },
      d2: { status: 'skipped', updatedAt: '2026-09-18T12:00:00Z', _pending: true }
    },
    {
      d1: { status: 'planned', updated_at: '2026-09-18T11:00:00Z' },
      d2: { status: 'completed', updated_at: '2026-09-18T11:00:00Z' }
    }
  );
  assert.equal(result.merged.d1.status, 'completed');
  assert.equal(result.merged.d2.status, 'skipped');
  assert.deepEqual(result.pending, []);
  assert.ok(result.conflicts.includes('d2'));
  assert.ok(result.conflicts.includes('d1'));
  assert.equal(result.conflictEntries.d1.local.status, 'completed');
});

test('cloud merge keeps a baseline timestamp for compare-and-swap writes', () => {
  const result = core.mergeLogs({}, { d1: { status: 'planned', updated_at: '2026-09-18T11:00:00Z' } });
  assert.equal(result.merged.d1._cloudUpdatedAt, '2026-09-18T11:00:00Z');
});


test('observed weekly volume is divided by weeks, and a larger time budget does not inflate it', () => {
  const activities=Array.from({length:18},(_,i)=>({id:String(i),activity_type:'running',activity_date:core.addDays('2026-09-18',-i*2),duration_seconds:2400}));
  const profile={daysPerWeek:4,weeklyMinutes:400,availableDays:[1,3,5,6],coverageStart:'2026-07-01',coverageThrough:'2026-09-18'};
  const p=core.proposeWeeklySchedule({today:'2026-09-18',activities,profile});
  assert.equal(p.evidence.recentWeeklyMinutes,120);
  assert.ok(p.sessions.reduce((n,s)=>n+s.durationMinutes,0)<=120);
  const incomplete=core.proposeWeeklySchedule({today:'2026-09-18',activities,profile:{...profile,coverageStart:'2026-09-18'}});
  assert.equal(incomplete.sessions.some(s=>s.type==='quality'),false);
  const near=core.proposeWeeklySchedule({today:'2026-09-18',activities,profile:{...profile,weeklyMinutes:20,daysPerWeek:1,goal:{targetDate:'2026-09-20'}}});
  assert.ok(near.sessions.reduce((n,s)=>n+s.durationMinutes,0)<=20);
});

test('Sunday remains in this week and selected session dates do not shift on the next day', () => {
 const profile={daysPerWeek:2,weeklyMinutes:60,availableDays:[3,0]};
 const a=core.proposeWeeklySchedule({today:'2026-09-18',profile});
 const b=core.proposeWeeklySchedule({today:'2026-09-19',profile});
 assert.deepEqual(a.sessions.map(s=>s.id),b.sessions.map(s=>s.id));
 assert.equal(a.sessions.at(-1).date,'2026-09-20');
});


test('normal reload does not invent conflicts from local metadata and matching-baseline edits remain pending',()=>{
 const cloud={d1:{status:'completed',rpe:4,updatedAt:'2026-09-18T11:00:00+00:00'}};
 const cached={d1:{status:'completed',rpe:4,updatedAt:'2026-09-18T11:00:00Z',_pending:false,_cloudUpdatedAt:'2026-09-18T11:00:00Z',planDate:'2026-09-18'}};
 const normal=core.mergeLogs(cached,cloud);
 assert.equal(normal.conflicts.length,0);
 const pending=core.mergeLogs({d1:{...normal.merged.d1,rpe:5,_pending:true,updatedAt:'2026-09-18T09:00:00Z'}},cloud);
 assert.deepEqual(pending.pending,['d1'],'matching baseline permits edits even on a slow device clock');
 assert.equal(pending.merged.d1.rpe,5);
 const changed=core.mergeLogs({d1:{...cached.d1,rpe:5,_pending:true,updatedAt:'2026-09-18T12:00:00Z'}},{d1:{...cloud.d1,rpe:6,updatedAt:'2026-09-18T11:01:00Z'}});
 assert.deepEqual(changed.conflicts,['d1']);
 assert.equal(changed.conflictEntries.d1.local.rpe,5);
 assert.equal(changed.conflictEntries.d1.cloud.rpe,6);
});

test('cloud revisions differing only by microseconds cannot overwrite each other',()=>{
 const baseline='2026-09-18T11:00:00.123001+00:00';
 const newer='2026-09-18T11:00:00.123002+00:00';
 const result=core.mergeLogs(
   {d1:{status:'completed',rpe:4,_pending:true,_cloudUpdatedAt:baseline,updatedAt:baseline}},
   {d1:{status:'completed',rpe:5,updatedAt:newer}}
 );
 assert.deepEqual(result.conflicts,['d1']);
 assert.deepEqual(result.pending,[]);
 assert.equal(result.conflictEntries.d1.local.rpe,4);
 assert.equal(result.conflictEntries.d1.cloud.rpe,5);
});
