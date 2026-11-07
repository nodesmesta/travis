# State Transition Contract

State transition harus dijalankan oleh domain service, bukan frontend atau LLM secara langsung.

## Trip

```text
draft → confirmed
confirmed → active
active → completed
```

Tidak ada automatic transition dari `draft` ke `active`. Trip yang tidak valid ditolak sebelum command dijalankan.

## Context point

```text
active → archived
```

Context point yang diarsipkan tidak dapat dipakai sebagai origin, destination, atau discovery center baru.

## Agenda item

```text
suggested → planned
suggested → cancelled
planned → confirmed
planned → cancelled
confirmed → completed
confirmed → cancelled
```

Event hasil discovery tetap `suggested` sampai user melakukan confirmation command.

## Journey leg

```text
planned → in_progress
planned → cancelled
in_progress → completed
in_progress → cancelled
```

## Booking

```text
draft → pending_payment
draft → cancelled
pending_payment → paid
pending_payment → failed
pending_payment → expired
pending_payment → cancelled
paid → confirmed
paid → failed
confirmed → cancelled
confirmed → refunded
```

Aturan penting:

- `pending_payment → paid → confirmed` dijalankan dalam satu domain flow setelah payment sukses.
- Client tidak boleh menganggap `paid` sebagai final confirmation.
- Booking `confirmed` tidak dapat kembali ke `draft` atau `pending_payment`.
- Booking hanya dapat dibuat dari resource yang berada dalam trip yang sama.

## Payment

```text
pending → succeeded
pending → failed
pending → cancelled
succeeded → refunded
```

Aturan penting:

- Payment `succeeded` tidak dapat diproses ulang menjadi `succeeded` dengan payment ID yang sama.
- Payment `refunded` membutuhkan command terpisah dan activity log.
- Payment simulator tidak menerima card number, CVV, atau credential.

## Atomic booking/payment success

```text
1. Verify user ownership.
2. Verify booking = pending_payment.
3. Create or load idempotent payment.
4. Set payment = succeeded.
5. Set booking = paid.
6. Set booking = confirmed.
7. Append activity log.
8. Commit transaction.
```

Jika salah satu langkah gagal, transaksi tidak boleh menghasilkan status sukses parsial.
