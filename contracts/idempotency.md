# Idempotency Contract

Mutation yang dapat membuat atau mengubah resource wajib menerima header:

```text
Idempotency-Key: <client-generated-opaque-key>
```

## Required operations

- Create trip jika client melakukan retry.
- Create context point.
- Confirm agenda/event.
- Create booking.
- Simulate payment.
- Create alert.
- Generate invoice.
- Send email delivery.

## Storage identity

Idempotency record minimal menyimpan:

```text
user_id
scope
idempotency_key
request_hash
response_status
response_body_reference
created_at
expires_at
```

Unique key:

```text
(user_id, scope, idempotency_key)
```

`scope` harus membedakan endpoint dan resource parent. Contoh:

```text
booking.create:trip_123
payment.simulate:booking_123
```

## Behavior

1. Request pertama diproses dan hasilnya disimpan.
2. Request ulang dengan key dan payload yang sama mengembalikan hasil tersimpan.
3. Request ulang dengan key yang sama tetapi payload berbeda mengembalikan `IDEMPOTENCY_CONFLICT`.
4. Request yang sedang diproses tidak membuat resource kedua.
5. Idempotency tidak berarti automatic retry provider.
6. Client tidak boleh memakai ulang key untuk operasi bisnis yang berbeda.

## Payment-specific rules

- Payment simulator wajib idempotent berdasarkan booking dan idempotency key.
- Payment `succeeded` tidak boleh dibuat kedua kali untuk booking yang sama tanpa refund/recovery command.
- Request payment yang sama harus mengembalikan payment result yang sama.
