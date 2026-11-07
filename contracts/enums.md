# Canonical Enums

Semua enum pada API, domain, dan database harus mengikuti daftar ini. Penambahan enum memerlukan perubahan contract version.

## Trip

```text
draft
confirmed
active
completed
```

## Context point

```text
airport
station
hotel
meeting
conference
event
restaurant
attraction
custom_location
```

Context point status:

```text
active
archived
```

Resolution status:

```text
resolved
ambiguous
unresolved
```

Confirmation status:

```text
unconfirmed
confirmed
```

`status`, `resolution_status`, dan `confirmation_status` memiliki arti terpisah. `archived` berarti lokasi tidak lagi aktif; `ambiguous` atau `unresolved` berarti lokasi belum dapat dipakai sebagai fakta terverifikasi.

## Agenda item

```text
suggested
planned
confirmed
cancelled
completed
skipped
```

## Journey leg

```text
planned
in_progress
completed
cancelled
```

## Booking

```text
draft
pending_payment
paid
confirmed
cancelled
expired
failed
```

`confirmed` hanya dapat dicapai setelah payment `succeeded`. `paid` adalah state internal setelah payment sukses sebelum command confirmation selesai.

## Payment

```text
pending
succeeded
failed
cancelled
refunded
```

## Event result

```text
suggested
selected
rejected
expired
```

## Freshness

```text
fresh
expired
unavailable
```

## Source kind

```text
provider
official_page
search_result
user_input
internal
```

## Execution

```text
received
context_loading
context_resolving
awaiting_clarification
planning
plan_validating
tool_executing
synthesizing
response_validating
completed
failed
cancelled
```

## Error category

```text
validation
authentication
authorization
not_found
conflict
provider
persistence
internal
```
