-- Optional training plan log table for the Plan page.
-- Run manually in Supabase SQL Editor only when you want cloud sync.

begin;

create table if not exists public.training_plan_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plan_block_id text not null,
  plan_day_id text not null,
  plan_date date not null,
  status text not null default 'planned'
    check (status in ('planned', 'completed', 'scaled_down', 'skipped')),
  rpe integer check (rpe between 1 and 10),
  hip_pain integer check (hip_pain between 0 and 10),
  sleep_quality integer check (sleep_quality between 1 and 5),
  stress integer check (stress between 1 and 5),
  energy integer check (energy between 1 and 5),
  actual_distance_km numeric,
  actual_duration_minutes numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'training_plan_logs_user_block_day_key'
  ) then
    alter table public.training_plan_logs
      add constraint training_plan_logs_user_block_day_key
      unique (user_id, plan_block_id, plan_day_id);
  end if;
end $$;

create index if not exists idx_training_plan_logs_user_date
  on public.training_plan_logs(user_id, plan_date desc);

alter table public.training_plan_logs enable row level security;

grant select, insert, update, delete on table public.training_plan_logs to authenticated;

drop policy if exists "training_plan_logs_select_own" on public.training_plan_logs;
drop policy if exists "training_plan_logs_insert_own" on public.training_plan_logs;
drop policy if exists "training_plan_logs_update_own" on public.training_plan_logs;
drop policy if exists "training_plan_logs_delete_own" on public.training_plan_logs;

create policy "training_plan_logs_select_own"
  on public.training_plan_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "training_plan_logs_insert_own"
  on public.training_plan_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "training_plan_logs_update_own"
  on public.training_plan_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "training_plan_logs_delete_own"
  on public.training_plan_logs
  for delete
  to authenticated
  using (user_id = auth.uid());

commit;
