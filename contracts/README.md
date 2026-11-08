# TravelFlow Contracts

Contract pack untuk Task 00.

## Files

- `openapi.yaml`: HTTP API contract versi `0.1.0`.
- `schemas/`: JSON Schema Draft 2020-12 untuk core domain dan response.
- `enums.md`: enum canonical lintas layer.
- `errors.md`: error code dan HTTP mapping.
- `state-transitions.md`: domain state machine.
- `source-freshness.md`: source, retrieval, freshness, dan expiry contract.
- `idempotency.md`: mutation idempotency dan duplicate request behavior.

## Core demo contract

```text
trip/context point
→ event discovery
→ internal booking
→ dummy payment
→ confirmed booking atau payment failure
```

## Versioning

Perubahan breaking pada field, enum, error code, atau state transition memerlukan perubahan major contract version dan review terhadap migration serta frontend.
