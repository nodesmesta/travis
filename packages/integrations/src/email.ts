import nodemailer from "nodemailer";

/**
 * Email providers for invoice delivery.
 *
 * Exactly one provider is active per environment, chosen by `EMAIL_PROVIDER`:
 *  - `smtp`   local development; the Supabase Mailpit container.
 *  - `resend` production; the Resend HTTP API.
 * There is no fallback from one to the other and no automatic retry. Every failure
 * becomes an EmailProviderError whose code and message are safe to store and show:
 * credentials, provider response bodies, and host details are never copied into it.
 */

export type EmailProviderName = "smtp" | "resend";

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments: EmailAttachment[];
  /** Sent to providers that deduplicate (Resend) so a repeated call does not send twice. */
  idempotencyKey: string;
}

export interface SentEmail {
  provider: EmailProviderName;
  /** Id the provider gave the message (Resend id, or the SMTP Message-ID header). */
  messageId: string;
}

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(email: OutgoingEmail): Promise<SentEmail>;
}

export type EmailProviderErrorCode =
  | "EMAIL_PROVIDER_NOT_CONFIGURED"
  | "EMAIL_PROVIDER_UNREACHABLE"
  | "EMAIL_PROVIDER_TIMEOUT"
  | "EMAIL_PROVIDER_AUTH_FAILED"
  | "EMAIL_PROVIDER_RATE_LIMITED"
  | "EMAIL_PROVIDER_REJECTED"
  | "EMAIL_PROVIDER_ERROR"
  | "EMAIL_PROVIDER_RESPONSE_INVALID";

const SAFE_MESSAGES: Record<EmailProviderErrorCode, string> = {
  EMAIL_PROVIDER_NOT_CONFIGURED: "The email provider is not configured.",
  EMAIL_PROVIDER_UNREACHABLE: "The email provider could not be reached.",
  EMAIL_PROVIDER_TIMEOUT: "The email provider did not answer in time.",
  EMAIL_PROVIDER_AUTH_FAILED: "The email provider refused the credentials.",
  EMAIL_PROVIDER_RATE_LIMITED: "The email provider is limiting requests.",
  EMAIL_PROVIDER_REJECTED: "The email provider rejected the message.",
  EMAIL_PROVIDER_ERROR: "The email provider reported an error.",
  EMAIL_PROVIDER_RESPONSE_INVALID:
    "The email provider answered in an unexpected form.",
};

export class EmailProviderError extends Error {
  public readonly code: EmailProviderErrorCode;
  public readonly provider: EmailProviderName | "none";
  public readonly httpStatus: number | undefined;

  public constructor(
    code: EmailProviderErrorCode,
    provider: EmailProviderName | "none",
    httpStatus?: number,
  ) {
    super(SAFE_MESSAGES[code]);
    this.name = "EmailProviderError";
    this.code = code;
    this.provider = provider;
    this.httpStatus = httpStatus;
  }
}

export interface EmailSettings {
  provider: EmailProviderName | undefined;
  from: string | undefined;
  timeoutMs: number;
  smtpHost: string | undefined;
  smtpPort: number | undefined;
  resendApiKey: string | undefined;
  /** Replaces the Resend host. Only tests use this. */
  resendBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** True when the selected provider has everything it needs. */
export function emailConfigured(settings: EmailSettings): boolean {
  if (!settings.from) return false;
  if (settings.provider === "smtp") {
    return Boolean(settings.smtpHost) && settings.smtpPort !== undefined;
  }
  if (settings.provider === "resend") return Boolean(settings.resendApiKey);
  return false;
}

interface NodemailerFailure {
  code?: unknown;
  responseCode?: unknown;
}

function smtpFailureCode(error: unknown): EmailProviderErrorCode {
  const failure = (error ?? {}) as NodemailerFailure;
  const code = typeof failure.code === "string" ? failure.code : "";
  const response =
    typeof failure.responseCode === "number" ? failure.responseCode : 0;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return "EMAIL_PROVIDER_TIMEOUT";
  }
  if (code === "EAUTH") return "EMAIL_PROVIDER_AUTH_FAILED";
  if (code === "EENVELOPE" || (response >= 500 && response < 600)) {
    return "EMAIL_PROVIDER_REJECTED";
  }
  if (response >= 400 && response < 500) return "EMAIL_PROVIDER_ERROR";
  if (
    code === "ECONNECTION" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EDNS" ||
    code === "ESOCKET" ||
    code === "EHOSTUNREACH"
  ) {
    return "EMAIL_PROVIDER_UNREACHABLE";
  }
  return "EMAIL_PROVIDER_ERROR";
}

export class SmtpEmailProvider implements EmailProvider {
  public readonly name = "smtp" as const;

  public constructor(
    private readonly options: {
      host: string;
      port: number;
      timeoutMs: number;
    },
  ) {}

  public async send(email: OutgoingEmail): Promise<SentEmail> {
    const transport = nodemailer.createTransport({
      host: this.options.host,
      port: this.options.port,
      secure: false,
      connectionTimeout: this.options.timeoutMs,
      greetingTimeout: this.options.timeoutMs,
      socketTimeout: this.options.timeoutMs,
    });
    try {
      const info = await transport.sendMail({
        from: email.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        ...(email.html ? { html: email.html } : {}),
        attachments: email.attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: Buffer.from(attachment.content),
        })),
      });
      const accepted = Array.isArray(info.accepted) ? info.accepted : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected : [];
      if (rejected.length > 0 || accepted.length === 0) {
        throw new EmailProviderError("EMAIL_PROVIDER_REJECTED", "smtp");
      }
      if (typeof info.messageId !== "string" || info.messageId.length === 0) {
        throw new EmailProviderError("EMAIL_PROVIDER_RESPONSE_INVALID", "smtp");
      }
      return { provider: "smtp", messageId: info.messageId };
    } catch (error) {
      if (error instanceof EmailProviderError) throw error;
      throw new EmailProviderError(smtpFailureCode(error), "smtp");
    } finally {
      transport.close();
    }
  }
}

const RESEND_BASE_URL = "https://api.resend.com";

/** Resend "Send Email" (POST /emails). Attachments are Base64 strings. */
export class ResendEmailProvider implements EmailProvider {
  public readonly name = "resend" as const;

  public constructor(
    private readonly options: {
      apiKey: string;
      timeoutMs: number;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  public async send(email: OutgoingEmail): Promise<SentEmail> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl ?? RESEND_BASE_URL;
    const url = new URL("emails", base.endsWith("/") ? base : `${base}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": email.idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
          attachments: email.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: Buffer.from(attachment.content).toString("base64"),
          })),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new EmailProviderError("EMAIL_PROVIDER_TIMEOUT", "resend");
      }
      throw new EmailProviderError("EMAIL_PROVIDER_UNREACHABLE", "resend");
    }
    clearTimeout(timer);

    if (response.status === 401 || response.status === 403) {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_AUTH_FAILED",
        "resend",
        response.status,
      );
    }
    if (response.status === 429) {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_RATE_LIMITED",
        "resend",
        response.status,
      );
    }
    if (response.status >= 400 && response.status < 500) {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_REJECTED",
        "resend",
        response.status,
      );
    }
    if (!response.ok) {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_ERROR",
        "resend",
        response.status,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_RESPONSE_INVALID",
        "resend",
        response.status,
      );
    }
    const id =
      body !== null && typeof body === "object"
        ? (body as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string" || id.length === 0) {
      throw new EmailProviderError(
        "EMAIL_PROVIDER_RESPONSE_INVALID",
        "resend",
        response.status,
      );
    }
    return { provider: "resend", messageId: id };
  }
}

/** Builds the one configured provider, or throws EMAIL_PROVIDER_NOT_CONFIGURED. */
export function createEmailProvider(settings: EmailSettings): EmailProvider {
  if (!emailConfigured(settings)) {
    throw new EmailProviderError(
      "EMAIL_PROVIDER_NOT_CONFIGURED",
      settings.provider ?? "none",
    );
  }
  if (settings.provider === "smtp") {
    return new SmtpEmailProvider({
      host: settings.smtpHost as string,
      port: settings.smtpPort as number,
      timeoutMs: settings.timeoutMs,
    });
  }
  return new ResendEmailProvider({
    apiKey: settings.resendApiKey as string,
    timeoutMs: settings.timeoutMs,
    ...(settings.resendBaseUrl ? { baseUrl: settings.resendBaseUrl } : {}),
    ...(settings.fetchImpl ? { fetchImpl: settings.fetchImpl } : {}),
  });
}
