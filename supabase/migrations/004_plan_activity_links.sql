-- Optional additive migration for explicit Plan ↔ activity links.
-- Run manually in Supabase SQL Editor when activity matching is ready.
-- Existing plan logs remain valid; no data is relinked automatically.

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

commit;
