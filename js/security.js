(function initAppSecurity(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AppSecurity = api;
    root.escapeHtml = api.escapeHtml;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAppSecurity() {
  'use strict';

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const FILTER_COLUMN_PATTERN = /^[a-z][a-z0-9_]*$/;
  const PLAN_STATUSES = new Set(['planned', 'completed', 'scaled_down', 'skipped']);

  function escapeHtml(value = '') {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
  }

  function isUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
  }

  function requireUuid(value, label = 'ID') {
    if (!isUuid(value)) throw new Error(`Ogiltigt ${label}.`);
    return value;
  }

  function postgrestUuidFilter(column, value) {
    if (!FILTER_COLUMN_PATTERN.test(column)) throw new Error('Ogiltigt filterfält.');
    return `${column}=eq.${encodeURIComponent(requireUuid(value, 'pass-ID'))}`;
  }

  function safeErrorMessage(error, fallback = 'Ett oväntat fel inträffade.', maxLength = 500) {
    const raw = error && typeof error === 'object' && 'message' in error ? error.message : error;
    const message = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
    return message.slice(0, maxLength);
  }

  function normalizeAuthSession(data, now = Date.now()) {
    if (!isPlainObject(data) || typeof data.access_token !== 'string' || !data.access_token) return null;
    const providedExpiry = data.expires_at ? Number(data.expires_at) : null;
    const expiresAt = providedExpiry
      ? (providedExpiry < 1000000000000 ? providedExpiry * 1000 : providedExpiry)
      : (now + ((Number(data.expires_in) || 3600) * 1000));
    if (!Number.isFinite(expiresAt)) return null;

    const user = isPlainObject(data.user) ? {
      id: isUuid(data.user.id) ? data.user.id : null,
      email: typeof data.user.email === 'string' ? data.user.email.slice(0, 320) : ''
    } : null;

    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : '',
      token_type: typeof data.token_type === 'string' ? data.token_type : 'bearer',
      expires_at: expiresAt,
      user
    };
  }

  function normalizePlanLogs(logs, allowedDayIds) {
    if (!isPlainObject(logs)) throw new Error('Backupen saknar giltiga loggar.');
    const allowed = new Set(Array.isArray(allowedDayIds) ? allowedDayIds.map(String) : []);
    const normalized = {};

    for (const [dayId, raw] of Object.entries(logs)) {
      if (!allowed.has(dayId)) throw new Error('Backupen innehåller en okänd plandag.');
      normalized[dayId] = normalizePlanLog(raw);
    }
    return normalized;
  }

  function normalizePlanLog(raw) {
    if (!isPlainObject(raw)) throw new Error('En planlogg har ogiltigt format.');
    const status = raw.status === undefined ? 'planned' : raw.status;
    if (!PLAN_STATUSES.has(status)) throw new Error('En planlogg har ogiltig status.');

    const notes = raw.notes === undefined || raw.notes === null ? '' : raw.notes;
    if (typeof notes !== 'string' || notes.length > 4000) throw new Error('En planlogg har ogiltiga anteckningar.');

    const result = {
      status,
      rpe: boundedNumber(raw.rpe, 1, 10, 'RPE'),
      hipPain: boundedNumber(raw.hipPain, 0, 10, 'höftsmärta'),
      sleepQuality: boundedNumber(raw.sleepQuality, 1, 5, 'sömnkvalitet'),
      stress: boundedNumber(raw.stress, 1, 5, 'stress'),
      energy: boundedNumber(raw.energy, 1, 5, 'energi'),
      actualDistanceKm: boundedNumber(raw.actualDistanceKm, 0, 1000, 'distans'),
      actualDurationMinutes: boundedNumber(raw.actualDurationMinutes, 0, 10080, 'varaktighet'),
      notes
    };

    if (raw.updatedAt !== undefined) {
      if (typeof raw.updatedAt !== 'string' || raw.updatedAt.length > 40 || !Number.isFinite(Date.parse(raw.updatedAt))) {
        throw new Error('En planlogg har ogiltig tidsstämpel.');
      }
      result.updatedAt = raw.updatedAt;
    }
    return result;
  }

  function boundedNumber(value, min, max, label) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
      throw new Error(`En planlogg har ogiltigt värde för ${label}.`);
    }
    return number;
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  return {
    escapeHtml,
    isUuid,
    requireUuid,
    postgrestUuidFilter,
    safeErrorMessage,
    normalizeAuthSession,
    normalizePlanLogs,
    normalizePlanLog
  };
});
