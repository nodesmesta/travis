// Container health probe. Usage: node deploy/healthcheck.mjs <url>
// Exit 0 only for HTTP 200. Any other status, timeout, or connection error
// exits 1 and prints the reason (Docker keeps it in `docker inspect` health logs).
// No regular expressions.

const url = process.argv[2];
if (url === undefined || url === "") {
  process.stderr.write("healthcheck: url argument is required\n");
  process.exit(1);
}

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (response.status !== 200) {
    process.stderr.write(`healthcheck: ${url} returned ${response.status}\n`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`healthcheck: ${url} failed: ${reason}\n`);
  process.exit(1);
}
