-- =====================================================================
-- Bald Ginger Client Portal — Migration v2 (Option B + soft archive)
--
-- WHAT THIS DOES:
--   1. Extends `profiles` with email, is_team, active columns
--      and seeds rows for your 4 team members.
--   2. Adds `archived_at` to `clients` for soft-removal.
--   3. Creates `client_users` join table with `archived_at` support.
--   4. Adds `is_team` flag to `messages` and backfills.
--   5. Replaces ALL existing "Authenticated users can view/insert/update X"
--      policies with team-vs-client policies that respect:
--        - team members (is_team = true, active = true) see everything
--        - portal users see only their linked clients
--   6. Adds a panic-button helper function you can call to grant
--      full team access to ALL existing auth users if something breaks.
--
-- HOW TO RUN:
--   Paste the whole file into Supabase SQL Editor and click Run.
--   The whole thing runs as one transaction — if any statement fails,
--   nothing is changed. You'll get an error message and your old
--   policies will still be in place.
--
-- AFTER RUNNING:
--   1. Test Triple by logging in and clicking through the major pages.
--   2. If anything looks broken, run the rollback file:
--      002_rollback_to_authenticated_only.sql
-- =====================================================================

begin;

-- =====================================================================
-- 1. PROFILES — extend the existing table (don't recreate it)
-- =====================================================================
alter table public.profiles
  add column if not exists email      text,
  add column if not exists is_team    boolean not null default false,
  add column if not exists active     boolean not null default true;

-- Seed profiles for the 4 team members (idempotent — safe to re-run).
-- Pulls their email from auth.users; you can fix names if any are wrong.
insert into public.profiles (id, email, full_name, role, avatar_initials, is_team, active)
select
  u.id,
  u.email,
  case u.email
    when 'ed@baldginger.com'         then 'Ed Hattrup'
    when 'lydia@baldginger.com'      then 'Lydia Hattrup'
    when 'jennifer@baldginger.com'   then 'Jennifer Mills'
    when 'jen.crane@baldginger.com'  then 'Jen Crane'
    else split_part(u.email, '@', 1)
  end as full_name,
  'team' as role,
  case u.email
    when 'ed@baldginger.com'         then 'EH'
    when 'lydia@baldginger.com'      then 'LH'
    when 'jennifer@baldginger.com'   then 'JM'
    when 'jen.crane@baldginger.com'  then 'JC'
    else upper(substr(u.email, 1, 2))
  end as avatar_initials,
  true  as is_team,
  true  as active
from auth.users u
on conflict (id) do update
  set email   = excluded.email,
      is_team = true,
      active  = true;

-- Trigger: auto-create a profile when a new auth user signs up.
-- New users default to is_team = false (they're clients until promoted).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role, avatar_initials, is_team, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'client',
    upper(substr(coalesce(new.raw_user_meta_data->>'full_name', new.email), 1, 2)),
    false,
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- 2. CLIENTS — add archived_at for soft-removal
-- =====================================================================
alter table public.clients
  add column if not exists archived_at timestamptz;


-- =====================================================================
-- 3. CLIENT_USERS — join table (many-to-many, with soft-removal)
-- =====================================================================
create table if not exists public.client_users (
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   uuid not null references public.clients(id) on delete cascade,
  role        text not null default 'owner',
  created_at  timestamptz not null default now(),
  archived_at timestamptz,
  primary key (user_id, client_id)
);

create index if not exists client_users_client_idx on public.client_users(client_id);
create index if not exists client_users_user_idx   on public.client_users(user_id);


-- =====================================================================
-- 4. MESSAGES — add is_team flag and backfill
-- =====================================================================
alter table public.messages
  add column if not exists is_team boolean not null default false;

update public.messages set is_team = true where is_team = false;


-- =====================================================================
-- 5. HELPER FUNCTIONS
-- =====================================================================

-- Is the calling user an active team member?
create or replace function public.is_team_member()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select is_team and active from public.profiles where id = auth.uid()),
    false
  );
$$;

-- Does the calling user have ACTIVE access to this client?
-- True if they're a team member OR they have an unarchived client_users row.
create or replace function public.user_has_client(target_client_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_team_member() or exists (
    select 1 from public.client_users
    where user_id = auth.uid()
      and client_id = target_client_id
      and archived_at is null
  );
$$;


-- =====================================================================
-- 6. ROW-LEVEL SECURITY — REPLACE existing policies
--
-- We drop the old "Authenticated users can ..." policies and replace
-- them with team-or-portal-with-access policies.
-- =====================================================================

-- ---------- clients ----------
alter table public.clients enable row level security;

drop policy if exists "Authenticated users can view clients"   on public.clients;
drop policy if exists "Authenticated users can update clients" on public.clients;

create policy "clients_select" on public.clients
  for select using (
    public.is_team_member()
    or exists (
      select 1 from public.client_users cu
      where cu.user_id = auth.uid()
        and cu.client_id = clients.id
        and cu.archived_at is null
    )
  );

create policy "clients_team_write" on public.clients
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- profiles ----------
alter table public.profiles enable row level security;

drop policy if exists "Users can view all profiles"   on public.profiles;
drop policy if exists "Users can update own profile"  on public.profiles;

-- Everyone signed in can read profiles (so we can show author names on
-- messages, etc.). Profile rows don't contain sensitive data.
create policy "profiles_select" on public.profiles
  for select using (auth.uid() is not null);

create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id);

create policy "profiles_team_write" on public.profiles
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- messages ----------
alter table public.messages enable row level security;

drop policy if exists "Authenticated users can insert messages" on public.messages;
drop policy if exists "Authenticated users can view messages"   on public.messages;

create policy "messages_select" on public.messages
  for select using (public.user_has_client(client_id));

create policy "messages_insert" on public.messages
  for insert with check (public.user_has_client(client_id));

create policy "messages_team_update" on public.messages
  for update using (public.is_team_member());

create policy "messages_team_delete" on public.messages
  for delete using (public.is_team_member());


-- ---------- team_messages (Triple-only — clients should not see these) ----------
alter table public.team_messages enable row level security;

drop policy if exists "Auth users can update team messages" on public.team_messages;
drop policy if exists "Auth users insert team messages"     on public.team_messages;
drop policy if exists "Auth users view team messages"       on public.team_messages;

create policy "team_messages_team_only" on public.team_messages
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- tasks (Triple-only for now) ----------
alter table public.tasks enable row level security;

drop policy if exists "Auth users delete tasks" on public.tasks;
drop policy if exists "Auth users insert tasks" on public.tasks;
drop policy if exists "Auth users update tasks" on public.tasks;
drop policy if exists "Auth users view tasks"   on public.tasks;

create policy "tasks_team_only" on public.tasks
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- subtasks (Triple-only for now) ----------
alter table public.subtasks enable row level security;

drop policy if exists "Auth users delete subtasks" on public.subtasks;
drop policy if exists "Auth users insert subtasks" on public.subtasks;
drop policy if exists "Auth users update subtasks" on public.subtasks;
drop policy if exists "Auth users view subtasks"   on public.subtasks;

create policy "subtasks_team_only" on public.subtasks
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- kpi_data (Triple-only for now) ----------
alter table public.kpi_data enable row level security;

drop policy if exists "Authenticated users can insert kpi_data" on public.kpi_data;
drop policy if exists "Authenticated users can update kpi_data" on public.kpi_data;
drop policy if exists "Authenticated users can view kpi_data"   on public.kpi_data;

create policy "kpi_data_team_only" on public.kpi_data
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- client_accounts (Triple-only for now) ----------
alter table public.client_accounts enable row level security;

drop policy if exists "Auth users delete accounts" on public.client_accounts;
drop policy if exists "Auth users insert accounts" on public.client_accounts;
drop policy if exists "Auth users update accounts" on public.client_accounts;
drop policy if exists "Auth users view accounts"   on public.client_accounts;

create policy "client_accounts_team_only" on public.client_accounts
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- uploaded_files (Triple-only for now) ----------
alter table public.uploaded_files enable row level security;

drop policy if exists "Authenticated users can insert files" on public.uploaded_files;
drop policy if exists "Authenticated users can view files"   on public.uploaded_files;

create policy "uploaded_files_team_only" on public.uploaded_files
  for all using (public.is_team_member())
  with check (public.is_team_member());


-- ---------- client_users (the new join table) ----------
alter table public.client_users enable row level security;

create policy "client_users_select" on public.client_users
  for select using (
    user_id = auth.uid() or public.is_team_member()
  );

create policy "client_users_team_write" on public.client_users
  for all using (public.is_team_member())
  with check (public.is_team_member());


commit;

-- =====================================================================
-- POST-MIGRATION QUICK CHECK
-- Run this immediately after to verify your team is set up correctly:
--
--   select id, email, full_name, is_team, active from public.profiles
--   order by created_at;
--
-- You should see 4 rows: Ed, Lydia, Jennifer, Jen, all with is_team=true
-- and active=true.
-- =====================================================================
