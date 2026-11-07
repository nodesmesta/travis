import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEventDiscoveryQuery,
  parseSearchCandidates,
  EVENT_PIPELINE_VERSION,
} from "../dist/index.js";
import { input } from "./fixtures.mjs";
import { has, lacks } from "./helpers.mjs";

test("query asks for Full JSON explicitly and reads naturally", () => {
  const query = buildEventDiscoveryQuery(input());
  const url = new URL(query.searchUrl);
  assert.equal(url.searchParams.get("brd_json"), "1");
  assert.equal(url.searchParams.get("hl"), "en");
  const q = url.searchParams.get("q");
  has(q, "Jakarta Convention Center");
  has(q, "business events");
  has(q, "12 November 2026");
  lacks(q, "business_events");
});

test("fingerprint ignores request IDs and changes with the pipeline version", () => {
  const first = buildEventDiscoveryQuery(input());
  const second = buildEventDiscoveryQuery(
    input({ requestId: "request-2", executionId: "execution-2" }),
  );
  assert.equal(first.fingerprint, second.fingerprint);
  const other = buildEventDiscoveryQuery(
    input({ filters: { category: "concerts" } }),
  );
  assert.notEqual(first.fingerprint, other.fingerprint);
  const versionPrefix = "serp-pages-llm-v";
  assert.ok(EVENT_PIPELINE_VERSION.startsWith(versionPrefix));
  const versionNumber = EVENT_PIPELINE_VERSION.slice(versionPrefix.length);
  assert.ok(
    versionNumber.length > 0 &&
      [...versionNumber].every((c) => c >= "0" && c <= "9"),
  );
});

test("query rejects a window without a timezone offset", () => {
  assert.throws(
    () =>
      buildEventDiscoveryQuery(
        input({
          observedFor: {
            from: "2026-11-12T18:00:00",
            to: "2026-11-12T23:00:00",
            timezone: "Asia/Jakarta",
          },
        }),
      ),
    (error) => error.code === "EXTERNAL_QUERY_INVALID",
  );
});

test("search candidates skip redirects, social networks, files, and duplicates", () => {
  const result = parseSearchCandidates(
    {
      organic: [
        {
          title: "Schedule",
          link: "https://www.jcc.co.id/schedule-of-events#top",
        },
        {
          title: "Schedule again",
          link: "https://www.jcc.co.id/schedule-of-events/",
        },
        { title: "Wrapped", link: "https://www.google.com/goto?url=CAES" },
        { title: "Insta", link: "https://www.instagram.com/balaisidangjcc/" },
        { title: "Brochure", link: "https://example.com/files/brochure.pdf" },
        { title: "", link: "https://example.com/untitled" },
        { title: "Broken", link: "not a url" },
        { title: "Forum", link: "https://forum.example/events" },
      ],
    },
    5,
  );
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.url),
    [
      "https://www.jcc.co.id/schedule-of-events",
      "https://forum.example/events",
    ],
  );
  assert.equal(result.returned, 8);
  assert.equal(result.limitations.length, 4);
});

test("search candidates respect the page limit", () => {
  const organic = Array.from({ length: 9 }, (_, index) => ({
    title: `Page ${index}`,
    link: `https://site${index}.example/events`,
  }));
  assert.equal(parseSearchCandidates({ organic }, 3).candidates.length, 3);
});

test("a search answer without parsed organic results is invalid, not empty", () => {
  for (const raw of [
    { status_code: 200, headers: {}, body: "<html></html>" },
    "<html></html>",
    null,
    { organic: "nope" },
  ]) {
    assert.throws(
      () => parseSearchCandidates(raw, 5),
      (error) => error.code === "EXTERNAL_RESPONSE_INVALID",
    );
  }
  assert.equal(parseSearchCandidates({ organic: [] }, 5).returned, 0);
});
