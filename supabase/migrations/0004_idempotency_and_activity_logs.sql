-- TravelFlow Migration 0004: command idempotency and append-only activity logs

create table if not exists public.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  scope text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null default 'processing',
  response_body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  expires_at timestamptz,
  constraint idempotency_scope_not_blank check (length(trim(scope)) > 0),
  constraint idempotency_key_length check (length(idempotency_key) between 16 and 200),
  constraint idempotency_request_hash_not_blank check (length(trim(request_hash)) > 0),
  constraint idempotency_status_check check (status in ('processing', 'completed')),
  constraint idempotency_completed_at_check check (
    (status = 'processing' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
  )
);

create unique index if not exists idempotency_records_actor_scope_key_idx
  on public.idempotency_records (actor_user_id, scope, idempotency_key);

create index if not exists idempotency_records_expiry_idx
  on public.idempotency_records (expires_at)
  where expires_at is not null;

alter table public.idempotency_records enable row level security;
grant select, insert, update, delete on table public.idempotency_records to authenticated;

drop policy if exists idempotency_records_select_own on public.idempotency_records;
create policy idempotency_records_select_own
on public.idempotency_records for select
to authenticated
using (actor_user_id = (select auth.uid()));

drop policy if exists idempotency_records_insert_own on public.idempotency_records;
create policy idempotency_records_insert_own
on public.idempotency_records for insert
to authenticated
with check (actor_user_id = (select auth.uid()));

drop policy if exists idempotency_records_update_own on public.idempotency_records;
create policy idempotency_records_update_own
on public.idempotency_records for update
to authenticated
using (actor_user_id = (select auth.uid()))
with check (actor_user_id = (select auth.uid()));

drop policy if exists idempotency_records_delete_own on public.idempotency_records;
create policy idempotency_records_delete_own
on public.idempotency_records for delete
to authenticated
using (actor_user_id = (select auth.uid()));

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null,
  resource_type text not null,
  resource_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint activity_logs_action_not_blank check (length(trim(action)) > 0),
  constraint activity_logs_resource_type_not_blank check (length(trim(resource_type)) > 0),
  constraint activity_logs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists activity_logs_actor_created_idx
  on public.activity_logs (actor_user_id, created_at desc);

create index if not exists activity_logs_resource_created_idx
  on public.activity_logs (resource_type, resource_id, created_at desc);

alter table public.activity_logs enable row level security;
grant select, insert on table public.activity_logs to authenticated;

drop policy if exists activity_logs_select_own on public.activity_logs;
create policy activity_logs_select_own
on public.activity_logs for select
to authenticated
using (actor_user_id = (select auth.uid()));

drop policy if exists activity_logs_insert_own on public.activity_logs;
create policy activity_logs_insert_own
on public.activity_logs for insert
to authenticated
with check (actor_user_id = (select auth.uid()));

comment on table public.idempotency_records is 'User-scoped command replay records.';
comment on table public.activity_logs is 'Append-only audit events for domain mutations.';
