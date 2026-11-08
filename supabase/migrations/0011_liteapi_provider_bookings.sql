-- TravelFlow Migration 0011: LiteAPI hotel and flight fulfillment
-- Provider booking state is separate from the existing internal commerce flow.
-- Customer card data and full passport data are never persisted here.

alter table public.bookings
  drop constraint if exists bookings_type_check;
alter table public.bookings
  add constraint bookings_type_check check (booking_type in ('event', 'activity', 'itinerary_item', 'hotel', 'flight'));

alter table public.bookings
  drop constraint if exists bookings_source_type_check;
alter table public.bookings
  add constraint bookings_source_type_check check (source_type in ('event_discovery_result', 'activity', 'agenda_item', 'liteapi_offer'));

create table if not exists public.provider_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  trip_id uuid not null references public.trips(id) on delete restrict,
  provider text not null default 'liteapi',
  booking_type text not null,
  offer_id text not null,
  prebook_id text,
  client_reference text not null,
  provider_booking_id text,
  provider_status text,
  state text not null default 'created',
  currency text not null,
  subtotal numeric(12, 2) not null,
  tax numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  confirmation_code text,
  checkin date,
  checkout date,
  ticket_deadline timestamptz,
  cancellation_fee numeric(12, 2),
  refund_amount numeric(12, 2),
  metadata jsonb not null default '{}'::jsonb,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint provider_bookings_provider_check check (provider = 'liteapi'),
  constraint provider_bookings_type_check check (booking_type in ('hotel', 'flight')),
  constraint provider_bookings_state_check check (state in ('created', 'prebooked', 'paid', 'booking', 'pending', 'confirmed', 'cancel_requested', 'cancelled', 'failed', 'unknown')),
  constraint provider_bookings_money_check check (subtotal >= 0 and tax >= 0 and total >= 0),
  constraint provider_bookings_currency_check check (char_length(currency) = 3 and translate(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') = ''),
  constraint provider_bookings_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists provider_bookings_client_reference_unique
  on public.provider_bookings(provider, client_reference);
create unique index if not exists provider_bookings_provider_id_unique
  on public.provider_bookings(provider, provider_booking_id)
  where provider_booking_id is not null;
create index if not exists provider_bookings_trip_created_idx
  on public.provider_bookings(trip_id, created_at desc);
create index if not exists provider_bookings_prebook_idx
  on public.provider_bookings(provider, prebook_id);

drop trigger if exists provider_bookings_set_updated_at on public.provider_bookings;
create trigger provider_bookings_set_updated_at
before update on public.provider_bookings
for each row execute procedure public.set_updated_at();

alter table public.provider_bookings enable row level security;
grant select, insert, update on table public.provider_bookings to authenticated;

drop policy if exists provider_bookings_select_own_trip on public.provider_bookings;
create policy provider_bookings_select_own_trip
on public.provider_bookings for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = provider_bookings.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists provider_bookings_insert_own_trip on public.provider_bookings;
create policy provider_bookings_insert_own_trip
on public.provider_bookings for insert to authenticated
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.trips where trips.id = provider_bookings.trip_id and trips.user_id = (select auth.uid()))
);

drop policy if exists provider_bookings_update_own_trip on public.provider_bookings;
create policy provider_bookings_update_own_trip
on public.provider_bookings for update to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = provider_bookings.trip_id and trips.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.trips
  where trips.id = provider_bookings.trip_id and trips.user_id = (select auth.uid())
));

comment on table public.provider_bookings is 'LiteAPI fulfillment attempts and provider status. Never stores card or full travel document data.';
