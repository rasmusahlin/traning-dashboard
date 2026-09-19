-- Optional additive migration for explicit Plan ↔ activity links and server
-- revisions.
-- Run manually in Supabase SQL Editor when activity matching is ready.
-- Apply after migrations 001–005. Existing plan logs remain valid; no data is
-- relinked automatically.

begin;

do $$
begin
  if to_regclass('public.training_plan_logs') is null then
    raise exception 'training_plan_logs saknas: kör 002_training_plan_logs.sql först';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'activities' and column_name = 'user_id'
  ) then
    raise exception 'activities.user_id saknas: kör 001_owner_rls_auth.sql först';
  end if;
end $$;

alter table public.training_plan_logs
  add column if not exists activity_id uuid references public.activities(id) on delete set null;

alter table public.training_plan_logs
  add column if not exists activity_link_status text not null default 'manual'
  check (activity_link_status in ('manual', 'proposed', 'confirmed'));

create unique index if not exists training_plan_logs_user_activity_unique
  on public.training_plan_logs(user_id, activity_id)
  where activity_id is not null;

-- A log may only point at an activity owned by the same authenticated user.
create or replace function public.ensure_training_plan_activity_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  activity_owner uuid;
begin
  if new.activity_id is not null then
    select a.user_id into activity_owner from public.activities a where a.id = new.activity_id;
    if activity_owner is distinct from new.user_id then
      raise exception 'training_plan_activity_owner_mismatch';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_plan_logs_activity_owner on public.training_plan_logs;
create trigger training_plan_logs_activity_owner
before insert or update of user_id, activity_id on public.training_plan_logs
for each row execute function public.ensure_training_plan_activity_owner();

-- Each successful write gets a new server revision, even if client clocks agree
-- or move backwards. Clients compare the full returned timestamp in PATCH filters.
create or replace function public.stamp_training_plan_log_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if TG_OP = 'UPDATE' then
    new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  else
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists training_plan_logs_server_revision on public.training_plan_logs;
create trigger training_plan_logs_server_revision
before insert or update on public.training_plan_logs
for each row execute function public.stamp_training_plan_log_update();

-- Keep the 004 RPC signature and stale-write behavior.  The trigger above
-- intentionally replaces client timestamps with a server revision, so the
-- comparison must happen before UPDATE/INSERT rather than in an ON CONFLICT
-- predicate that would see the trigger-adjusted EXCLUDED value.
create or replace function public.upsert_training_plan_log(p_log jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_existing_updated_at timestamptz;
  v_client_updated_at timestamptz;
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
  if nullif(p_log ->> 'updated_at', '') is null then
    raise exception 'updated_at is required.';
  end if;
  v_client_updated_at := (p_log ->> 'updated_at')::timestamptz;

  select id, updated_at
    into v_id, v_existing_updated_at
    from public.training_plan_logs
   where user_id = v_user_id
     and plan_block_id = p_log ->> 'plan_block_id'
     and plan_day_id = p_log ->> 'plan_day_id'
   for update;

  if v_id is not null and v_client_updated_at < v_existing_updated_at then
    return jsonb_build_object('status', 'ignored_stale');
  end if;

  if v_id is null then
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
      v_client_updated_at
    ) returning id, updated_at into v_id, v_updated_at;
  else
    update public.training_plan_logs
       set plan_date = (p_log ->> 'plan_date')::date,
           status = p_log ->> 'status',
           rpe = nullif(p_log ->> 'rpe', '')::integer,
           hip_pain = nullif(p_log ->> 'hip_pain', '')::integer,
           sleep_quality = nullif(p_log ->> 'sleep_quality', '')::integer,
           stress = nullif(p_log ->> 'stress', '')::integer,
           energy = nullif(p_log ->> 'energy', '')::integer,
           actual_distance_km = nullif(p_log ->> 'actual_distance_km', '')::numeric,
           actual_duration_minutes = nullif(p_log ->> 'actual_duration_minutes', '')::numeric,
           notes = nullif(p_log ->> 'notes', ''),
           updated_at = v_client_updated_at
     where id = v_id and user_id = v_user_id
     returning id, updated_at into v_id, v_updated_at;
  end if;

  return jsonb_build_object('status', 'accepted', 'updated_at', v_updated_at);
exception
  when unique_violation then
    -- Another writer may have inserted the same logical log after the first
    -- lookup.  Lock that row and apply the same stale check exactly once.
    select id, updated_at
      into v_id, v_existing_updated_at
      from public.training_plan_logs
     where user_id = v_user_id
       and plan_block_id = p_log ->> 'plan_block_id'
       and plan_day_id = p_log ->> 'plan_day_id'
     for update;
    if v_id is null or v_client_updated_at < v_existing_updated_at then
      return jsonb_build_object('status', 'ignored_stale');
    end if;
    update public.training_plan_logs
       set plan_date = (p_log ->> 'plan_date')::date,
           status = p_log ->> 'status',
           rpe = nullif(p_log ->> 'rpe', '')::integer,
           hip_pain = nullif(p_log ->> 'hip_pain', '')::integer,
           sleep_quality = nullif(p_log ->> 'sleep_quality', '')::integer,
           stress = nullif(p_log ->> 'stress', '')::integer,
           energy = nullif(p_log ->> 'energy', '')::integer,
           actual_distance_km = nullif(p_log ->> 'actual_distance_km', '')::numeric,
           actual_duration_minutes = nullif(p_log ->> 'actual_duration_minutes', '')::numeric,
           notes = nullif(p_log ->> 'notes', ''),
           updated_at = v_client_updated_at
     where id = v_id and user_id = v_user_id
     returning updated_at into v_updated_at;
    return jsonb_build_object('status', 'accepted', 'updated_at', v_updated_at);
end;
$$;

revoke all on function public.upsert_training_plan_log(jsonb) from public, anon;
grant execute on function public.upsert_training_plan_log(jsonb) to authenticated;

commit;
