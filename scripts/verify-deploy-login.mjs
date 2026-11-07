// Browser check used by scripts/verify-deploy-local.sh.
//
//   node scripts/verify-deploy-login.mjs http://127.0.0.1:8088
//
// Opens the deployed web page in headless Chromium without a session and waits
// for the login screen (#login-title). The page is a client component: the
// server HTML only holds the "Checking your session" shell, so the login form
// exists only after the browser bundle has run with its NEXT_PUBLIC_* values.
// Exit code 0 when the login screen appears and every request stayed on the
// given origin; 1 otherwise.

import { chromium } from "playwright";

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: node scripts/verify-deploy-login.mjs <origin>");
  process.exit(1);
}
const origin = new URL(target).origin;

const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  const foreign = [];
  const pageErrors = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== origin) {
      foreign.push(url.origin);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(origin, { waitUntil: "load", timeout: 30_000 });
  await page.waitForSelector("#login-title", { timeout: 20_000 });
  const heading = (await page.textContent("#login-title")) ?? "";
  const passwordField = await page.locator('input[type="password"]').count();

  if (passwordField < 1) {
    console.error("login form has no password field");
    failed = true;
  }
  if (foreign.length > 0) {
    console.error(
      `requests left the origin: ${[...new Set(foreign)].join(", ")}`,
    );
    failed = true;
  }
  if (pageErrors.length > 0) {
    console.error(`page errors: ${pageErrors.join(" | ")}`);
    failed = true;
  }
  if (!failed) console.log(`login screen rendered: "${heading.trim()}"`);
} catch (error) {
  console.error(
    `login screen did not render: ${error instanceof Error ? error.message : "unknown"}`,
  );
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
