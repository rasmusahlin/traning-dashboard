-- Activity import contract.
-- Apply after schema.sql, 001_owner_rls_auth.sql and 002_training_plan_logs.sql.
-- This migration is additive and is intentionally not executed by the app.

begin;

do $$
begin
  if to_regclass('public.activities') is null
     or to_regclass('public.laps') is null
     or to_regclass('public.km_splits') is null
     or to_regclass('public.time_series') is null then
    raise exception 'Migration 003 requires schema.sql tables (activities, laps, km_splits and time_series).';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'activities' and column_name = 'user_id'
  ) then
    raise exception 'Migration 003 requires migration 001_owner_rls_auth.sql; refusing an unowned import table.';
  end if;
end $$;

alter table public.activities
  add column if not exists started_at timestamptz,
  add column if not exists subsport_raw text,
  add column if not exists elapsed_duration_seconds numeric,
  add column if not exists timer_duration_seconds numeric,
  add column if not exists timer_time_source text,
  add column if not exists source_hash text,
  add column if not exists source_identity text,
  add column if not exists hr_zone_seconds jsonb,
  add column if not exists hr_coverage_seconds numeric,
  add column if not exists hr_zone_config jsonb;

alter table public.laps
  add column if not exists elapsed_duration_seconds numeric,
  add column if not exists moving_duration_seconds numeric,
  add column if not exists elapsed_pace_sec_per_km numeric;

alter table public.km_splits
  add column if not exists elapsed_duration_seconds numeric,
  add column if not exists timer_duration_seconds numeric,
  add column if not exists elapsed_pace_sec_per_km numeric;

alter table public.time_series
  add column if not exists elapsed_seconds numeric,
  add column if not exists timer_seconds numeric;

create unique index if not exists activities_user_source_hash_idx
  on public.activities(user_id, source_hash)
  where source_hash is not null;

create unique index if not exists activities_user_source_identity_idx
  on public.activities(user_id, source_identity)
  where source_identity is not null;

create index if not exists activities_user_started_at_idx
  on public.activities(user_id, started_at desc);

create or replace function public.import_activity_atomic(
  p_activity jsonb,
  p_laps jsonb default '[]'::jsonb,
  p_km_splits jsonb default '[]'::jsonb,
  p_time_series jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  owner_id uuid := auth.uid();
  existing_id uuid;
  imported_id uuid;
  item jsonb;
  key text;
  numeric_value numeric;
  legacy_count integer := 0;
  child_count integer := 0;
  upgraded boolean := false;
  inserted_new boolean := false;
  source_hash_value text := lower(nullif(p_activity->>'source_hash', ''));
  source_identity_value text := nullif(p_activity->>'source_identity', '');
begin
  if owner_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_activity is null or jsonb_typeof(p_activity) <> 'object' then
    raise exception 'INVALID_ACTIVITY_PAYLOAD';
  end if;
  if nullif(p_activity->>'activity_date', '') is null then
    raise exception 'INVALID_ACTIVITY_DATE';
  end if;
  if jsonb_typeof(coalesce(p_laps, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_km_splits, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_time_series, '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_CHILD_PAYLOAD';
  end if;
  if jsonb_array_length(coalesce(p_laps, '[]'::jsonb)) > 5000
     or jsonb_array_length(coalesce(p_km_splits, '[]'::jsonb)) > 20000
     or jsonb_array_length(coalesce(p_time_series, '[]'::jsonb)) > 1000 then
    raise exception 'IMPORT_CHILD_LIMIT_EXCEEDED';
  end if;
  if source_hash_value is not null and source_hash_value !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'INVALID_SOURCE_HASH';
  end if;
  foreach key in array array['distance_meters', 'duration_seconds', 'moving_time_seconds', 'elapsed_duration_seconds', 'timer_duration_seconds', 'avg_speed_ms', 'max_speed_ms', 'elevation_gain_meters', 'elevation_loss_meters', 'calories'] loop
    if p_activity ? key and nullif(p_activity->>key, '') is not null then
      if p_activity->>key !~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then
        raise exception 'INVALID_ACTIVITY_NUMBER:%', key;
      end if;
      numeric_value := (p_activity->>key)::numeric;
      if numeric_value < 0 then raise exception 'NEGATIVE_ACTIVITY_VALUE:%', key; end if;
    end if;
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x where jsonb_typeof(x) <> 'object')
     or exists (select 1 from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) x where jsonb_typeof(x) <> 'object')
     or exists (select 1 from jsonb_array_elements(coalesce(p_time_series, '[]'::jsonb)) x where jsonb_typeof(x) <> 'object') then
    raise exception 'INVALID_CHILD_OBJECT';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x where nullif(x->>'lap_index', '') is null or (x->>'lap_index')::integer < 1)
     or exists (select lap_index from (select (x->>'lap_index')::integer lap_index from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x) q group by lap_index having count(*) > 1) then
    raise exception 'INVALID_LAP_INDEX';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) x where nullif(x->>'km', '') is null or (x->>'km')::integer < 1)
     or exists (select km from (select (x->>'km')::integer km from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) x) q group by km having count(*) > 1) then
    raise exception 'INVALID_SPLIT_INDEX';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x where nullif(x->>'distance_meters', '') is not null and (x->>'distance_meters')::numeric < 0)
     or exists (select 1 from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) x where nullif(x->>'distance_meters', '') is not null and (x->>'distance_meters')::numeric < 0)
     or exists (select 1 from jsonb_array_elements(coalesce(p_time_series, '[]'::jsonb)) x where nullif(x->>'d', '') is not null and (x->>'d')::numeric < 0) then
    raise exception 'NEGATIVE_CHILD_DISTANCE';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x where coalesce(nullif(x->>'duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'moving_duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'avg_pace_sec_per_km', '')::numeric, 0) < 0)
     or exists (select 1 from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) x where coalesce(nullif(x->>'duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'elapsed_duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'timer_duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'pace_sec_per_km', '')::numeric, 0) < 0 or coalesce(nullif(x->>'elapsed_pace_sec_per_km', '')::numeric, 0) < 0)
     or exists (select 1 from jsonb_array_elements(coalesce(p_time_series, '[]'::jsonb)) x where coalesce(nullif(x->>'t', '')::numeric, 0) < 0 or coalesce(nullif(x->>'elapsed_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'timer_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'speed', '')::numeric, 0) < 0) then
    raise exception 'NEGATIVE_CHILD_VALUE';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) x where coalesce(nullif(x->>'elapsed_duration_seconds', '')::numeric, 0) < 0 or coalesce(nullif(x->>'elapsed_pace_sec_per_km', '')::numeric, 0) < 0) then
    raise exception 'NEGATIVE_CHILD_VALUE';
  end if;

  -- Serialize imports for one owner. This closes the legacy-tuple race while
  -- the partial unique indexes handle any cross-owner work independently.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 0));

  -- Hash and Garmin file identity are the authoritative idempotency keys.
  if source_hash_value is not null then
    select id into existing_id
     from public.activities
     where user_id = owner_id and source_hash = source_hash_value
     for update;
  end if;
  if existing_id is null and source_identity_value is not null then
    select id into existing_id
     from public.activities
     where user_id = owner_id and source_identity = source_identity_value
     for update;
  end if;
  -- Older rows predate source metadata. Match only the complete stable tuple,
  -- so an old exact re-import is idempotent without deduping a new workout.
  if existing_id is null then
    select count(*) into legacy_count
      from public.activities
     where user_id = owner_id
       and source_hash is null
       and source_identity is null
       and activity_date is not distinct from nullif(p_activity->>'activity_date', '')::date
       and filename is not distinct from p_activity->>'filename'
       and distance_meters is not distinct from nullif(p_activity->>'distance_meters', '')::numeric
       and duration_seconds is not distinct from nullif(p_activity->>'duration_seconds', '')::numeric
       and sport_raw is not distinct from p_activity->>'sport_raw'
      ;
    if legacy_count = 1 then
      select id into existing_id
        from public.activities
       where user_id = owner_id
         and source_hash is null
         and source_identity is null
         and activity_date is not distinct from nullif(p_activity->>'activity_date', '')::date
         and filename is not distinct from p_activity->>'filename'
         and distance_meters is not distinct from nullif(p_activity->>'distance_meters', '')::numeric
         and duration_seconds is not distinct from nullif(p_activity->>'duration_seconds', '')::numeric
         and sport_raw is not distinct from p_activity->>'sport_raw'
       for update;
    end if;
  end if;
  if legacy_count > 1 then
    return jsonb_build_object('status', 'review', 'inserted', false, 'reason', 'multiple_legacy_matches');
  end if;
  if existing_id is not null then
    if source_hash_value is not null then
      update public.activities set source_hash = coalesce(source_hash, source_hash_value) where id = existing_id and user_id = owner_id;
    end if;
    update public.activities set
      started_at = coalesce(started_at, nullif(p_activity->>'started_at', '')::timestamptz),
      subsport_raw = coalesce(subsport_raw, nullif(p_activity->>'subsport_raw', '')),
      elapsed_duration_seconds = coalesce(elapsed_duration_seconds, nullif(p_activity->>'elapsed_duration_seconds', '')::numeric),
      timer_duration_seconds = coalesce(timer_duration_seconds, nullif(p_activity->>'timer_duration_seconds', '')::numeric),
      timer_time_source = coalesce(timer_time_source, nullif(p_activity->>'timer_time_source', '')),
      source_identity = coalesce(source_identity, source_identity_value),
      hr_zone_seconds = coalesce(hr_zone_seconds, p_activity->'hr_zone_seconds'),
      hr_coverage_seconds = coalesce(hr_coverage_seconds, nullif(p_activity->>'hr_coverage_seconds', '')::numeric),
      hr_zone_config = coalesce(hr_zone_config, p_activity->'hr_zone_config')
     where id = existing_id and user_id = owner_id;
    imported_id := existing_id;
  end if;

  if imported_id is null then
  insert into public.activities (
    activity_date, activity_type, sport_raw, subsport_raw, distance_meters,
    duration_seconds, moving_time_seconds, avg_hr, max_hr, avg_cadence,
    avg_speed_ms, max_speed_ms, elevation_gain_meters, elevation_loss_meters,
    calories, avg_power, training_stress_score, filename, notes, started_at,
    elapsed_duration_seconds, timer_duration_seconds, timer_time_source,
    source_hash, source_identity, hr_zone_seconds, hr_coverage_seconds,
    hr_zone_config
  ) values (
    (p_activity->>'activity_date')::date,
    coalesce(nullif(p_activity->>'activity_type', ''), 'other'),
    nullif(p_activity->>'sport_raw', ''), nullif(p_activity->>'subsport_raw', ''),
    nullif(p_activity->>'distance_meters', '')::numeric,
    nullif(p_activity->>'duration_seconds', '')::numeric,
    nullif(p_activity->>'moving_time_seconds', '')::numeric,
    nullif(p_activity->>'avg_hr', '')::integer, nullif(p_activity->>'max_hr', '')::integer,
    nullif(p_activity->>'avg_cadence', '')::integer,
    nullif(p_activity->>'avg_speed_ms', '')::numeric, nullif(p_activity->>'max_speed_ms', '')::numeric,
    nullif(p_activity->>'elevation_gain_meters', '')::numeric, nullif(p_activity->>'elevation_loss_meters', '')::numeric,
    nullif(p_activity->>'calories', '')::integer, nullif(p_activity->>'avg_power', '')::integer,
    nullif(p_activity->>'training_stress_score', '')::numeric,
    nullif(p_activity->>'filename', ''), nullif(p_activity->>'notes', ''),
    nullif(p_activity->>'started_at', '')::timestamptz,
    nullif(p_activity->>'elapsed_duration_seconds', '')::numeric,
    nullif(p_activity->>'timer_duration_seconds', '')::numeric,
    nullif(p_activity->>'timer_time_source', ''), source_hash_value, source_identity_value,
    p_activity->'hr_zone_seconds', nullif(p_activity->>'hr_coverage_seconds', '')::numeric,
    p_activity->'hr_zone_config'
  ) returning id into imported_id;
  inserted_new := true;
  end if;

  select count(*) into child_count from public.laps l where l.activity_id = imported_id;
  if child_count = 0 and jsonb_array_length(coalesce(p_laps, '[]'::jsonb)) > 0 then
    upgraded := true;
  for item in select * from jsonb_array_elements(coalesce(p_laps, '[]'::jsonb)) loop
    insert into public.laps (
      activity_id, lap_index, start_time, distance_meters, duration_seconds,
      avg_hr, max_hr, avg_pace_sec_per_km, avg_cadence, elevation_gain,
      calories, lap_trigger, elapsed_duration_seconds, moving_duration_seconds,
      elapsed_pace_sec_per_km
    ) values (
      imported_id, nullif(item->>'lap_index', '')::integer, nullif(item->>'start_time', '')::timestamptz,
      nullif(item->>'distance_meters', '')::numeric, nullif(item->>'duration_seconds', '')::numeric,
      nullif(item->>'avg_hr', '')::integer, nullif(item->>'max_hr', '')::integer,
      nullif(item->>'avg_pace_sec_per_km', '')::numeric, nullif(item->>'avg_cadence', '')::integer,
      nullif(item->>'elevation_gain', '')::numeric, nullif(item->>'calories', '')::integer,
      nullif(item->>'lap_trigger', ''), nullif(item->>'elapsed_duration_seconds', '')::numeric,
      nullif(item->>'moving_duration_seconds', '')::numeric, nullif(item->>'elapsed_pace_sec_per_km', '')::numeric
    );
  end loop;
  end if;

  select count(*) into child_count from public.km_splits s where s.activity_id = imported_id;
  if child_count = 0 and jsonb_array_length(coalesce(p_km_splits, '[]'::jsonb)) > 0 then
    upgraded := true;
  for item in select * from jsonb_array_elements(coalesce(p_km_splits, '[]'::jsonb)) loop
    insert into public.km_splits (
      activity_id, km, distance_meters, duration_seconds, pace_sec_per_km,
      avg_hr, avg_cadence, elevation_gain, partial, elapsed_duration_seconds,
      timer_duration_seconds, elapsed_pace_sec_per_km
    ) values (
      imported_id, nullif(item->>'km', '')::integer, nullif(item->>'distance_meters', '')::numeric,
      nullif(item->>'duration_seconds', '')::numeric, nullif(item->>'pace_sec_per_km', '')::numeric,
      nullif(item->>'avg_hr', '')::integer, nullif(item->>'avg_cadence', '')::integer,
      nullif(item->>'elevation_gain', '')::numeric, coalesce((item->>'partial')::boolean, false),
      nullif(item->>'elapsed_duration_seconds', '')::numeric, nullif(item->>'timer_duration_seconds', '')::numeric,
      nullif(item->>'elapsed_pace_sec_per_km', '')::numeric
    );
  end loop;
  end if;

  select count(*) into child_count from public.time_series t where t.activity_id = imported_id;
  if child_count = 0 and jsonb_array_length(coalesce(p_time_series, '[]'::jsonb)) > 0 then
    upgraded := true;
  for item in select * from jsonb_array_elements(coalesce(p_time_series, '[]'::jsonb)) loop
    insert into public.time_series (activity_id, t, d, hr, alt, speed, cadence, elapsed_seconds, timer_seconds)
    values (
      imported_id, nullif(item->>'t', '')::numeric, nullif(item->>'d', '')::numeric,
      nullif(item->>'hr', '')::integer, nullif(item->>'alt', '')::numeric,
      nullif(item->>'speed', '')::numeric, nullif(item->>'cadence', '')::integer,
      nullif(item->>'elapsed_seconds', '')::numeric, nullif(item->>'timer_seconds', '')::numeric
    );
  end loop;
  end if;

  if inserted_new then
    return jsonb_build_object('status', 'inserted', 'inserted', true, 'activity_id', imported_id);
  end if;
  if upgraded or legacy_count = 1 then
    return jsonb_build_object('status', 'upgraded', 'inserted', false, 'upgraded', true, 'activity_id', imported_id);
  end if;
  return jsonb_build_object('status', 'duplicate', 'inserted', false, 'activity_id', imported_id);
exception when unique_violation then
  -- A concurrent identical import can win the partial unique index between
  -- the read and insert. Treat that race as an idempotent duplicate.
  if source_hash_value is not null then
    select id into existing_id from public.activities where user_id = owner_id and source_hash = source_hash_value limit 1;
  end if;
  if existing_id is null and source_identity_value is not null then
    select id into existing_id from public.activities where user_id = owner_id and source_identity = source_identity_value limit 1;
  end if;
  if existing_id is not null then
    return jsonb_build_object('status', 'duplicate', 'inserted', false, 'activity_id', existing_id, 'concurrent', true);
  end if;
  raise;
end;
$$;

revoke all on function public.import_activity_atomic(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.import_activity_atomic(jsonb, jsonb, jsonb, jsonb) to authenticated;

commit;
