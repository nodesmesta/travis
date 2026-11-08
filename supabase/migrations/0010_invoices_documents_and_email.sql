-- TravelFlow Migration 0010: invoices, private documents, and email deliveries (Task 11)
--
-- Decisions
-- * An invoice exists only for a payment with status `succeeded` and a booking with
--   status `confirmed`. A trigger enforces it, so no API or worker bug can bypass it.
--   The invoice copies subtotal, tax, total, currency, and pricing_policy from the
--   booking (which the server priced) and the trigger checks that the total equals
--   payments.amount. The invoice amounts can never be edited afterwards.
-- * One invoice per booking and one per payment (unique indexes).
-- * Invoice numbers are `INV-YYYY-NNNNNN`. YYYY is the UTC year of `issued_at` and
--   NNNNNN is a gapless counter per year kept in `invoice_number_counters`. The counter
--   row is locked in the same transaction that inserts the invoice, so two requests
--   never get the same number and a rolled back request does not leave a gap.
-- * An invoice starts `pending` (numbered, no PDF yet), becomes `issued` when the PDF
--   is stored and its SHA-256 is recorded, or `failed` when storing the PDF failed.
--   `failed` can go back to `pending` or on to `issued` (the same invoice resumes, for
--   example when two requests overlap). `issued` is final.
-- * The PDF lives in the private Storage bucket `invoices`. No Storage policy is
--   created, so the anon and authenticated roles cannot list, read, or write objects.
--   The API reads them with the service role after it checked ownership.
-- * An email delivery is one attempt. A resend is a new row. The unique `dedup_key`
--   makes an identical request (same invoice, recipient, and Idempotency-Key) return
--   the row that already exists. `claim_email_delivery` is atomic, so a duplicate job
--   cannot send a second message for one delivery.
-- * `service_role` writes only through the SECURITY DEFINER functions below. It gets
--   no insert or update privilege on these tables. Users can only read their own rows.
-- * This migration widens `background_jobs_job_type_check` (migration 0009) with the
--   two Task 11 job types and changes nothing else of Task 10.
-- * It does not change `source_references.entity_type`.

-- ---------------------------------------------------------------------------
-- Private bucket

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 5242880, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['application/pdf'];

-- ---------------------------------------------------------------------------
-- Job types

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;
alter table public.background_jobs
  add constraint background_jobs_type_check check (job_type in (
    'refresh_weather',
    'refresh_traffic',
    'evaluate_alerts',
    'departure_reminder',
    'generate_invoice',
    'send_invoice_email'
  ));

-- ---------------------------------------------------------------------------
-- Tables

create table if not exists public.invoice_number_counters (
  invoice_year integer primary key,
  last_value integer not null default 0,
  constraint invoice_counters_year_check check (invoice_year between 2000 and 9999),
  constraint invoice_counters_value_check check (last_value between 0 and 999999)
);

create table if not exists public.document_storage_objects (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  document_type text not null,
  bucket text not null,
  object_path text not null,
  content_type text not null,
  size_bytes integer not null,
  sha256 text not null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint document_objects_type_check check (document_type in ('invoice_pdf')),
  constraint document_objects_bucket_check check (bucket = 'invoices'),
  constraint document_objects_path_check check (
    char_length(object_path) between 3 and 300
    and left(object_path, 1) <> '/'
    and position('..' in object_path) = 0
  ),
  constraint document_objects_content_type_check check (content_type = 'application/pdf'),
  constraint document_objects_size_check check (size_bytes between 1 and 5242880),
  constraint document_objects_sha256_check check (
    char_length(sha256) = 64 and translate(sha256, '0123456789abcdef', '') = ''
  )
);

create unique index if not exists document_objects_bucket_path_unique
  on public.document_storage_objects (bucket, object_path);
create index if not exists document_objects_trip_idx
  on public.document_storage_objects (trip_id, created_at desc);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  booking_id uuid not null references public.bookings(id) on delete restrict,
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_year integer not null,
  sequence_number integer not null,
  invoice_number text not null,
  status text not null default 'pending',
  currency text not null,
  subtotal numeric(12, 2) not null,
  tax numeric(12, 2) not null,
  total numeric(12, 2) not null,
  pricing_policy text not null,
  pdf_object_id uuid references public.document_storage_objects(id) on delete restrict,
  pdf_sha256 text,
  pdf_size_bytes integer,
  pdf_error_code text,
  issued_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint invoices_status_check check (status in ('pending', 'issued', 'failed')),
  constraint invoices_sequence_check check (sequence_number between 1 and 999999),
  constraint invoices_year_check check (invoice_year between 2000 and 9999),
  constraint invoices_number_format_check check (
    invoice_number = 'INV-' || invoice_year::text || '-' || lpad(sequence_number::text, 6, '0')
  ),
  constraint invoices_currency_check check (char_length(currency) = 3 and translate(currency, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '') = ''),
  constraint invoices_money_non_negative check (subtotal >= 0 and tax >= 0 and total >= 0),
  constraint invoices_total_check check (total = subtotal + tax),
  constraint invoices_pdf_sha256_check check (
    pdf_sha256 is null
    or (char_length(pdf_sha256) = 64 and translate(pdf_sha256, '0123456789abcdef', '') = '')
  ),
  constraint invoices_issued_has_pdf check (
    (status = 'issued' and pdf_object_id is not null and pdf_sha256 is not null
       and pdf_size_bytes is not null and pdf_size_bytes > 0)
    or (status <> 'issued' and pdf_object_id is null and pdf_sha256 is null and pdf_size_bytes is null)
  ),
  constraint invoices_failed_has_error check (
    (status = 'failed' and pdf_error_code is not null)
    or (status <> 'failed' and pdf_error_code is null)
  )
);

create unique index if not exists invoices_booking_unique on public.invoices (booking_id);
create unique index if not exists invoices_payment_unique on public.invoices (payment_id);
create unique index if not exists invoices_number_unique on public.invoices (invoice_number);
create unique index if not exists invoices_year_sequence_unique
  on public.invoices (invoice_year, sequence_number);
create unique index if not exists invoices_trip_id_id_unique on public.invoices (trip_id, id);
create index if not exists invoices_trip_created_idx on public.invoices (trip_id, created_at desc);

create table if not exists public.email_deliveries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  invoice_id uuid not null,
  sequence integer not null,
  recipient_email text not null,
  status text not null default 'pending',
  provider text,
  provider_message_id text,
  error_code text,
  error_message text,
  attachment_sha256 text,
  attachment_size_bytes integer,
  dedup_key text not null,
  requested_at timestamptz not null default timezone('utc', now()),
  attempted_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint email_deliveries_invoice_same_trip_fk
    foreign key (trip_id, invoice_id) references public.invoices (trip_id, id) on delete restrict,
  constraint email_deliveries_status_check check (status in ('pending', 'sent', 'failed')),
  constraint email_deliveries_provider_check check (provider is null or provider in ('smtp', 'resend')),
  constraint email_deliveries_sequence_check check (sequence >= 1),
  constraint email_deliveries_recipient_length check (char_length(recipient_email) between 3 and 254),
  constraint email_deliveries_dedup_length check (char_length(dedup_key) between 16 and 700),
  constraint email_deliveries_error_message_length check (error_message is null or char_length(error_message) <= 300),
  constraint email_deliveries_attachment_sha_check check (
    attachment_sha256 is null
    or (char_length(attachment_sha256) = 64 and translate(attachment_sha256, '0123456789abcdef', '') = '')
  ),
  constraint email_deliveries_state_shape check (
    (status = 'pending' and sent_at is null and failed_at is null
       and provider_message_id is null and error_code is null)
    or (status = 'sent' and sent_at is not null and failed_at is null
       and provider is not null and provider_message_id is not null and error_code is null
       and attachment_sha256 is not null and attachment_size_bytes is not null)
    or (status = 'failed' and failed_at is not null and sent_at is null
       and error_code is not null and provider_message_id is null)
  )
);

create unique index if not exists email_deliveries_dedup_unique
  on public.email_deliveries (dedup_key);
create unique index if not exists email_deliveries_invoice_sequence_unique
  on public.email_deliveries (invoice_id, sequence);
create index if not exists email_deliveries_invoice_requested_idx
  on public.email_deliveries (invoice_id, requested_at desc);
create index if not exists email_deliveries_trip_idx
  on public.email_deliveries (trip_id, requested_at desc);

-- ---------------------------------------------------------------------------
-- Triggers

create or replace function public.invoices_validate_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_owner uuid;
begin
  select * into v_booking from public.bookings where id = new.booking_id;
  if v_booking.id is null then raise exception 'INVOICE_BOOKING_NOT_FOUND'; end if;
  select * into v_payment from public.payments where id = new.payment_id;
  if v_payment.id is null or v_payment.booking_id <> v_booking.id then
    raise exception 'INVOICE_PAYMENT_MISMATCH';
  end if;
  if v_payment.status <> 'succeeded' then raise exception 'INVOICE_PAYMENT_NOT_SUCCEEDED'; end if;
  if v_booking.status <> 'confirmed' then raise exception 'INVOICE_BOOKING_NOT_CONFIRMED'; end if;
  select user_id into v_owner from public.trips where id = v_booking.trip_id;
  if v_owner is null or v_owner <> new.user_id or v_booking.user_id <> new.user_id
     or v_booking.trip_id <> new.trip_id then
    raise exception 'INVOICE_OWNER_MISMATCH';
  end if;
  if new.subtotal <> v_booking.subtotal or new.tax <> v_booking.tax or new.total <> v_booking.total
     or new.currency <> v_booking.currency or new.pricing_policy <> v_booking.pricing_policy then
    raise exception 'INVOICE_BOOKING_AMOUNT_MISMATCH';
  end if;
  if new.total <> v_payment.amount or new.currency <> v_payment.currency then
    raise exception 'INVOICE_PAYMENT_AMOUNT_MISMATCH';
  end if;
  if new.status <> 'pending' then raise exception 'INVOICE_MUST_START_PENDING'; end if;
  return new;
end;
$$;

drop trigger if exists invoices_validate_insert_trigger on public.invoices;
create trigger invoices_validate_insert_trigger
before insert on public.invoices
for each row execute procedure public.invoices_validate_insert();

-- Identity, number, and amounts are fixed. Only pending -> issued | failed and
-- failed -> pending | issued exist. An issued invoice never changes.
create or replace function public.invoices_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id <> old.id
     or new.trip_id <> old.trip_id
     or new.user_id <> old.user_id
     or new.booking_id <> old.booking_id
     or new.payment_id <> old.payment_id
     or new.invoice_year <> old.invoice_year
     or new.sequence_number <> old.sequence_number
     or new.invoice_number <> old.invoice_number
     or new.currency <> old.currency
     or new.subtotal <> old.subtotal
     or new.tax <> old.tax
     or new.total <> old.total
     or new.pricing_policy <> old.pricing_policy
     or new.issued_at <> old.issued_at
     or new.created_at <> old.created_at then
    raise exception 'INVOICE_IMMUTABLE_COLUMN';
  end if;
  if old.status = 'issued' then raise exception 'INVOICE_ISSUED_IS_FINAL'; end if;
  if new.status <> old.status
     and not ((old.status = 'pending' and new.status in ('issued', 'failed'))
           or (old.status = 'failed' and new.status in ('pending', 'issued'))) then
    raise exception 'INVOICE_TRANSITION_INVALID';
  end if;
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists invoices_guard_update_trigger on public.invoices;
create trigger invoices_guard_update_trigger
before update on public.invoices
for each row execute procedure public.invoices_guard_update();

create or replace function public.document_objects_forbid_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'DOCUMENT_OBJECT_IMMUTABLE';
end;
$$;

drop trigger if exists document_objects_forbid_change_trigger on public.document_storage_objects;
create trigger document_objects_forbid_change_trigger
before update on public.document_storage_objects
for each row execute procedure public.document_objects_forbid_change();

create or replace function public.email_deliveries_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.id <> old.id
     or new.trip_id <> old.trip_id
     or new.user_id <> old.user_id
     or new.invoice_id <> old.invoice_id
     or new.sequence <> old.sequence
     or new.recipient_email <> old.recipient_email
     or new.dedup_key <> old.dedup_key
     or new.requested_at <> old.requested_at
     or new.created_at <> old.created_at then
    raise exception 'EMAIL_DELIVERY_IMMUTABLE_COLUMN';
  end if;
  if old.status <> 'pending' then raise exception 'EMAIL_DELIVERY_IS_FINAL'; end if;
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists email_deliveries_guard_update_trigger on public.email_deliveries;
create trigger email_deliveries_guard_update_trigger
before update on public.email_deliveries
for each row execute procedure public.email_deliveries_guard_update();

-- ---------------------------------------------------------------------------
-- Row level security. Users read what belongs to their own trips and write nothing.

alter table public.invoice_number_counters enable row level security;
alter table public.document_storage_objects enable row level security;
alter table public.invoices enable row level security;
alter table public.email_deliveries enable row level security;

revoke all on table public.invoice_number_counters from anon, authenticated;
revoke all on table public.document_storage_objects from anon, authenticated;
revoke all on table public.invoices from anon, authenticated;
revoke all on table public.email_deliveries from anon, authenticated;
grant select on table public.document_storage_objects to authenticated;
grant select on table public.invoices to authenticated;
grant select on table public.email_deliveries to authenticated;

drop policy if exists document_objects_select_own_trip on public.document_storage_objects;
create policy document_objects_select_own_trip
on public.document_storage_objects for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = document_storage_objects.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists invoices_select_own_trip on public.invoices;
create policy invoices_select_own_trip
on public.invoices for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = invoices.trip_id and trips.user_id = (select auth.uid())
));

drop policy if exists email_deliveries_select_own_trip on public.email_deliveries;
create policy email_deliveries_select_own_trip
on public.email_deliveries for select to authenticated
using (exists (
  select 1 from public.trips
  where trips.id = email_deliveries.trip_id and trips.user_id = (select auth.uid())
));

-- ---------------------------------------------------------------------------
-- Functions. Only the backend (service_role) can call them.

-- Numbers the invoice of a booking, or returns the one that exists. A failed invoice
-- goes back to pending so the same invoice and number are resumed. A pending invoice
-- touched within the last 30 seconds is being stored by another request: it is returned
-- with in_progress = true and the caller must wait, not write.
create or replace function public.prepare_invoice(
  p_booking_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_year integer;
  v_issued timestamptz := now();
  v_seq integer;
begin
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if v_booking.id is null or v_booking.user_id <> p_user_id then
    raise exception 'RESOURCE_NOT_FOUND';
  end if;

  select * into v_invoice from public.invoices where booking_id = p_booking_id;
  if v_invoice.id is not null then
    if v_invoice.status = 'failed' then
      -- This caller resumes the same invoice and number.
      update public.invoices set status = 'pending', pdf_error_code = null
      where id = v_invoice.id returning * into v_invoice;
    elsif v_invoice.status = 'pending' then
      if v_invoice.updated_at > timezone('utc', now()) - interval '30 seconds' then
        -- Another request is storing the PDF right now. The caller waits instead of writing.
        return jsonb_build_object('created', false, 'in_progress', true, 'invoice', to_jsonb(v_invoice));
      end if;
      -- Nobody finished it for 30 seconds (a crashed request): this caller takes it over.
      update public.invoices set pdf_error_code = null
      where id = v_invoice.id returning * into v_invoice;
    end if;
    return jsonb_build_object('created', false, 'in_progress', false, 'invoice', to_jsonb(v_invoice));
  end if;

  select * into v_payment from public.payments
  where booking_id = p_booking_id and status = 'succeeded';
  if v_payment.id is null then raise exception 'INVOICE_PAYMENT_NOT_SUCCEEDED'; end if;

  v_year := extract(year from (v_issued at time zone 'utc'))::integer;
  insert into public.invoice_number_counters (invoice_year, last_value)
  values (v_year, 1)
  on conflict (invoice_year)
  do update set last_value = public.invoice_number_counters.last_value + 1
  returning last_value into v_seq;

  insert into public.invoices (
    trip_id, user_id, booking_id, payment_id, invoice_year, sequence_number, invoice_number,
    status, currency, subtotal, tax, total, pricing_policy, issued_at
  ) values (
    v_booking.trip_id, v_booking.user_id, v_booking.id, v_payment.id, v_year, v_seq,
    'INV-' || v_year::text || '-' || lpad(v_seq::text, 6, '0'),
    'pending', v_booking.currency, v_booking.subtotal, v_booking.tax, v_booking.total,
    v_booking.pricing_policy, v_issued
  ) returning * into v_invoice;

  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (p_user_id, 'invoice.created', 'invoice', v_invoice.id,
    jsonb_build_object('trip_id', v_invoice.trip_id, 'booking_id', v_booking.id,
      'payment_id', v_payment.id, 'invoice_number', v_invoice.invoice_number));
  return jsonb_build_object('created', true, 'in_progress', false, 'invoice', to_jsonb(v_invoice));
end;
$$;

-- Records the stored PDF and issues the invoice. Calling it again with the same
-- checksum returns the issued invoice; a different checksum is refused.
create or replace function public.finalize_invoice_pdf(
  p_invoice_id uuid,
  p_object_path text,
  p_size_bytes integer,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_object public.document_storage_objects%rowtype;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
  if v_invoice.status = 'issued' then
    if v_invoice.pdf_sha256 <> p_sha256 then raise exception 'INVOICE_PDF_MISMATCH'; end if;
    return to_jsonb(v_invoice);
  end if;

  insert into public.document_storage_objects (
    trip_id, user_id, document_type, bucket, object_path, content_type, size_bytes, sha256
  ) values (
    v_invoice.trip_id, v_invoice.user_id, 'invoice_pdf', 'invoices', p_object_path,
    'application/pdf', p_size_bytes, p_sha256
  ) returning * into v_object;

  update public.invoices
  set status = 'issued', pdf_object_id = v_object.id, pdf_sha256 = p_sha256,
      pdf_size_bytes = p_size_bytes, pdf_error_code = null
  where id = v_invoice.id returning * into v_invoice;

  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (v_invoice.user_id, 'invoice.issued', 'invoice', v_invoice.id,
    jsonb_build_object('trip_id', v_invoice.trip_id, 'invoice_number', v_invoice.invoice_number,
      'pdf_sha256', p_sha256, 'pdf_size_bytes', p_size_bytes));
  return to_jsonb(v_invoice);
end;
$$;

create or replace function public.fail_invoice_pdf(
  p_invoice_id uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if p_error_code is null or char_length(trim(p_error_code)) = 0 then
    raise exception 'INVOICE_ERROR_CODE_REQUIRED';
  end if;
  update public.invoices
  set status = 'failed', pdf_error_code = left(p_error_code, 100)
  where id = p_invoice_id and status = 'pending'
  returning * into v_invoice;
  if v_invoice.id is null then
    select * into v_invoice from public.invoices where id = p_invoice_id;
    if v_invoice.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
    return to_jsonb(v_invoice);
  end if;
  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (v_invoice.user_id, 'invoice.pdf_failed', 'invoice', v_invoice.id,
    jsonb_build_object('trip_id', v_invoice.trip_id, 'error_code', v_invoice.pdf_error_code));
  return to_jsonb(v_invoice);
end;
$$;

-- Records a delivery request and queues the job that sends it, in one transaction.
-- The same dedup key returns the delivery that already exists and queues nothing.
create or replace function public.create_email_delivery(
  p_invoice_id uuid,
  p_user_id uuid,
  p_recipient text,
  p_idempotency_key text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_delivery public.email_deliveries%rowtype;
  v_dedup text;
  v_seq integer;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if v_invoice.id is null or v_invoice.user_id <> p_user_id then
    raise exception 'RESOURCE_NOT_FOUND';
  end if;
  if v_invoice.status <> 'issued' then raise exception 'INVOICE_NOT_READY'; end if;

  v_dedup := 'invoice-email:' || v_invoice.id::text || ':' || lower(p_recipient) || ':' || p_idempotency_key;
  select * into v_delivery from public.email_deliveries where dedup_key = v_dedup;
  if v_delivery.id is not null then
    return jsonb_build_object('created', false, 'delivery', to_jsonb(v_delivery));
  end if;

  select coalesce(max(sequence), 0) + 1 into v_seq
  from public.email_deliveries where invoice_id = v_invoice.id;

  insert into public.email_deliveries (
    trip_id, user_id, invoice_id, sequence, recipient_email, status, dedup_key
  ) values (
    v_invoice.trip_id, v_invoice.user_id, v_invoice.id, v_seq, p_recipient, 'pending', v_dedup
  ) returning * into v_delivery;

  insert into public.background_jobs (
    trip_id, user_id, job_type, payload, idempotency_key, correlation_id, created_by
  ) values (
    v_invoice.trip_id, v_invoice.user_id, 'send_invoice_email',
    jsonb_build_object('email_delivery_id', v_delivery.id),
    'send_invoice_email:' || v_delivery.id::text, p_correlation_id, p_user_id
  );

  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (p_user_id, 'invoice.email_requested', 'email_delivery', v_delivery.id,
    jsonb_build_object('trip_id', v_invoice.trip_id, 'invoice_id', v_invoice.id,
      'sequence', v_delivery.sequence));
  return jsonb_build_object('created', true, 'delivery', to_jsonb(v_delivery));
end;
$$;

-- Atomically takes the one attempt of a pending delivery. Returns null when the
-- delivery is not pending or an attempt already started, so a duplicate job sends nothing.
create or replace function public.claim_email_delivery(
  p_delivery_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.email_deliveries%rowtype;
begin
  update public.email_deliveries
  set provider = p_provider, attempted_at = timezone('utc', now())
  where id = p_delivery_id and status = 'pending' and attempted_at is null
  returning * into v_delivery;
  if v_delivery.id is null then return null; end if;
  return to_jsonb(v_delivery);
end;
$$;

create or replace function public.complete_email_delivery(
  p_delivery_id uuid,
  p_status text,
  p_provider_message_id text,
  p_error_code text,
  p_error_message text,
  p_attachment_sha256 text,
  p_attachment_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery public.email_deliveries%rowtype;
begin
  if p_status not in ('sent', 'failed') then raise exception 'EMAIL_STATUS_INVALID'; end if;
  update public.email_deliveries
  set status = p_status,
      provider_message_id = case when p_status = 'sent' then p_provider_message_id else null end,
      error_code = case when p_status = 'failed' then p_error_code else null end,
      error_message = case when p_status = 'failed' then left(p_error_message, 300) else null end,
      attachment_sha256 = p_attachment_sha256,
      attachment_size_bytes = p_attachment_size_bytes,
      sent_at = case when p_status = 'sent' then timezone('utc', now()) else null end,
      failed_at = case when p_status = 'failed' then timezone('utc', now()) else null end
  where id = p_delivery_id and status = 'pending' and attempted_at is not null
  returning * into v_delivery;
  if v_delivery.id is null then raise exception 'EMAIL_DELIVERY_NOT_CLAIMED'; end if;
  insert into public.activity_logs (actor_user_id, action, resource_type, resource_id, metadata)
  values (v_delivery.user_id,
    case when p_status = 'sent' then 'invoice.email_sent' else 'invoice.email_failed' end,
    'email_delivery', v_delivery.id,
    jsonb_build_object('trip_id', v_delivery.trip_id, 'invoice_id', v_delivery.invoice_id,
      'provider', v_delivery.provider, 'error_code', v_delivery.error_code));
  return to_jsonb(v_delivery);
end;
$$;

-- Queues the automatic invoice job for a booking whose payment succeeded. One job per
-- payment: the same payment never queues a second one.
create or replace function public.enqueue_invoice_generation(
  p_booking_id uuid,
  p_correlation_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_inserted integer;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then raise exception 'RESOURCE_NOT_FOUND'; end if;
  select * into v_payment from public.payments
  where booking_id = p_booking_id and status = 'succeeded';
  if v_payment.id is null then raise exception 'INVOICE_PAYMENT_NOT_SUCCEEDED'; end if;
  insert into public.background_jobs (
    trip_id, user_id, job_type, payload, idempotency_key, correlation_id, created_by
  ) values (
    v_booking.trip_id, v_booking.user_id, 'generate_invoice',
    jsonb_build_object('booking_id', v_booking.id, 'payment_id', v_payment.id),
    'generate_invoice:' || v_payment.id::text, p_correlation_id, v_booking.user_id
  ) on conflict (idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.prepare_invoice(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_invoice_pdf(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.fail_invoice_pdf(uuid, text) from public, anon, authenticated;
revoke all on function public.create_email_delivery(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_email_delivery(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_email_delivery(uuid, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.enqueue_invoice_generation(uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_invoice(uuid, uuid) to service_role;
grant execute on function public.finalize_invoice_pdf(uuid, text, integer, text) to service_role;
grant execute on function public.fail_invoice_pdf(uuid, text) to service_role;
grant execute on function public.create_email_delivery(uuid, uuid, text, text, text) to service_role;
grant execute on function public.claim_email_delivery(uuid, text) to service_role;
grant execute on function public.complete_email_delivery(uuid, text, text, text, text, text, integer) to service_role;
grant execute on function public.enqueue_invoice_generation(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- service_role reads. Writes go through the functions above.
grant select on table public.bookings to service_role;
grant select on table public.payments to service_role;
grant select on table public.event_discovery_results to service_role;
grant select on table public.place_discovery_results to service_role;
grant select on table public.invoices to service_role;
grant select on table public.document_storage_objects to service_role;
grant select on table public.email_deliveries to service_role;

comment on table public.invoices is 'Invoices issued only for succeeded dummy payments. Amounts are copied from the server-priced booking.';
comment on table public.document_storage_objects is 'References to private Storage objects (bucket invoices). Never exposed as public URLs.';
comment on table public.email_deliveries is 'One row per email attempt for an invoice. A resend is a new row; nothing retries a row.';
