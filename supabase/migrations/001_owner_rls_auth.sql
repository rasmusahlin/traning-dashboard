-- Security migration proposal for Träningsdashboard.
--
-- Goal:
--   Move the public GitHub Pages app from anonymous database access to
--   Supabase Auth + row level security (RLS), where one signed-in owner can
--   read/write their own training data.
--
-- Before running:
--   1. In Supabase, create or invite the user account that should own the data.
--   2. Confirm that the email below matches that account.
--   3. Run this in Supabase SQL Editor.
--   4. Update the frontend to sign in with Supabase Auth before enabling this
--      on the live site. Without Auth UI, the current app will no longer see
--      or write rows after RLS is enabled.

begin;

do $$
declare
  owner_id uuid;
begin
  select id
    into owner_id
    from auth.users
   where lower(email) = lower('rasmus.ahlin@gmail.com')
   limit 1;

  if owner_id is null then
    raise exception 'No Supabase Auth user found for the configured owner email. Create the user first, then rerun.';
  end if;

  -- Add an owner column to root tables that hold user-created data.
  alter table public.activities
    add column if not exists user_id uuid references auth.users(id) on delete cascade;

  alter table public.nutrition_logs
    add column if not exists user_id uuid references auth.users(id) on delete cascade;

  -- Backfill existing single-user data to the chosen owner.
  update public.activities
     set user_id = owner_id
   where user_id is null;

  update public.nutrition_logs
     set user_id = owner_id
   where user_id is null;

  -- After backfill, enforce ownership for future root rows.
  -- auth.uid() is populated by Supabase for authenticated REST requests.
  alter table public.activities
    alter column user_id set default auth.uid();

  alter table public.nutrition_logs
    alter column user_id set default auth.uid();

  alter table public.activities
    alter column user_id set not null;

  alter table public.nutrition_logs
    alter column user_id set not null;
end $$;

-- Existing nutrition_logs has a global unique date in schema.sql. For RLS,
-- uniqueness should be per user so more than one account can exist later.
alter table public.nutrition_logs
  drop constraint if exists nutrition_logs_log_date_key;

create unique index if not exists nutrition_logs_user_log_date_idx
  on public.nutrition_logs(user_id, log_date);

create index if not exists idx_activities_user_date
  on public.activities(user_id, activity_date desc);

create index if not exists idx_nutrition_logs_user_date
  on public.nutrition_logs(user_id, log_date desc);

-- Enable RLS on all app tables.
alter table public.activities enable row level security;
alter table public.laps enable row level security;
alter table public.km_splits enable row level security;
alter table public.time_series enable row level security;
alter table public.nutrition_logs enable row level security;

-- Remove anonymous direct table access. The anon key may remain in the
-- frontend for Auth bootstrap, but table access should require an
-- authenticated user and matching RLS policy.
revoke all on table public.activities from public;
revoke all on table public.laps from public;
revoke all on table public.km_splits from public;
revoke all on table public.time_series from public;
revoke all on table public.nutrition_logs from public;

revoke all on table public.activities from anon;
revoke all on table public.laps from anon;
revoke all on table public.km_splits from anon;
revoke all on table public.time_series from anon;
revoke all on table public.nutrition_logs from anon;

grant select, insert, update, delete on table public.activities to authenticated;
grant select, insert, update, delete on table public.laps to authenticated;
grant select, insert, update, delete on table public.km_splits to authenticated;
grant select, insert, update, delete on table public.time_series to authenticated;
grant select, insert, update, delete on table public.nutrition_logs to authenticated;

-- Replace policies idempotently so the migration can be rerun during setup.
drop policy if exists "activities_select_own" on public.activities;
drop policy if exists "activities_insert_own" on public.activities;
drop policy if exists "activities_update_own" on public.activities;
drop policy if exists "activities_delete_own" on public.activities;

create policy "activities_select_own"
  on public.activities
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "activities_insert_own"
  on public.activities
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "activities_update_own"
  on public.activities
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "activities_delete_own"
  on public.activities
  for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "laps_select_own_activity" on public.laps;
drop policy if exists "laps_insert_own_activity" on public.laps;
drop policy if exists "laps_update_own_activity" on public.laps;
drop policy if exists "laps_delete_own_activity" on public.laps;

create policy "laps_select_own_activity"
  on public.laps
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = laps.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "laps_insert_own_activity"
  on public.laps
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = laps.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "laps_update_own_activity"
  on public.laps
  for update
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = laps.activity_id
         and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = laps.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "laps_delete_own_activity"
  on public.laps
  for delete
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = laps.activity_id
         and a.user_id = auth.uid()
    )
  );

drop policy if exists "km_splits_select_own_activity" on public.km_splits;
drop policy if exists "km_splits_insert_own_activity" on public.km_splits;
drop policy if exists "km_splits_update_own_activity" on public.km_splits;
drop policy if exists "km_splits_delete_own_activity" on public.km_splits;

create policy "km_splits_select_own_activity"
  on public.km_splits
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = km_splits.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "km_splits_insert_own_activity"
  on public.km_splits
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = km_splits.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "km_splits_update_own_activity"
  on public.km_splits
  for update
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = km_splits.activity_id
         and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = km_splits.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "km_splits_delete_own_activity"
  on public.km_splits
  for delete
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = km_splits.activity_id
         and a.user_id = auth.uid()
    )
  );

drop policy if exists "time_series_select_own_activity" on public.time_series;
drop policy if exists "time_series_insert_own_activity" on public.time_series;
drop policy if exists "time_series_update_own_activity" on public.time_series;
drop policy if exists "time_series_delete_own_activity" on public.time_series;

create policy "time_series_select_own_activity"
  on public.time_series
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = time_series.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "time_series_insert_own_activity"
  on public.time_series
  for insert
  to authenticated
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = time_series.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "time_series_update_own_activity"
  on public.time_series
  for update
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = time_series.activity_id
         and a.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1
        from public.activities a
       where a.id = time_series.activity_id
         and a.user_id = auth.uid()
    )
  );

create policy "time_series_delete_own_activity"
  on public.time_series
  for delete
  to authenticated
  using (
    exists (
      select 1
        from public.activities a
       where a.id = time_series.activity_id
         and a.user_id = auth.uid()
    )
  );

drop policy if exists "nutrition_logs_select_own" on public.nutrition_logs;
drop policy if exists "nutrition_logs_insert_own" on public.nutrition_logs;
drop policy if exists "nutrition_logs_update_own" on public.nutrition_logs;
drop policy if exists "nutrition_logs_delete_own" on public.nutrition_logs;

create policy "nutrition_logs_select_own"
  on public.nutrition_logs
  for select
  to authenticated
  using (user_id = auth.uid());

create policy "nutrition_logs_insert_own"
  on public.nutrition_logs
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "nutrition_logs_update_own"
  on public.nutrition_logs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "nutrition_logs_delete_own"
  on public.nutrition_logs
  for delete
  to authenticated
  using (user_id = auth.uid());

commit;
