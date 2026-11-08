export function input(overrides = {}) {
  return {
    requestId: "request-1",
    executionId: "execution-1",
    tripId: "trip-1",
    contextPointId: "context-1",
    contextLabel: "Jakarta Convention Center",
    contextAddress: "Jl. Gatot Subroto, Jakarta",
    observedFor: {
      from: "2026-11-12T18:00:00+07:00",
      to: "2026-11-12T23:00:00+07:00",
      timezone: "Asia/Jakarta",
    },
    filters: { category: "business_events" },
    ...overrides,
  };
}
