-- =====================================================================
-- Bald Ginger Client Portal — Phase 1 Migration: Financials
-- Run this in Supabase SQL Editor (Database → SQL Editor → New query).
-- Safe to run multiple times; uses IF NOT EXISTS / DROP IF EXISTS.
--
-- What this adds:
--   1. files table   — metadata for every uploaded file (P&L, Prime Sheet, etc.)
--   2. RLS policies  — clients see only files for clients they have access to;
--                      team can do everything
--   3. Storage bucket 'financials' with matching RLS
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. files table
-- ---------------------------------------------------------------------
create table if not exists public.files (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  storage_path  text not null,                  -- 'financials/<client_id>/<filename>'
  filename      text not null,                  -- original filename for display
  file_type     text not null check (file_type in (
                    'pl', 'pl_detail', 'prime_sheet', 'balance_sheet', 'other'
                )),
  period        text not null,                  -- 'YYYY-MM' (e.g. '2026-04')
  size_bytes    bigint,
  mime_type     text,
  is_archived   boolean not null default false,
  uploaded_by   uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Indexes for the queries the UI will run
create index if not exists files_client_period_idx
  on public.files (client_id, period desc);
create index if not exists files_client_archived_idx
  on public.files (client_id, is_archived, created_at desc);
create index if not exists files_client_type_idx
  on public.files (client_id, file_type, period desc);

alter table public.files enable row level security;

-- ---------------------------------------------------------------------
-- 2. RLS on files table
-- ---------------------------------------------------------------------
-- Drop existing policies if re-running
drop policy if exists "files_select"   on public.files;
drop policy if exists "files_insert"   on public.files;
drop policy if exists "files_update"   on public.files;
drop policy if exists "files_delete"   on public.files;

-- SELECT: team sees all; clients see files only for their linked clients
create policy "files_select"
on public.files
for select
using (
  -- team
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
  -- OR client has access to this client_id
  or exists (
    select 1 from public.client_users cu
    where cu.user_id = auth.uid() and cu.client_id = public.files.client_id
  )
);

-- INSERT: team only (Ed uploads)
create policy "files_insert"
on public.files
for insert
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);

-- UPDATE: team only (used by "Close month" / archive toggle, future rename, etc.)
create policy "files_update"
on public.files
for update
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);

-- DELETE: team only
create policy "files_delete"
on public.files
for delete
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);


-- ---------------------------------------------------------------------
-- 3. Storage bucket: financials
--    NOTE: Buckets are created via the Supabase Dashboard UI (Storage →
--    New bucket → name 'financials', set to PRIVATE — NOT public).
--    The SQL below sets the RLS policies that gate access AFTER you've
--    created the bucket in the dashboard.
--
--    Folder layout: financials/<client_id>/<filename>
-- ---------------------------------------------------------------------

-- Drop existing storage policies if re-running
drop policy if exists "financials_select" on storage.objects;
drop policy if exists "financials_insert" on storage.objects;
drop policy if exists "financials_update" on storage.objects;
drop policy if exists "financials_delete" on storage.objects;

-- SELECT (download): team OR client has access to that client_id folder
create policy "financials_select"
on storage.objects
for select
using (
  bucket_id = 'financials'
  and (
    -- team
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_team = true
    )
    -- OR the second path segment (client_id) is one the user has access to
    or exists (
      select 1 from public.client_users cu
      where cu.user_id = auth.uid()
        and cu.client_id::text = (storage.foldername(name))[1]
    )
  )
);

-- INSERT (upload): team only
create policy "financials_insert"
on storage.objects
for insert
with check (
  bucket_id = 'financials'
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);

-- UPDATE: team only
create policy "financials_update"
on storage.objects
for update
using (
  bucket_id = 'financials'
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);

-- DELETE: team only
create policy "financials_delete"
on storage.objects
for delete
using (
  bucket_id = 'financials'
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_team = true
  )
);
