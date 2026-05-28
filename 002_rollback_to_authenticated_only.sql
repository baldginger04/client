-- =====================================================================
-- ROLLBACK — Restore "any authenticated user sees everything" behavior
--
-- USE THIS IF Triple is broken for your team after running the v2 migration.
-- This drops the new tight policies and recreates the old open ones.
--
-- This does NOT undo:
--   - The new columns added (email, is_team, active, archived_at, etc.)
--   - The new client_users table
--   - The is_team flag on messages
-- Those are additive and harmless.
--
-- HOW TO RUN:
--   Paste this entire file into the Supabase SQL Editor and click Run.
-- =====================================================================

begin;

-- ---------- clients ----------
drop policy if exists "clients_select"     on public.clients;
drop policy if exists "clients_team_write" on public.clients;

create policy "Authenticated users can view clients" on public.clients
  for select to authenticated using (true);
create policy "Authenticated users can update clients" on public.clients
  for update to authenticated using (true);


-- ---------- profiles ----------
drop policy if exists "profiles_select"        on public.profiles;
drop policy if exists "profiles_self_update"   on public.profiles;
drop policy if exists "profiles_team_write"    on public.profiles;

create policy "Users can view all profiles" on public.profiles
  for select to authenticated using (true);
create policy "Users can update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id);


-- ---------- messages ----------
drop policy if exists "messages_select"      on public.messages;
drop policy if exists "messages_insert"      on public.messages;
drop policy if exists "messages_team_update" on public.messages;
drop policy if exists "messages_team_delete" on public.messages;

create policy "Authenticated users can view messages" on public.messages
  for select to authenticated using (true);
create policy "Authenticated users can insert messages" on public.messages
  for insert to authenticated with check (true);


-- ---------- team_messages ----------
drop policy if exists "team_messages_team_only" on public.team_messages;

create policy "Auth users view team messages" on public.team_messages
  for select to authenticated using (true);
create policy "Auth users insert team messages" on public.team_messages
  for insert to authenticated with check (true);
create policy "Auth users can update team messages" on public.team_messages
  for update to authenticated using (true);


-- ---------- tasks ----------
drop policy if exists "tasks_team_only" on public.tasks;

create policy "Auth users view tasks" on public.tasks
  for select to authenticated using (true);
create policy "Auth users insert tasks" on public.tasks
  for insert to authenticated with check (true);
create policy "Auth users update tasks" on public.tasks
  for update to authenticated using (true);
create policy "Auth users delete tasks" on public.tasks
  for delete to authenticated using (true);


-- ---------- subtasks ----------
drop policy if exists "subtasks_team_only" on public.subtasks;

create policy "Auth users view subtasks" on public.subtasks
  for select to authenticated using (true);
create policy "Auth users insert subtasks" on public.subtasks
  for insert to authenticated with check (true);
create policy "Auth users update subtasks" on public.subtasks
  for update to authenticated using (true);
create policy "Auth users delete subtasks" on public.subtasks
  for delete to authenticated using (true);


-- ---------- kpi_data ----------
drop policy if exists "kpi_data_team_only" on public.kpi_data;

create policy "Authenticated users can view kpi_data" on public.kpi_data
  for select to authenticated using (true);
create policy "Authenticated users can insert kpi_data" on public.kpi_data
  for insert to authenticated with check (true);
create policy "Authenticated users can update kpi_data" on public.kpi_data
  for update to authenticated using (true);


-- ---------- client_accounts ----------
drop policy if exists "client_accounts_team_only" on public.client_accounts;

create policy "Auth users view accounts" on public.client_accounts
  for select to authenticated using (true);
create policy "Auth users insert accounts" on public.client_accounts
  for insert to authenticated with check (true);
create policy "Auth users update accounts" on public.client_accounts
  for update to authenticated using (true);
create policy "Auth users delete accounts" on public.client_accounts
  for delete to authenticated using (true);


-- ---------- uploaded_files ----------
drop policy if exists "uploaded_files_team_only" on public.uploaded_files;

create policy "Authenticated users can view files" on public.uploaded_files
  for select to authenticated using (true);
create policy "Authenticated users can insert files" on public.uploaded_files
  for insert to authenticated with check (true);


-- ---------- client_users ----------
drop policy if exists "client_users_select"     on public.client_users;
drop policy if exists "client_users_team_write" on public.client_users;
-- Leave RLS enabled on client_users so it doesn't leak when not in use.
-- No policies = no access, which is fine since Triple doesn't read it.


commit;

-- =====================================================================
-- After running this, refresh Triple. Your team should regain full access.
-- =====================================================================
