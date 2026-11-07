-- TravelFlow Migration 0009: background jobs and in-app alerts (Task 10)
--
-- Decisions
-- * A job runs once. `attempts` can never exceed 1 and a finished job never goes
--   back to `queued`, so nothing in the database can retry a job. A manual rerun
--   is a new row whose `parent_job_id` points at the failed or interrupted job.
-- * Jobs are claimed with `FOR UPDATE SKIP LOCKED` and a lease. A worker that stops
--   renewing its lease is marked `interrupted`; it is never completed on its behalf.
-- * Users can read the jobs and alerts of their own trips. They cannot insert a job
--   or an alert. They can only move an alert to read or dismissed, and the server
--   sets those timestamps.
-- * Alert evidence points at rows of the shared `sources` table (`source_ids`). This
--   migration does not change `source_references.entity_type`.
-- * `service_role` has no default table privileges in this project, so the privileges
--   the worker needs on earlier tables are granted at the end of this file.

-- ---------------------------------------------------------------------------
-- background_jobs
create table if not exists public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  job_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  idempotency_key text not null,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  parent_job_id uuid,
  correlation_id text not null,
  execution_id uuid,
  created_by uuid references auth.users(id) on delete restrict,
  result_summary jsonb,
  error_code text,
  error_message text,
  provider_request_ids jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint background_jobs_type_check check (job_type in (
    'refresh_weather',
    'refresh_traffic',
    'evaluate_alerts',
    'departure_reminder'
  )),
  constraint background_jobs_status_check check (status in (
    'queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'
  )),
  constraint background_jobs_idempotency_key_length check (char_length(idempotency_key) between 16 and 400),
  constraint background_jobs_correlation_length check (char_length(correlation_id) between 1 and 200),
  constraint background_jobs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint background_jobs_result_object check (result_summary is null or jsonb_typeof(result_summary) = 'object'),
  constraint background_jobs_provider_ids_array check (jsonb_typeof(provider_request_ids) = 'array'),
  -- One execution per job, ever.
  constraint background_jobs_single_attempt check (attempts between 0 and 1),
  constraint background_jobs_queued_shape check (
    status <> 'queued'
    or (attempts = 0 and lease_owner is null and lease_expires_at is null and heartbeat_at is null
        and execution_id is null and started_at is null and completed_at is null)
  ),
  constraint background_jobs_running_shape check (
    status <> 'running'
    or (attempts = 1 and lease_owner is not null and lease_expires_at is not null
        and heartbeat_at is not null and execution_id is not null and started_at is not null
        and completed_at is null)
  ),
  constraint background_jobs_terminal_has_completion check (
    status in ('queued', 'running') or completed_at is not null
  ),
  constraint background_jobs_succeeded_shape check (
    status <> 'succeeded' or (result_summary is not null and error_code is null)
  ),
  constraint background_jobs_failed_has_error check (
    status not in ('failed', 'interrupted') or error_code is not null
  )
);

create unique index if not exists background_jobs_trip_id_id_unique
  on public.background_jobs (trip_id, id);
alter table public.background_jobs
  drop constraint if exists background_jobs_parent_same_trip_fk;
alter table public.background_jobs
  add constraint background_jobs_parent_same_trip_fk
  foreign key (trip_id, parent_job_id) references public.background_jobs (trip_id, id);
create unique index if not exists background_jobs_idempotency_key_unique
  on public.background_jobs (idempotency_key);
create index if not exists background_jobs_status_run_at_idx
  on public.background_jobs (status, run_at);
create index if not exists background_jobs_trip_created_idx
  on public.background_jobs (trip_id, created_at desc);
create index if not exists background_jobs_running_lease_idx
  on public.background_jobs (lease_expires_at) where status = 'running';
-- A job can have at most one active rerun.
create unique index if not exists background_jobs_one_active_rerun_idx
  on public.background_jobs (parent_job_id)
  where parent_job_id is not null and status in ('queued', 'running');

-- Insert rules: the owner is the trip owner, and only a failed or interrupted job can be rerun.
create or replace function public.background_jobs_validate_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_owner uuid;
  v_parent_status text;
begin
  select user_id into v_owner from public.trips where id = new.trip_id;
  if v_owner is null or v_owner <> new.user_id then
    raise exception 'JOB_OWNER_MISMATCH';
  end if;
  if new.status <> 'queued' then
    raise exception 'JOB_MUST_START_QUEUED';
  end if;
  if new.parent_job_id is not null then
    select status into v_parent_status from public.background_jobs
    where id = new.parent_job_id and trip_id = new.trip_id;
    if v_parent_status is null then
      raise exception 'JOB_PARENT_NOT_IN_TRIP';
    end if;
    if v_parent_status not in ('failed', 'interrupted') then
      raise exception 'JOB_PARENT_NOT_RERUNNABLE';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists background_jobs_validate_insert_trigger on public.background_jobs;
create trigger background_jobs_validate_insert_trigger
before insert on public.background_jobs
for each row execute procedure public.background_jobs_validate_insert();

-- Update rules: identity columns are fixed and only these transitions exist:
-- queued -> running | cancelled, running -> succeeded | failed | interrupted.
create or replace function public.background_jobs_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id <> old.id
     or new.trip_id <> old.trip_id
     or new.user_id <> old.user_id
     or new.job_type <> old.job_type
     or new.payload <> old.payload
     or new.idempotency_key <> old.idempotency_key
     or new.parent_job_id is distinct from old.parent_job_id
     or new.correlation_id <> old.correlation_id
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'JOB_IMMUTABLE_COLUMN';
  end if;
  if old.status in ('succeeded', 'failed', 'interrupted', 'cancelled') then
    raise exception 'JOB_TERMINAL_STATE';
  end if;
  if new.status <> old.status then
    if not ((old.status = 'queued' and new.status in ('running', 'cancelled'))
         or (old.status = 'running' and new.status in ('succeeded', 'failed', 'interrupted'))) then
      raise exception 'JOB_TRANSITION_INVALID';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists background_jobs_guard_update_trigger on public.background_jobs;
create trigger background_jobs_guard_update_trigger
before update on public.background_jobs
for each row execute procedure public.background_jobs_guard_update();

-- ---------------------------------------------------------------------------
-- alerts
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  agenda_item_id uuid,
  journey_leg_id uuid,
  job_id uuid,
  alert_type text not null,
  severity text not null,
  title text not null,
  factual_summary text not null,
  recommendation_summary text not null,
  source_ids uuid[] not null,
  retrieved_at timestamptz not null,
  expires_at timestamptz not null,
  triggered_at timestamptz not null default now(),
  deduplication_key text not null,
  policy_version text not null,
  reason_codes jsonb not null default '[]'::jsonb,
  status text not null default 'unread',
  read_at timestamptz,
  dismissed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alerts_type_check check (alert_type in ('departure_reminder', 'traffic_risk', 'weather_risk')),
  constraint alerts_severity_check check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  constraint alerts_status_check check (status in ('unread', 'read', 'dismissed')),
  constraint alerts_title_length check (char_length(trim(title)) between 1 and 200),
  constraint alerts_factual_length check (char_length(trim(factual_summary)) between 1 and 1000),
  constraint alerts_recommendation_length check (char_length(trim(recommendation_summary)) between 1 and 1000),
  constraint alerts_dedup_length check (char_length(deduplication_key) between 8 and 500),
  constraint alerts_sources_required check (cardinality(source_ids) >= 1),
  constraint alerts_expiry_check check (expires_at > retrieved_at),
  constraint alerts_reason_codes_array check (jsonb_typeof(reason_codes) = 'array'),
  constraint alerts_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint alerts_subject_check check (agenda_item_id is not null or journey_leg_id is not null),
  constraint alerts_state_shape check (
    (status = 'unread' and read_at is null and dismissed_at is null)
    or (status = 'read' and read_at is not null and dismissed_at is null)
    or (status = 'dismissed' and dismissed_at is not null)
  ),
  constraint alerts_agenda_same_trip_fk
    foreign key (trip_id, agenda_item_id) references public.agenda_items (trip_id, id),
  constraint alerts_leg_same_trip_fk
    foreign key (trip_id, journey_leg_id) references public.journey_legs (trip_id, id),
  constraint alerts_job_same_trip_fk
    foreign key (trip_id, job_id) references public.background_jobs (trip_id, id)
);

-- One alert per condition and window. A dismissed alert keeps its row, so it is not created again.
create unique index if not exists alerts_trip_dedup_unique
  on public.alerts (trip_id, deduplication_key);
create index if not exists alerts_trip_status_triggered_idx
  on public.alerts (trip_id, status, triggered_at desc);
create index if not exists alerts_agenda_type_expiry_idx
  on public.alerts (agenda_item_id, alert_type, expires_at);
create index if not exists alerts_leg_type_expiry_idx
  on public.alerts (journey_leg_id, alert_type, expires_at);

-- Every source of an alert must belong to the alert's trip.
create or replace function public.alerts_validate_sources()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from unnest(new.source_ids) as wanted(id)
    left join public.sources s on s.id = wanted.id and s.trip_id = new.trip_id
    where s.id is null
  ) then
    raise exception 'ALERT_SOURCE_NOT_IN_TRIP';
  end if;
  return new;
end;
$$;

drop trigger if exists alerts_validate_sources_trigger on public.alerts;
create trigger alerts_validate_sources_trigger
before insert or update of source_ids, trip_id on public.alerts
for each row execute procedure public.alerts_validate_sources();

-- Read and dismiss are one-way and stamped by the server, whoever sends the update.
create or replace function public.alerts_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'dismissed' and new.status <> 'dismissed' then
    raise exception 'ALERT_DISMISSED_IS_FINAL';
  end if;
  if old.status = 'read' and new.status = 'unread' then
    raise exception 'ALERT_READ_IS_FINAL';
  end if;
  if new.status = 'read' and old.status = 'unread' then
    new.read_at = now();
  elsif old.read_at is not null then
    new.read_at = old.read_at;
  end if;
  if new.status = 'dismissed' and old.status <> 'dismissed' then
    new.dismissed_at = now();
  elsif old.dismissed_at is not null then
    new.dismissed_at = old.dismissed_at;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists alerts_guard_update_trigger on public.alerts;
create trigger alerts_guard_update_trigger
before update on public.alerts
for each row execute procedure public.alerts_guard_update();

-- ---------------------------------------------------------------------------
-- Row level security
alter table public.background_jobs enable row level security;
alter table public.alerts enable row level security;

revoke all on table public.background_jobs from anon, authenticated;
revoke all on table public.alerts from anon, authenticated;
grant select on table public.background_jobs to authenticated;
grant select on table public.alerts to authenticated;
grant update (status, read_at, dismissed_at) on table public.alerts to authenticated;

drop policy if exists background_jobs_select_own_trip on public.background_jobs;
create policy background_jobs_select_own_trip
on public.background_jobs for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = background_jobs.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists alerts_select_own_trip on public.alerts;
create policy alerts_select_own_trip
on public.alerts for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = alerts.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists alerts_update_own_trip on public.alerts;
create policy alerts_update_own_trip
on public.alerts for update to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = alerts.trip_id and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = alerts.trip_id and trips.user_id = (select auth.uid())
));
-- No insert or delete policy exists for users on either table.

-- ---------------------------------------------------------------------------
-- Worker functions. Only the backend (service_role) can call them.

-- Claims up to p_limit due jobs. Rows locked by another claimer are skipped, so two
-- workers can never receive the same job.
create or replace function public.claim_background_jobs(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.background_jobs
language plpgsql
set search_path = public
as $$
begin
  if p_worker_id is null or char_length(trim(p_worker_id)) = 0
     or p_limit is null or p_limit < 1
     or p_lease_seconds is null or p_lease_seconds < 5 then
    raise exception 'CLAIM_ARGUMENTS_INVALID';
  end if;
  return query
  with due as (
    select j.id
    from public.background_jobs j
    where j.status = 'queued' and j.run_at <= now()
    order by j.run_at, j.created_at
    limit p_limit
    for update skip locked
  )
  update public.background_jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at = now(),
      execution_id = gen_random_uuid()
  from due
  where j.id = due.id
  returning j.*;
end;
$$;

-- Renews the lease. False means the lease is gone (expired or reclaimed): the worker must stop.
create or replace function public.heartbeat_background_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  update public.background_jobs
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_job_id
    and status = 'running'
    and lease_owner = p_worker_id
    and lease_expires_at > now();
  return found;
end;
$$;

-- Records the result of a running job and writes the activity log in the same transaction.
-- False means the job is no longer running under this worker (for example it was
-- reclaimed as interrupted), so nothing is recorded as success.
create or replace function public.complete_background_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_result jsonb,
  p_error_code text,
  p_error_message text,
  p_provider_request_ids jsonb
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_job public.background_jobs%rowtype;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'JOB_COMPLETION_STATUS_INVALID';
  end if;
  update public.background_jobs
  set status = p_status,
      result_summary = p_result,
      error_code = case when p_status = 'failed' then p_error_code else null end,
      error_message = case when p_status = 'failed' then p_error_message else null end,
      provider_request_ids = coalesce(p_provider_request_ids, '[]'::jsonb),
      completed_at = now()
  where id = p_job_id and status = 'running' and lease_owner = p_worker_id
  returning * into v_job;
  if not found then
    return false;
  end if;
  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_job.user_id,
    case when p_status = 'succeeded' then 'job.succeeded' else 'job.failed' end,
    'background_job',
    v_job.id,
    jsonb_build_object(
      'trip_id', v_job.trip_id,
      'job_type', v_job.job_type,
      'correlation_id', v_job.correlation_id,
      'execution_id', v_job.execution_id,
      'worker_id', p_worker_id,
      'error_code', v_job.error_code
    )
  );
  return true;
end;
$$;

-- Marks running jobs whose lease has expired as interrupted. They are never run again
-- and never turn into a success; only a manual rerun creates a new job.
create or replace function public.reclaim_expired_background_jobs()
returns setof public.background_jobs
language plpgsql
set search_path = public
as $$
begin
  return query
  with reclaimed as (
    update public.background_jobs
    set status = 'interrupted',
        error_code = 'JOB_INTERRUPTED',
        error_message = 'The worker stopped before the job finished. The lease expired.',
        completed_at = now()
    where status = 'running' and lease_expires_at < now()
    returning *
  ),
  logged as (
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    select r.user_id, 'job.interrupted', 'background_job', r.id,
           jsonb_build_object(
             'trip_id', r.trip_id,
             'job_type', r.job_type,
             'correlation_id', r.correlation_id,
             'execution_id', r.execution_id,
             'worker_id', r.lease_owner
           )
    from reclaimed r
  )
  select * from reclaimed;
end;
$$;

-- Cancels a job that has not started, for example a reminder for a departure time that changed.
create or replace function public.cancel_queued_background_job(
  p_job_id uuid,
  p_reason text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_job public.background_jobs%rowtype;
begin
  update public.background_jobs
  set status = 'cancelled',
      completed_at = now(),
      result_summary = jsonb_build_object('outcome', 'cancelled', 'reason', p_reason)
  where id = p_job_id and status = 'queued'
  returning * into v_job;
  if not found then
    return false;
  end if;
  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_job.user_id, 'job.cancelled', 'background_job', v_job.id,
    jsonb_build_object(
      'trip_id', v_job.trip_id,
      'job_type', v_job.job_type,
      'correlation_id', v_job.correlation_id,
      'reason', p_reason
    )
  );
  return true;
end;
$$;

-- Inserts an alert and any new internal sources in one step. The unique key
-- (trip_id, deduplication_key) makes concurrent callers produce one row. When the
-- alert already exists, the evidence of the older row is renewed only if the new
-- evidence is newer and the alert is not dismissed; the row count stays at one.
create or replace function public.create_alert(
  p_alert jsonb,
  p_sources jsonb
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_alert public.alerts%rowtype;
  v_existing public.alerts%rowtype;
  v_owner uuid;
begin
  if p_alert is null or jsonb_typeof(p_alert) <> 'object' then
    raise exception 'ALERT_INVALID';
  end if;
  v_alert := jsonb_populate_record(null::public.alerts, p_alert);
  if v_alert.id is null then
    v_alert.id := gen_random_uuid();
  end if;
  if v_alert.status is null then
    v_alert.status := 'unread';
  end if;
  select user_id into v_owner from public.trips where id = v_alert.trip_id;
  if v_owner is null then
    raise exception 'ALERT_TRIP_NOT_FOUND';
  end if;

  begin
    if p_sources is not null and jsonb_typeof(p_sources) = 'array' then
      insert into public.sources
      select * from jsonb_populate_recordset(null::public.sources, p_sources);
    end if;
    insert into public.alerts (
      id, trip_id, agenda_item_id, journey_leg_id, job_id, alert_type, severity, title,
      factual_summary, recommendation_summary, source_ids, retrieved_at, expires_at,
      triggered_at, deduplication_key, policy_version, reason_codes, status, metadata
    ) values (
      v_alert.id, v_alert.trip_id, v_alert.agenda_item_id, v_alert.journey_leg_id, v_alert.job_id,
      v_alert.alert_type, v_alert.severity, v_alert.title, v_alert.factual_summary,
      v_alert.recommendation_summary, v_alert.source_ids, v_alert.retrieved_at, v_alert.expires_at,
      coalesce(v_alert.triggered_at, now()), v_alert.deduplication_key, v_alert.policy_version,
      coalesce(v_alert.reason_codes, '[]'::jsonb), v_alert.status, coalesce(v_alert.metadata, '{}'::jsonb)
    );
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    values (
      v_owner, 'alert.created', 'alert', v_alert.id,
      jsonb_build_object(
        'trip_id', v_alert.trip_id,
        'alert_type', v_alert.alert_type,
        'severity', v_alert.severity,
        'job_id', v_alert.job_id,
        'deduplication_key', v_alert.deduplication_key
      )
    );
    return jsonb_build_object('created', true, 'refreshed', false, 'alert_id', v_alert.id);
  exception when unique_violation then
    -- The block above is rolled back, including the sources it inserted.
    select * into v_existing from public.alerts
    where trip_id = v_alert.trip_id and deduplication_key = v_alert.deduplication_key;
    if not found then
      raise;
    end if;
    update public.alerts
    set retrieved_at = v_alert.retrieved_at,
        expires_at = v_alert.expires_at,
        factual_summary = v_alert.factual_summary,
        recommendation_summary = v_alert.recommendation_summary,
        severity = v_alert.severity,
        source_ids = v_alert.source_ids,
        job_id = coalesce(v_alert.job_id, v_existing.job_id)
    where id = v_existing.id
      and dismissed_at is null
      and v_alert.retrieved_at > v_existing.retrieved_at;
    return jsonb_build_object('created', false, 'refreshed', found, 'alert_id', v_existing.id);
  end;
end;
$$;

revoke all on function public.claim_background_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_background_job(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_background_job(uuid, text, text, jsonb, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.reclaim_expired_background_jobs() from public, anon, authenticated;
revoke all on function public.cancel_queued_background_job(uuid, text) from public, anon, authenticated;
revoke all on function public.create_alert(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.claim_background_jobs(text, integer, integer) to service_role;
grant execute on function public.heartbeat_background_job(uuid, text, integer) to service_role;
grant execute on function public.complete_background_job(uuid, text, text, jsonb, text, text, jsonb) to service_role;
grant execute on function public.reclaim_expired_background_jobs() to service_role;
grant execute on function public.cancel_queued_background_job(uuid, text) to service_role;
grant execute on function public.create_alert(jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- service_role privileges. The worker and the rerun endpoint are the only writers of
-- jobs and alerts. The grants on earlier tables are the least the worker needs:
-- read the trip data it evaluates, and store the snapshots that the shared mobility
-- service writes through persist_mobility_batch.
grant select, insert, update on table public.background_jobs to service_role;
grant select, insert, update on table public.alerts to service_role;
grant select on table public.trips to service_role;
grant select on table public.context_points to service_role;
grant select on table public.agenda_items to service_role;
grant select on table public.journey_legs to service_role;
grant select, insert on table public.weather_snapshots to service_role;
grant select, insert on table public.traffic_snapshots to service_role;
grant select, insert on table public.sources to service_role;
grant select, insert on table public.activity_logs to service_role;
grant execute on function public.persist_mobility_batch(jsonb) to service_role;
