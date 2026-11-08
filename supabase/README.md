# Supabase Database Foundation

Task 02 dan Task 03 menyediakan migration dan seed untuk identity, trip, context point, agenda, journey leg, idempotency, dan activity log.

## Migration order

```text
0001_identity_and_trips.sql
0002_context_points.sql
0003_agenda_and_journey_legs.sql
0004_idempotency_and_activity_logs.sql
0005_event_discovery.sql
0006_booking_and_dummy_payment.sql
0007_mobility_weather_and_places.sql
0008_conversations_and_confirmations.sql
0009_background_jobs_and_alerts.sql
0010_invoices_documents_and_email.sql
```

Setiap migration dimiliki satu task (lihat tabel Migration boundary di `plan/segments/07-persistence-cache.md`). Tidak ada regex di SQL: constraint memakai `left()`, `translate()`, dan `char_length()`.

## Apply locally

Jalankan migration melalui Supabase CLI atau database migration runner yang digunakan deployment. Jangan menjalankan file migration secara manual tanpa mencatat hasilnya.

## Runtime boundaries

- `apps/api/src/supabase/client.ts` creates a server-only admin client and a user-scoped client that forwards the user's access token so database queries remain subject to RLS.
- `apps/api/src/repositories/trip-context-repository.ts` is the API persistence boundary. It filters trips by authenticated `user_id` and maps database snake_case rows to domain records.
- `apps/api/src/repositories/domain-persistence.ts` implements user-scoped command idempotency replay and append-only activity log writes.


`seed.sql` mencari user Auth dengan email `demo@travelflow.local`. Seed tidak membuat password atau memasukkan baris langsung ke `auth.users`.

Urutan demo lokal:

1. `supabase start`
2. `npm run db:reset:local` (opsional, untuk clean state; menghapus semua data lokal)
3. `npm run bootstrap:local`

`bootstrap:local` membuat atau menyamakan user demo lewat Supabase Auth Admin API, menjalankan `seed.sql`, memverifikasi login dan trip demo, lalu menulis `.env.local`. Script menolak berjalan jika URL Supabase bukan loopback. Seed tetap tidak membuat password.

Seed menggunakan UUID tetap, memeriksa collision ownership sebelum upsert, dan memakai `on conflict`, sehingga dapat dijalankan ulang tanpa membuat trip atau context point ganda atau memindahkan resource milik user lain.


## Ownership model

- `profiles.id` mengacu ke `auth.users.id`.
- `trips.user_id` mengacu ke `auth.users.id`.
- `context_points.trip_id` mengacu ke `trips.id`.
- RLS context point memeriksa ownership melalui relasi context point → trip → user.
- Backend tetap wajib melakukan authorization sebelum query atau mutation.
