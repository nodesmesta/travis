-- TravelFlow Migration 0006: internal bookings and dummy payments

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  trip_id uuid not null references public.trips(id) on delete restrict,
  booking_type text not null,
  source_type text not null,
  source_id uuid not null,
  provider_name text not null default 'internal',
  confirmation_code text,
  status text not null default 'pending_payment',
  currency text not null,
  subtotal numeric(12, 2) not null,
  tax numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  pricing_policy text not null default 'demo-pricing-v1',
  starts_at timestamptz,
  ends_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint bookings_type_check check (booking_type in ('event', 'activity', 'itinerary_item')),
  constraint bookings_source_type_check check (source_type in ('event_discovery_result', 'activity', 'agenda_item')),
  constraint bookings_status_check check (status in ('draft', 'pending_payment', 'paid', 'confirmed', 'cancelled', 'expired', 'failed', 'refunded')),
  constraint bookings_currency_check check (char_length(currency) = 3 and translate(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') = ''),
  constraint bookings_money_non_negative check (subtotal >= 0 and tax >= 0 and total >= 0),
  constraint bookings_total_check check (total = subtotal + tax),
  constraint bookings_time_order check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists bookings_trip_status_created_idx
  on public.bookings (trip_id, status, created_at desc);
create index if not exists bookings_trip_source_idx
  on public.bookings (trip_id, source_type, source_id);
create unique index if not exists bookings_active_source_unique_idx
  on public.bookings (trip_id, source_type, source_id)
  where status not in ('cancelled', 'expired', 'failed', 'refunded');

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
before update on public.bookings
for each row execute procedure public.set_updated_at();

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete restrict,
  payment_reference text not null unique,
  provider text not null default 'dummy_payment',
  mode text not null default 'simulated',
  amount numeric(12, 2) not null,
  currency text not null,
  status text not null default 'pending',
  paid_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payments_provider_check check (provider = 'dummy_payment'),
  constraint payments_mode_check check (mode = 'simulated'),
  constraint payments_status_check check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'refunded')),
  constraint payments_amount_non_negative check (amount >= 0),
  constraint payments_currency_check check (char_length(currency) = 3 and translate(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') = ''),
  constraint payments_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint payments_failure_code_check check (status <> 'failed' or failure_code is not null),
  constraint payments_paid_at_check check (status in ('succeeded', 'refunded') or paid_at is null),
  constraint payments_failed_at_check check (status = 'failed' or failed_at is null)
);

create index if not exists payments_booking_status_idx
  on public.payments (booking_id, status);
create unique index if not exists payments_one_succeeded_per_booking_idx
  on public.payments (booking_id)
  where status in ('succeeded', 'refunded');

drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at
before update on public.payments
for each row execute procedure public.set_updated_at();

alter table public.bookings enable row level security;
alter table public.payments enable row level security;
grant select, insert, update on table public.bookings to authenticated;
grant select on table public.payments to authenticated;

drop policy if exists bookings_select_own_trip on public.bookings;
create policy bookings_select_own_trip
on public.bookings for select
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = bookings.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists bookings_insert_own_trip on public.bookings;
create policy bookings_insert_own_trip
on public.bookings for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.trips
    where trips.id = bookings.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy if exists bookings_update_own_trip on public.bookings;
create policy bookings_update_own_trip
on public.bookings for update
to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = bookings.trip_id
    and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = bookings.trip_id
    and trips.user_id = (select auth.uid())
));

drop policy if exists payments_select_own_booking on public.payments;
create policy payments_select_own_booking
on public.payments for select
to authenticated
using (exists (
  select 1
  from public.bookings
  join public.trips on trips.id = bookings.trip_id
  where bookings.id = payments.booking_id
    and trips.user_id = (select auth.uid())
));

create or replace function public.simulate_dummy_payment(
  p_booking_id uuid,
  p_outcome text,
  p_failure_code text,
  p_idempotency_key text,
  p_request_hash text,
  p_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  booking_row public.bookings%rowtype;
  payment_row public.payments%rowtype;
  existing_idempotency public.idempotency_records%rowtype;
  response jsonb;
  confirmation text;
begin
  if actor_id is null then raise exception 'AUTH_TOKEN_INVALID'; end if;
  if p_outcome not in ('succeeded', 'failed', 'pending', 'cancelled') then
    raise exception 'PAYMENT_SIMULATION_INVALID';
  end if;

  select * into existing_idempotency
  from public.idempotency_records
  where actor_user_id = actor_id
    and scope = p_scope
    and idempotency_key = p_idempotency_key
  for update;

  if existing_idempotency.id is not null then
    if existing_idempotency.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    if existing_idempotency.status = 'completed' then
      return existing_idempotency.response_body;
    end if;
    if existing_idempotency.expires_at is not null and existing_idempotency.expires_at <= timezone('utc', now()) then
      delete from public.idempotency_records where id = existing_idempotency.id;
    else
      raise exception 'IDEMPOTENCY_IN_PROGRESS';
    end if;
  end if;

  insert into public.idempotency_records (
    actor_user_id, scope, idempotency_key, request_hash, status, response_body, expires_at
  ) values (
    actor_id, p_scope, p_idempotency_key, p_request_hash, 'processing', '{}'::jsonb,
    timezone('utc', now()) + interval '24 hours'
  );

  select * into booking_row
  from public.bookings
  where id = p_booking_id and user_id = actor_id
  for update;
  if booking_row.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if booking_row.status <> 'pending_payment' then raise exception 'BOOKING_STATE_INVALID'; end if;

  select * into payment_row
  from public.payments
  where booking_id = p_booking_id
  order by created_at desc
  limit 1
  for update;

  if payment_row.id is null then
    insert into public.payments (booking_id, payment_reference, amount, currency, status)
    values (p_booking_id, 'dummy_' || replace(gen_random_uuid()::text, '-', ''), booking_row.total, booking_row.currency, 'pending')
    returning * into payment_row;
  elsif payment_row.status in ('succeeded', 'refunded') then
    raise exception 'PAYMENT_DUPLICATE';
  elsif payment_row.status <> 'pending' then
    raise exception 'PAYMENT_STATE_INVALID';
  end if;

  if p_outcome = 'succeeded' then
    confirmation := 'TF-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    update public.payments
    set status = 'succeeded', paid_at = timezone('utc', now()), failure_code = null
    where id = payment_row.id
    returning * into payment_row;
    update public.bookings
    set status = 'paid', confirmation_code = confirmation
    where id = booking_row.id
    returning * into booking_row;
    update public.bookings
    set status = 'confirmed'
    where id = booking_row.id
    returning * into booking_row;
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    values
      (actor_id, 'payment.succeeded', 'payment', payment_row.id, jsonb_build_object('booking_id', booking_row.id, 'amount', payment_row.amount, 'currency', payment_row.currency)),
      (actor_id, 'booking.confirmed', 'booking', booking_row.id, jsonb_build_object('payment_id', payment_row.id));
  elsif p_outcome = 'failed' then
    update public.payments
    set status = 'failed', failed_at = timezone('utc', now()), failure_code = coalesce(nullif(trim(p_failure_code), ''), 'dummy_payment_failed')
    where id = payment_row.id
    returning * into payment_row;
    update public.bookings set status = 'failed' where id = booking_row.id returning * into booking_row;
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    values (actor_id, 'payment.failed', 'payment', payment_row.id, jsonb_build_object('booking_id', booking_row.id, 'failure_code', payment_row.failure_code));
  elsif p_outcome = 'cancelled' then
    update public.payments set status = 'cancelled' where id = payment_row.id returning * into payment_row;
    update public.bookings set status = 'cancelled', cancelled_at = timezone('utc', now()) where id = booking_row.id returning * into booking_row;
    insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
    values (actor_id, 'payment.cancelled', 'payment', payment_row.id, jsonb_build_object('booking_id', booking_row.id));
  end if;

  response := jsonb_build_object('booking', to_jsonb(booking_row), 'payment', to_jsonb(payment_row));
  update public.idempotency_records
  set status = 'completed', response_body = response, completed_at = timezone('utc', now())
  where actor_user_id = actor_id and scope = p_scope and idempotency_key = p_idempotency_key;
  return response;
exception when others then
  delete from public.idempotency_records
  where actor_user_id = actor_id and scope = p_scope and idempotency_key = p_idempotency_key and status = 'processing';
  raise;
end;
$$;

create or replace function public.refund_dummy_payment(
  p_booking_id uuid,
  p_payment_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_scope text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  booking_row public.bookings%rowtype;
  payment_row public.payments%rowtype;
  existing_idempotency public.idempotency_records%rowtype;
  response jsonb;
begin
  if actor_id is null then raise exception 'AUTH_TOKEN_INVALID'; end if;
  select * into existing_idempotency from public.idempotency_records
  where actor_user_id = actor_id and scope = p_scope and idempotency_key = p_idempotency_key for update;
  if existing_idempotency.id is not null then
    if existing_idempotency.request_hash <> p_request_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    if existing_idempotency.status = 'completed' then return existing_idempotency.response_body; end if;
    raise exception 'IDEMPOTENCY_IN_PROGRESS';
  end if;
  insert into public.idempotency_records (actor_user_id, scope, idempotency_key, request_hash, status, response_body, expires_at)
  values (actor_id, p_scope, p_idempotency_key, p_request_hash, 'processing', '{}'::jsonb, timezone('utc', now()) + interval '24 hours');
  select * into booking_row from public.bookings where id = p_booking_id and user_id = actor_id for update;
  if booking_row.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if booking_row.status <> 'confirmed' then raise exception 'BOOKING_STATE_INVALID'; end if;
  select * into payment_row from public.payments where id = p_payment_id and booking_id = p_booking_id for update;
  if payment_row.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if payment_row.status <> 'succeeded' then raise exception 'PAYMENT_STATE_INVALID'; end if;
  update public.payments set status = 'refunded' where id = payment_row.id returning * into payment_row;
  update public.bookings set status = 'refunded' where id = booking_row.id returning * into booking_row;
  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values
    (actor_id, 'payment.refunded', 'payment', payment_row.id, jsonb_build_object('booking_id', booking_row.id)),
    (actor_id, 'booking.refunded', 'booking', booking_row.id, jsonb_build_object('payment_id', payment_row.id));
  response := jsonb_build_object('booking', to_jsonb(booking_row), 'payment', to_jsonb(payment_row));
  update public.idempotency_records set status = 'completed', response_body = response, completed_at = timezone('utc', now())
  where actor_user_id = actor_id and scope = p_scope and idempotency_key = p_idempotency_key;
  return response;
exception when others then
  delete from public.idempotency_records
  where actor_user_id = actor_id and scope = p_scope and idempotency_key = p_idempotency_key and status = 'processing';
  raise;
end;
$$;

grant execute on function public.simulate_dummy_payment(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.refund_dummy_payment(uuid, uuid, text, text, text) to authenticated;

comment on table public.bookings is 'Internal trip booking records; not external fulfillment.';
comment on table public.payments is 'Dummy payment records without card or credential data.';
