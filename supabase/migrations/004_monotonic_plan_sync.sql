-- Monotonic plan-log upsert.
-- Prevents an older tab or delayed request from overwriting a newer check-in.
-- Apply after 002_training_plan_logs.sql.

begin;

alter table public.training_plan_logs
  drop constraint if exists training_plan_logs_values_check;

alter table public.training_plan_logs
  add constraint training_plan_logs_values_check check (
    (actual_distance_km is null or actual_distance_km between 0 and 1000) and
    (actual_duration_minutes is null or actual_duration_minutes between 0 and 10080) and
    (notes is null or char_length(notes) <= 4000)
  ) not valid;

create or replace function public.upsert_training_plan_log(p_log jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_updated_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Authentication required.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_log) <> 'object' then
    raise exception 'p_log must be an object.';
  end if;
  if nullif(p_log ->> 'plan_block_id', '') is null
     or char_length(p_log ->> 'plan_block_id') > 200
     or nullif(p_log ->> 'plan_day_id', '') is null
     or char_length(p_log ->> 'plan_day_id') > 200 then
    raise exception 'Invalid plan identifiers.';
  end if;
  if (p_log ->> 'status') not in ('planned', 'completed', 'scaled_down', 'skipped') then
    raise exception 'Invalid plan status.';
  end if;
  if char_length(coalesce(p_log ->> 'notes', '')) > 4000 then
    raise exception 'Plan notes are too long.';
  end if;

  v_updated_at := (p_log ->> 'updated_at')::timestamptz;

  insert into public.training_plan_logs (
    user_id, plan_block_id, plan_day_id, plan_date, status, rpe, hip_pain,
    sleep_quality, stress, energy, actual_distance_km,
    actual_duration_minutes, notes, updated_at
  ) values (
    v_user_id,
    p_log ->> 'plan_block_id',
    p_log ->> 'plan_day_id',
    (p_log ->> 'plan_date')::date,
    p_log ->> 'status',
    nullif(p_log ->> 'rpe', '')::integer,
    nullif(p_log ->> 'hip_pain', '')::integer,
    nullif(p_log ->> 'sleep_quality', '')::integer,
    nullif(p_log ->> 'stress', '')::integer,
    nullif(p_log ->> 'energy', '')::integer,
    nullif(p_log ->> 'actual_distance_km', '')::numeric,
    nullif(p_log ->> 'actual_duration_minutes', '')::numeric,
    nullif(p_log ->> 'notes', ''),
    v_updated_at
  )
  on conflict (user_id, plan_block_id, plan_day_id) do update set
    plan_date = excluded.plan_date,
    status = excluded.status,
    rpe = excluded.rpe,
    hip_pain = excluded.hip_pain,
    sleep_quality = excluded.sleep_quality,
    stress = excluded.stress,
    energy = excluded.energy,
    actual_distance_km = excluded.actual_distance_km,
    actual_duration_minutes = excluded.actual_duration_minutes,
    notes = excluded.notes,
    updated_at = excluded.updated_at
  where excluded.updated_at >= public.training_plan_logs.updated_at
  returning id, updated_at into v_id, v_updated_at;

  if v_id is null then
    return jsonb_build_object('status', 'ignored_stale');
  end if;
  return jsonb_build_object('status', 'accepted', 'updated_at', v_updated_at);
end;
$$;

revoke all on function public.upsert_training_plan_log(jsonb) from public, anon;
grant execute on function public.upsert_training_plan_log(jsonb) to authenticated;

commit;
