const test = require('node:test');
const assert = require('node:assert/strict');

const security = require('../js/security.js');

test('escapeHtml neutralizes markup and attribute delimiters', () => {
  const payload = `<img src=x onerror="globalThis.pwned=true">'&`;
  assert.equal(
    security.escapeHtml(payload),
    '&lt;img src=x onerror=&quot;globalThis.pwned=true&quot;&gt;&#39;&amp;'
  );
});

test('PostgREST UUID filters reject query-shaping input', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(security.postgrestUuidFilter('activity_id', id), `activity_id=eq.${id}`);
  assert.throws(
    () => security.postgrestUuidFilter('activity_id', `${id}&or=(user_id.neq.null)`),
    /Ogiltigt pass-ID/
  );
  assert.throws(() => security.postgrestUuidFilter('id&or', id), /Ogiltigt filterfält/);
});

test('auth sessions retain only fields needed by the app', () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  const session = security.normalizeAuthSession({
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 60,
    provider_token: 'must-not-persist',
    user: { id, email: 'runner@example.test', private_metadata: 'must-not-persist' }
  }, 1_000);

  assert.deepEqual(session, {
    access_token: 'access',
    refresh_token: 'refresh',
    token_type: 'bearer',
    expires_at: 61_000,
    user: { id, email: 'runner@example.test' }
  });
  assert.equal(security.normalizeAuthSession({ refresh_token: 'only' }), null);
});

test('plan-log imports reject status injection and unknown days', () => {
  const safe = security.normalizePlanLogs({
    day_1: { status: 'completed', rpe: 7, hipPain: 0, notes: '<b>kept as text</b>' }
  }, ['day_1']);
  assert.equal(safe.day_1.status, 'completed');
  assert.equal(safe.day_1.notes, '<b>kept as text</b>');

  assert.throws(
    () => security.normalizePlanLogs({ day_1: { status: `planned\" onmouseover=\"alert(1)` } }, ['day_1']),
    /ogiltig status/
  );
  assert.throws(
    () => security.normalizePlanLogs({ attacker_day: { status: 'planned' } }, ['day_1']),
    /okänd plandag/
  );
});

test('plan-log imports enforce numeric bounds and note size', () => {
  assert.throws(
    () => security.normalizePlanLogs({ day_1: { status: 'planned', rpe: 11 } }, ['day_1']),
    /RPE/
  );
  assert.throws(
    () => security.normalizePlanLogs({ day_1: { status: 'planned', notes: 'x'.repeat(4001) } }, ['day_1']),
    /anteckningar/
  );
  assert.throws(() => security.normalizePlanLog({ status:'planned', actualDistanceKm:1001 }), /distans/);
  assert.throws(() => security.normalizePlanLog({ status:'planned', actualDurationMinutes:10081 }), /varaktighet/);
});
