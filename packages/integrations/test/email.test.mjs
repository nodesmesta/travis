import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  EmailProviderError,
  ResendEmailProvider,
  SmtpEmailProvider,
  createEmailProvider,
  emailConfigured,
} from "../dist/index.js";
import { has, lacks } from "./helpers.mjs";

// FIXTURES: the Resend responses below follow the shapes documented at
// https://resend.com/docs/api-reference/emails/send-email (success: {"id": "..."};
// errors: {"statusCode", "name", "message"}). The SMTP server is a tiny in-process
// stand-in that speaks just enough SMTP for one message. None of this is a live provider.

const PDF = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10,
]);

const email = (overrides = {}) => ({
  from: "TravelFlow <noreply@travelflow.local>",
  to: "person@example.com",
  subject: "Fixture subject",
  text: "Fixture body\n",
  attachments: [
    {
      filename: "invoice-INV-2026-000001.pdf",
      contentType: "application/pdf",
      content: PDF,
    },
  ],
  idempotencyKey: "invoice-email-fixture-1",
  ...overrides,
});

function fakeFetch(status, body, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("resend: posts the documented payload and returns the provider id", async () => {
  const capture = {};
  const provider = new ResendEmailProvider({
    apiKey: "re_fixture_key",
    timeoutMs: 1000,
    fetchImpl: fakeFetch(
      200,
      { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" },
      capture,
    ),
  });
  const sent = await provider.send(email());
  assert.deepEqual(sent, {
    provider: "resend",
    messageId: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
  });
  assert.equal(capture.url, "https://api.resend.com/emails");
  assert.equal(capture.init.method, "POST");
  assert.equal(capture.init.headers.authorization, "Bearer re_fixture_key");
  assert.equal(
    capture.init.headers["idempotency-key"],
    "invoice-email-fixture-1",
  );
  const body = JSON.parse(capture.init.body);
  assert.deepEqual(body.to, ["person@example.com"]);
  assert.equal(body.from, "TravelFlow <noreply@travelflow.local>");
  assert.equal(body.attachments.length, 1);
  assert.equal(body.attachments[0].filename, "invoice-INV-2026-000001.pdf");
  assert.deepEqual(
    [...Buffer.from(body.attachments[0].content, "base64")],
    [...PDF],
  );
});

test("resend: every failure becomes a safe provider error and nothing is retried", async () => {
  const cases = [
    [
      401,
      { statusCode: 401, name: "missing_api_key", message: "secret re_x" },
      "EMAIL_PROVIDER_AUTH_FAILED",
    ],
    [
      403,
      { statusCode: 403, name: "invalid_api_key", message: "m" },
      "EMAIL_PROVIDER_AUTH_FAILED",
    ],
    [
      422,
      {
        statusCode: 422,
        name: "validation_error",
        message: "bad to: person@example.com",
      },
      "EMAIL_PROVIDER_REJECTED",
    ],
    [
      429,
      { statusCode: 429, name: "rate_limit_exceeded", message: "m" },
      "EMAIL_PROVIDER_RATE_LIMITED",
    ],
    [
      500,
      { statusCode: 500, name: "application_error", message: "m" },
      "EMAIL_PROVIDER_ERROR",
    ],
    [200, { unexpected: true }, "EMAIL_PROVIDER_RESPONSE_INVALID"],
  ];
  for (const [status, body, code] of cases) {
    let calls = 0;
    const provider = new ResendEmailProvider({
      apiKey: "re_fixture_key",
      timeoutMs: 1000,
      fetchImpl: async (...args) => {
        calls += 1;
        return fakeFetch(status, body)(...args);
      },
    });
    await assert.rejects(
      () => provider.send(email()),
      (error) => {
        assert.ok(error instanceof EmailProviderError);
        assert.equal(error.code, code);
        assert.equal(error.provider, "resend");
        lacks(error.message, "re_x");
        lacks(error.message, "person@example.com");
        lacks(error.message, "re_fixture_key");
        return true;
      },
      `status ${status}`,
    );
    assert.equal(calls, 1, "no automatic retry");
  }
});

test("resend: a network failure and a timeout are reported with their own codes", async () => {
  const down = new ResendEmailProvider({
    apiKey: "k",
    timeoutMs: 1000,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(
    () => down.send(email()),
    (error) => error.code === "EMAIL_PROVIDER_UNREACHABLE",
  );
  const slow = new ResendEmailProvider({
    apiKey: "k",
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          reject(abort);
        });
      }),
  });
  await assert.rejects(
    () => slow.send(email()),
    (error) => error.code === "EMAIL_PROVIDER_TIMEOUT",
  );
});

test("configuration: one provider, nothing configured means a clear error", () => {
  const base = {
    from: "a@b.co",
    timeoutMs: 1000,
    smtpHost: undefined,
    smtpPort: undefined,
    resendApiKey: undefined,
  };
  assert.equal(emailConfigured({ ...base, provider: undefined }), false);
  assert.equal(emailConfigured({ ...base, provider: "resend" }), false);
  assert.equal(
    emailConfigured({ ...base, provider: "resend", resendApiKey: "k" }),
    true,
  );
  assert.equal(emailConfigured({ ...base, provider: "smtp" }), false);
  assert.equal(
    emailConfigured({ ...base, provider: "smtp", smtpHost: "h", smtpPort: 25 }),
    true,
  );
  assert.equal(
    emailConfigured({
      ...base,
      from: undefined,
      provider: "resend",
      resendApiKey: "k",
    }),
    false,
  );
  assert.throws(
    () => createEmailProvider({ ...base, provider: "resend" }),
    (error) => error.code === "EMAIL_PROVIDER_NOT_CONFIGURED",
  );
  assert.equal(
    createEmailProvider({ ...base, provider: "resend", resendApiKey: "k" })
      .name,
    "resend",
  );
  assert.equal(
    createEmailProvider({
      ...base,
      provider: "smtp",
      smtpHost: "h",
      smtpPort: 25,
    }).name,
    "smtp",
  );
});

/** Minimal SMTP server: accepts one message, stores the DATA section. */
function fakeSmtp({ rejectRecipient = false } = {}) {
  const received = { data: "", recipients: [] };
  const server = createServer((socket) => {
    let inData = false;
    let buffer = "";
    socket.write("220 fixture ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 OK queued\r\n");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") socket.write("250 fixture\r\n");
        else if (verb === "MAIL") socket.write("250 OK\r\n");
        else if (verb === "RCPT") {
          received.recipients.push(line);
          socket.write(rejectRecipient ? "550 no such user\r\n" : "250 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

test("smtp: sends the message with the PDF attached", async () => {
  const smtp = await fakeSmtp();
  try {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: smtp.port,
      timeoutMs: 3000,
    });
    const sent = await provider.send(email());
    assert.equal(sent.provider, "smtp");
    assert.ok(sent.messageId.length > 0);
    has(smtp.received.data, "Subject: Fixture subject");
    has(smtp.received.data, "filename=invoice-INV-2026-000001.pdf");
    has(smtp.received.data, "application/pdf");
    has(smtp.received.data, Buffer.from(PDF).toString("base64"));
    assert.equal(smtp.received.recipients.length, 1);
  } finally {
    await smtp.close();
  }
});

test("smtp: a closed port is EMAIL_PROVIDER_UNREACHABLE", async () => {
  const probe = await fakeSmtp();
  const port = probe.port;
  await probe.close();
  const provider = new SmtpEmailProvider({
    host: "127.0.0.1",
    port,
    timeoutMs: 2000,
  });
  await assert.rejects(
    () => provider.send(email()),
    (error) => {
      assert.ok(error instanceof EmailProviderError);
      assert.equal(error.code, "EMAIL_PROVIDER_UNREACHABLE");
      lacks(error.message, "127.0.0.1");
      return true;
    },
  );
});

test("smtp: a refused recipient is EMAIL_PROVIDER_REJECTED", async () => {
  const smtp = await fakeSmtp({ rejectRecipient: true });
  try {
    const provider = new SmtpEmailProvider({
      host: "127.0.0.1",
      port: smtp.port,
      timeoutMs: 3000,
    });
    await assert.rejects(
      () => provider.send(email()),
      (error) => error.code === "EMAIL_PROVIDER_REJECTED",
    );
  } finally {
    await smtp.close();
  }
});
