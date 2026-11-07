# Source dan Freshness Contract

Setiap informasi eksternal yang ditampilkan atau digunakan untuk recommendation harus memiliki source dan retrieval metadata.

## Source object

```json
{
  "id": "source_123",
  "kind": "official_page",
  "provider": "bright_data",
  "url": "https://example.com/event",
  "title": "Official event page",
  "retrieved_at": "2026-11-06T10:00:00Z",
  "observed_for": {
    "from": "2026-11-12T18:00:00+07:00",
    "to": "2026-11-12T23:00:00+07:00",
    "timezone": "Asia/Jakarta"
  },
  "freshness": "fresh",
  "expires_at": "2026-11-06T22:00:00Z"
}
```

## Required fields

- `id`
- `kind`
- `provider`
- `retrieved_at`
- `freshness`
- `expires_at` jika data memiliki TTL

`url` wajib untuk provider web atau official page. Data `internal` atau `user_input` dapat tidak memiliki URL.

## Initial TTL policy

| Data                |    TTL awal | Expired behavior                           |
| ------------------- | ----------: | ------------------------------------------ |
| Event detail        |    6–24 jam | Tidak digunakan untuk live response baru   |
| Traffic             |  5–15 menit | Request gagal jika traffic wajib           |
| Route estimate      |  5–20 menit | Provider dipanggil ulang pada request baru |
| Weather current     | 15–30 menit | Tidak ditampilkan sebagai current          |
| Weather forecast    | 30–60 menit | Tidak digunakan untuk recommendation baru  |
| Static place detail |    1–7 hari | Refresh sebelum digunakan                  |

## Rules

- `expired` boleh disimpan untuk audit, tetapi tidak boleh menjadi response live baru.
- `unavailable` berarti provider tidak menyediakan fakta yang diperlukan.
- `freshness` ditentukan backend dari `retrieved_at` dan `expires_at`.
- LLM tidak boleh mengubah source, timestamp, expiry, atau freshness.
- Recommendation harus menyimpan source IDs, retrieval time, expiry, dan policy version.
