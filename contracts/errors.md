# Error Contract

Semua error API menggunakan envelope yang sama. Error yang ditampilkan ke client harus aman dan tidak boleh berisi secret, raw provider payload, SQL, atau stack trace.

## HTTP mapping

| HTTP | Kategori         | Penggunaan                                                     |
| ---: | ---------------- | -------------------------------------------------------------- |
|  400 | `validation`     | Request schema, field, timezone, atau state input invalid      |
|  401 | `authentication` | Access token tidak ada atau tidak valid                        |
|  403 | `authorization`  | Resource bukan milik user atau action tidak diizinkan          |
|  404 | `not_found`      | Resource tidak ditemukan dalam ownership scope                 |
|  409 | `conflict`       | Idempotency conflict, duplicate, atau invalid state transition |
|  422 | `validation`     | Request valid secara bentuk tetapi tidak valid secara domain   |
|  429 | `provider`       | Rate/concurrency limit tercapai                                |
|  502 | `provider`       | Provider gagal atau mengembalikan response invalid             |
|  504 | `provider`       | Provider timeout                                               |
|  500 | `internal`       | Error internal yang tidak aman untuk dirinci                   |
|  503 | `internal`       | Dependency internal wajib belum dikonfigurasi                  |

## Envelope

```json
{
  "error": {
    "code": "BOOKING_STATE_INVALID",
    "category": "conflict",
    "message": "Booking cannot accept payment in its current state.",
    "request_id": "req_123",
    "details": {
      "resource_type": "booking",
      "resource_id": "booking_123"
    }
  }
}
```

`request_id` wajib ada. `execution_id` ditambahkan jika request menjalankan orchestration atau background execution.

## Canonical error codes

### Request dan auth

```text
REQUEST_INVALID
AUTH_TOKEN_MISSING
AUTH_TOKEN_INVALID
AUTH_CONFIGURATION_MISSING
OWNERSHIP_DENIED
RESOURCE_NOT_FOUND
IDEMPOTENCY_KEY_REQUIRED
IDEMPOTENCY_CONFLICT
```

### Context dan domain

```text
TRIP_INVALID_STATE
CONTEXT_POINT_INVALID
CONTEXT_POINT_AMBIGUOUS
CONTEXT_POINT_UNRESOLVED
TIMEZONE_INVALID
AGENDA_INVALID
JOURNEY_LEG_INVALID
DOMAIN_STATE_INVALID
```

### External data

```text
EXTERNAL_QUERY_INVALID
EXTERNAL_CONTEXT_UNRESOLVED
EXTERNAL_TIMEZONE_MISSING
EXTERNAL_PROVIDER_ERROR
EXTERNAL_PROVIDER_TIMEOUT
EXTERNAL_PROVIDER_REJECTED
EXTERNAL_PROVIDER_RATE_LIMITED
EXTERNAL_MODEL_MISMATCH
EXTERNAL_RESPONSE_INVALID
EXTERNAL_EMPTY_RESULT
EXTERNAL_RESULT_EXPIRED
EXTERNAL_SOURCE_MISSING
```

### Booking dan payment

```text
BOOKING_INVALID
BOOKING_STATE_INVALID
BOOKING_RESOURCE_MISMATCH
BOOKING_ALREADY_EXISTS
PAYMENT_INVALID
PAYMENT_STATE_INVALID
PAYMENT_SIMULATION_INVALID
PAYMENT_PROVIDER_ERROR
PAYMENT_DUPLICATE
```

### Alert dan background job

```text
JOB_RERUN_NOT_ALLOWED
JOB_RERUN_ALREADY_ACTIVE
```

Kode berikut dicatat pada `background_jobs.error_code` oleh worker dan tidak dikirim sebagai error HTTP: `JOB_PAYLOAD_INVALID`, `JOB_CONTEXT_NOT_FOUND`, `JOB_CONTEXT_UNRESOLVED`, `JOB_PRECONDITION_FAILED`, `JOB_PROVIDER_ERROR` (kode provider asli ada di `result_summary.provider_error_code`), `JOB_PROVIDER_DATA_EXPIRED`, `JOB_ALERT_PERSISTENCE_ERROR`, `JOB_INTERRUPTED`, `JOB_TIMEOUT`, `JOB_INTERNAL_ERROR`.

### Persistence dan execution

```text
PERSISTENCE_ERROR
PERSISTENCE_CONFLICT
EXECUTION_TIMEOUT
EXECUTION_CANCELLED
RESPONSE_SCHEMA_INVALID
INTERNAL_ERROR
```

## Rules

- Error code stabil menjadi bagian contract.
- Message boleh diperbaiki tanpa mengubah code dan category.
- Provider detail disimpan pada server-side diagnostic metadata, bukan response publik.
- Error tidak boleh dikonversi menjadi empty success.
- Retry otomatis tidak dilakukan pada MVP.
