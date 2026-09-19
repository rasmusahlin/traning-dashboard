-- Atomic and idempotent FIT import for Träningsdashboard.
-- Apply after 001_owner_rls_auth.sql. This file is a local proposal until an
-- exact Supabase environment is separately authorized.

begin;

alter table public.activities
  add column if not exists source_hash text;

create unique index if not exists activities_user_source_hash_idx
  on public.activities(user_id, source_hash)
  where source_hash is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'activities_type_check' and conrelid = 'public.activities'::regclass) then
    alter table public.activities add constraint activities_type_check
      check (activity_type in ('running', 'strength', 'hiking')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'activities_values_check' and conrelid = 'public.activities'::regclass) then
    alter table public.activities add constraint activities_values_check check (
      (distance_meters is null or distance_meters >= 0) and
      (duration_seconds is null or duration_seconds > 0) and
      (moving_time_seconds is null or moving_time_seconds >= 0) and
      (avg_hr is null or avg_hr between 30 and 240) and
      (max_hr is null or max_hr between 30 and 240) and
      (avg_hr is null or max_hr is null or avg_hr <= max_hr) and
      (avg_cadence is null or avg_cadence between 1 and 300) and
      (elevation_gain_meters is null or elevation_gain_meters >= 0) and
      (elevation_loss_meters is null or elevation_loss_meters >= 0) and
      (source_hash is null or source_hash ~ '^[0-9a-f]{64}$')
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'laps_values_check' and conrelid = 'public.laps'::regclass) then
    alter table public.laps add constraint laps_values_check check (
      activity_id is not null and
      (lap_index is null or lap_index > 0) and
      (distance_meters is null or distance_meters >= 0) and
      (duration_seconds is null or duration_seconds > 0) and
      (avg_hr is null or avg_hr between 30 and 240) and
      (max_hr is null or max_hr between 30 and 240) and
      (avg_hr is null or max_hr is null or avg_hr <= max_hr)
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'km_splits_values_check' and conrelid = 'public.km_splits'::regclass) then
    alter table public.km_splits add constraint km_splits_values_check check (
      activity_id is not null and
      (km is null or km > 0) and
      (distance_meters is null or distance_meters >= 0) and
      (duration_seconds is null or duration_seconds > 0) and
      (pace_sec_per_km is null or pace_sec_per_km > 0) and
      (avg_hr is null or avg_hr between 30 and 240)
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'time_series_values_check' and conrelid = 'public.time_series'::regclass) then
    alter table public.time_series add constraint time_series_values_check check (
      activity_id is not null and
      (t is null or t >= 0) and
      (d is null or d >= 0) and
      (hr is null or hr between 30 and 240) and
      (speed is null or speed >= 0)
    ) not valid;
  end if;
end $$;

create or replace function public.import_activity_bundle(
  p_activity jsonb,
  p_laps jsonb default '[]'::jsonb,
  p_km_splits jsonb default '[]'::jsonb,
  p_time_series jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_activity_id uuid;
  v_source_hash text := lower(nullif(p_activity ->> 'source_hash', ''));
begin
  if v_user_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_activity) <> 'object' then
    raise exception 'p_activity must be an object.';
  end if;
  if jsonb_typeof(coalesce(p_laps, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_km_splits, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_time_series, '[]'::jsonb)) <> 'array' then
    raise exception 'Child payloads must be arrays.';
  end if;
  if jsonb_array_length(coalesce(p_laps, '[]'::jsonb)) > 5000
     or jsonb_array_length(coalesce(p_km_splits, '[]'::jsonb)) > 2000
     or jsonb_array_length(coalesce(p_time_series, '[]'::jsonb)) > 5000 then
    raise exception 'Import payload exceeds the row limit.';
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(coalesce(p_laps, '[]'::jsonb)) as row(lap_index integer)
     where row.lap_index is not null
     group by row.lap_index
    having count(*) > 1
  ) then
    raise exception 'Lap indices must be unique within an activity.';
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(coalesce(p_km_splits, '[]'::jsonb)) as row(km integer)
     where row.km is not null
     group by row.km
    having count(*) > 1
  ) then
    raise exception 'Kilometre indices must be unique within an activity.';
  end if;
  if v_source_hash is null or v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A valid SHA-256 source_hash is required.';
  end if;

  select id into v_activity_id
    from public.activities
   where user_id = v_user_id and source_hash = v_source_hash
   limit 1;
  if v_activity_id is not null then
    return jsonb_build_object('status', 'duplicate', 'activity_id', v_activity_id);
  end if;

  insert into public.activities (
    user_id, activity_date, activity_type, sport_raw, distance_meters,
    duration_seconds, moving_time_seconds, avg_hr, max_hr, avg_cadence,
    avg_speed_ms, max_speed_ms, elevation_gain_meters, elevation_loss_meters,
    calories, filename, source_hash, notes
  ) values (
    v_user_id,
    (p_activity ->> 'activity_date')::date,
    p_activity ->> 'activity_type',
    nullif(p_activity ->> 'sport_raw', ''),
    nullif(p_activity ->> 'distance_meters', '')::numeric,
    nullif(p_activity ->> 'duration_seconds', '')::numeric,
    nullif(p_activity ->> 'moving_time_seconds', '')::numeric,
    nullif(p_activity ->> 'avg_hr', '')::integer,
    nullif(p_activity ->> 'max_hr', '')::integer,
    nullif(p_activity ->> 'avg_cadence', '')::integer,
    nullif(p_activity ->> 'avg_speed_ms', '')::numeric,
    nullif(p_activity ->> 'max_speed_ms', '')::numeric,
    nullif(p_activity ->> 'elevation_gain_meters', '')::numeric,
    nullif(p_activity ->> 'elevation_loss_meters', '')::numeric,
    nullif(p_activity ->> 'calories', '')::integer,
    left(nullif(p_activity ->> 'filename', ''), 255),
    v_source_hash,
    left(nullif(p_activity ->> 'notes', ''), 2000)
  ) returning id into v_activity_id;

  insert into public.laps (
    activity_id, lap_index, start_time, distance_meters, duration_seconds,
    avg_hr, max_hr, avg_pace_sec_per_km, avg_cadence, elevation_gain,
    calories, lap_trigger
  )
  select v_activity_id, row.lap_index, row.start_time, row.distance_meters,
    row.duration_seconds, row.avg_hr, row.max_hr, row.avg_pace_sec_per_km,
    row.avg_cadence, row.elevation_gain, row.calories, left(row.lap_trigger, 80)
  from jsonb_to_recordset(coalesce(p_laps, '[]'::jsonb)) as row(
    lap_index integer, start_time timestamptz, distance_meters numeric,
    duration_seconds numeric, avg_hr integer, max_hr integer,
    avg_pace_sec_per_km numeric, avg_cadence integer, elevation_gain numeric,
    calories integer, lap_trigger text
  );

  insert into public.km_splits (
    activity_id, km, distance_meters, duration_seconds, pace_sec_per_km,
    avg_hr, avg_cadence, elevation_gain, partial
  )
  select v_activity_id, row.km, row.distance_meters, row.duration_seconds,
    row.pace_sec_per_km, row.avg_hr, row.avg_cadence, row.elevation_gain,
    coalesce(row.partial, false)
  from jsonb_to_recordset(coalesce(p_km_splits, '[]'::jsonb)) as row(
    km integer, distance_meters numeric, duration_seconds numeric,
    pace_sec_per_km numeric, avg_hr integer, avg_cadence integer,
    elevation_gain numeric, partial boolean
  );

  insert into public.time_series (activity_id, t, d, hr, alt, speed, cadence)
  select v_activity_id, row.t, row.d, row.hr, row.alt, row.speed, row.cadence
  from jsonb_to_recordset(coalesce(p_time_series, '[]'::jsonb)) as row(
    t numeric, d numeric, hr integer, alt numeric, speed numeric, cadence integer
  );

  return jsonb_build_object('status', 'inserted', 'activity_id', v_activity_id);
exception
  when unique_violation then
    select id into v_activity_id
      from public.activities
     where user_id = v_user_id and source_hash = v_source_hash
     limit 1;
    if v_activity_id is null then raise; end if;
    return jsonb_build_object('status', 'duplicate', 'activity_id', v_activity_id);
end;
$$;

revoke all on function public.import_activity_bundle(jsonb, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.import_activity_bundle(jsonb, jsonb, jsonb, jsonb) to authenticated;

commit;
