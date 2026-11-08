/**
 * In-process metrics in the Prometheus text format. They are counters and
 * histograms kept in memory: they reset when the process restarts, and each
 * instance reports only itself. Labels have low cardinality on purpose (an id
 * in a path becomes `:id`).
 */

const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function isIdSegment(segment: string): boolean {
  if (segment.length === 36) {
    let hyphens = 0;
    for (const char of segment) if (char === "-") hyphens += 1;
    if (hyphens === 4) return true;
  }
  return segment.length > 24;
}

/** `/api/v1/trips/<uuid>/bookings` becomes `/api/v1/trips/:id/bookings`. */
export function routeLabel(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => (isIdSegment(segment) ? ":id" : segment))
    .join("/");
}

function escapeLabel(value: string): string {
  return value
    .split("\\")
    .join("\\\\")
    .split('"')
    .join('\\"')
    .split("\n")
    .join("\\n");
}

function labels(values: Record<string, string>): string {
  const parts = Object.entries(values).map(
    ([key, value]) => `${key}="${escapeLabel(value)}"`,
  );
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

export class Metrics {
  private readonly started = Date.now();
  private readonly requests = new Map<string, number>();
  private readonly durationBuckets = new Map<string, number[]>();
  private readonly durationSum = new Map<string, number>();
  private readonly durationCount = new Map<string, number>();
  private readonly providerErrors = new Map<string, number>();

  public recordRequest(input: {
    method: string;
    route: string;
    status: number;
    seconds: number;
  }): void {
    const statusClass = `${Math.floor(input.status / 100)}xx`;
    const requestKey = JSON.stringify([input.method, input.route, statusClass]);
    this.requests.set(requestKey, (this.requests.get(requestKey) ?? 0) + 1);

    const durationKey = JSON.stringify([input.method, input.route]);
    const buckets =
      this.durationBuckets.get(durationKey) ??
      DURATION_BUCKETS_SECONDS.map(() => 0);
    DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      if (input.seconds <= bound) buckets[index] = (buckets[index] ?? 0) + 1;
    });
    this.durationBuckets.set(durationKey, buckets);
    this.durationSum.set(
      durationKey,
      (this.durationSum.get(durationKey) ?? 0) + input.seconds,
    );
    this.durationCount.set(
      durationKey,
      (this.durationCount.get(durationKey) ?? 0) + 1,
    );
  }

  public recordProviderError(provider: string, code: string): void {
    const key = JSON.stringify([provider, code]);
    this.providerErrors.set(key, (this.providerErrors.get(key) ?? 0) + 1);
  }

  public render(memory: NodeJS.MemoryUsage = process.memoryUsage()): string {
    const lines: string[] = [];
    lines.push(
      "# HELP travelflow_http_requests_total HTTP requests by method, route, and status class.",
      "# TYPE travelflow_http_requests_total counter",
    );
    for (const [key, value] of this.requests) {
      const [method, route, statusClass] = JSON.parse(key) as string[];
      lines.push(
        `travelflow_http_requests_total${labels({ method: method as string, route: route as string, status: statusClass as string })} ${value}`,
      );
    }
    lines.push(
      "# HELP travelflow_http_request_duration_seconds HTTP request duration.",
      "# TYPE travelflow_http_request_duration_seconds histogram",
    );
    for (const [key, buckets] of this.durationBuckets) {
      const [method, route] = JSON.parse(key) as string[];
      const base = { method: method as string, route: route as string };
      DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(
          `travelflow_http_request_duration_seconds_bucket${labels({ ...base, le: String(bound) })} ${buckets[index] ?? 0}`,
        );
      });
      lines.push(
        `travelflow_http_request_duration_seconds_bucket${labels({ ...base, le: "+Inf" })} ${this.durationCount.get(key) ?? 0}`,
        `travelflow_http_request_duration_seconds_sum${labels(base)} ${this.durationSum.get(key) ?? 0}`,
        `travelflow_http_request_duration_seconds_count${labels(base)} ${this.durationCount.get(key) ?? 0}`,
      );
    }
    lines.push(
      "# HELP travelflow_provider_errors_total Provider failures by provider and error code.",
      "# TYPE travelflow_provider_errors_total counter",
    );
    for (const [key, value] of this.providerErrors) {
      const [provider, code] = JSON.parse(key) as string[];
      lines.push(
        `travelflow_provider_errors_total${labels({ provider: provider as string, code: code as string })} ${value}`,
      );
    }
    lines.push(
      "# HELP travelflow_process_uptime_seconds Seconds since the process started.",
      "# TYPE travelflow_process_uptime_seconds gauge",
      `travelflow_process_uptime_seconds ${Math.round((Date.now() - this.started) / 1000)}`,
      "# HELP travelflow_process_resident_memory_bytes Resident set size.",
      "# TYPE travelflow_process_resident_memory_bytes gauge",
      `travelflow_process_resident_memory_bytes ${memory.rss}`,
      "# HELP travelflow_process_heap_used_bytes Heap in use.",
      "# TYPE travelflow_process_heap_used_bytes gauge",
      `travelflow_process_heap_used_bytes ${memory.heapUsed}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
