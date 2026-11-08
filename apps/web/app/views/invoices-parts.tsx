"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ApiClientError } from "../../lib/api";
import {
  downloadInvoicePdf,
  generateInvoice,
  listEmailDeliveries,
  requestInvoiceEmail,
} from "../../lib/api-invoices";
import type { Booking } from "../../lib/types";
import type {
  BookingInvoiceState,
  EmailDeliveryView,
  InvoiceView,
} from "../../lib/types-invoices";

const POLL_MS = 2500;

const BOOKING_LABEL: Record<Booking["booking_type"], string> = {
  event: "Event booking",
  activity: "Activity booking",
  itinerary_item: "Itinerary item booking",
  hotel: "Hotel booking",
  flight: "Flight booking",
};

export function invoiceError(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.requestId
      ? `${error.message} (reference ${error.requestId.slice(0, 8)})`
      : error.message;
  }
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

export function formatMoney(currency: string, amount: number): string {
  return `${currency} ${new Intl.NumberFormat("en-US").format(amount)}`;
}

function formatWhen(value: string | null, timezone: string): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(value));
}

const PAYMENT_TEXT: Record<InvoiceView["payment_status"], string> = {
  pending: "Pending",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

function pdfStatusText(
  invoice: InvoiceView | null,
  eligible: boolean,
): { text: string; tone: "ok" | "wait" | "bad" | "idle" } {
  if (!invoice) {
    return eligible
      ? { text: "Not generated yet", tone: "idle" }
      : { text: "Not available", tone: "idle" };
  }
  if (invoice.status === "issued") return { text: "PDF ready", tone: "ok" };
  if (invoice.status === "pending") {
    return { text: "Preparing the PDF…", tone: "wait" };
  }
  return {
    text: `PDF failed${invoice.error_code ? ` (${invoice.error_code})` : ""}`,
    tone: "bad",
  };
}

function deliveryText(delivery: EmailDeliveryView): string {
  if (delivery.status === "pending") return "Sending…";
  if (delivery.status === "sent") return "Sent";
  return "Failed";
}

function DeliveryRow({
  delivery,
  timezone,
}: {
  delivery: EmailDeliveryView;
  timezone: string;
}) {
  const when =
    delivery.sent_at ?? delivery.failed_at ?? delivery.requested_at ?? null;
  return (
    <li className={`inv-delivery ${delivery.status}`}>
      <div>
        <strong>
          #{delivery.sequence} · {delivery.recipient_email}
        </strong>
        <span className="inv-delivery-status">{deliveryText(delivery)}</span>
      </div>
      <small>
        {delivery.status === "pending"
          ? `Requested ${formatWhen(delivery.requested_at, timezone)}`
          : formatWhen(when, timezone)}
        {delivery.provider ? ` · via ${delivery.provider}` : ""}
      </small>
      {delivery.status === "failed" ? (
        <p className="inv-delivery-error" role="status">
          This email was not delivered
          {delivery.error_message ? `: ${delivery.error_message}` : "."} Your
          booking, payment, and invoice are not affected. Use “Send again” to
          make a new request.
        </p>
      ) : null}
    </li>
  );
}

/**
 * One booking with a succeeded payment: its invoice, the PDF, and the email deliveries.
 * Email problems stay inside this card. The booking and payment lines never depend on
 * the state of an email.
 */
export function InvoiceCard({
  tripId,
  timezone,
  booking,
  state,
  onChanged,
}: {
  tripId: string;
  timezone: string;
  booking: Booking;
  state: BookingInvoiceState;
  onChanged: () => Promise<void>;
}) {
  const invoice = state.invoice;
  const [busy, setBusy] = useState<"generate" | "download" | "email" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [deliveries, setDeliveries] = useState<EmailDeliveryView[] | null>(
    null,
  );
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const alive = useRef(true);
  const headingId = `invoice-${booking.id}`;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invoiceId = invoice?.status === "issued" ? invoice.id : null;
  const loadDeliveries = useCallback(async () => {
    if (!invoiceId) return;
    try {
      const result = await listEmailDeliveries(tripId, invoiceId);
      if (!alive.current) return;
      setDeliveries(result.items);
      setDeliveriesError(null);
    } catch (caught) {
      if (alive.current) setDeliveriesError(invoiceError(caught));
    }
  }, [tripId, invoiceId]);

  useEffect(() => {
    setDeliveries(null);
    void loadDeliveries();
  }, [loadDeliveries]);

  const hasPending = (deliveries ?? []).some((d) => d.status === "pending");
  useEffect(() => {
    if (!hasPending) return undefined;
    const timer = window.setInterval(() => void loadDeliveries(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasPending, loadDeliveries]);

  // A PDF that is still being prepared is checked again until it is ready or failed.
  const invoicePending = invoice?.status === "pending";
  useEffect(() => {
    if (!invoicePending) return undefined;
    const timer = window.setInterval(() => void onChanged(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [invoicePending, onChanged]);

  async function generate() {
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      await generateInvoice(tripId, booking.id);
      setNotice("The invoice was issued.");
      await onChanged();
    } catch (caught) {
      setError(invoiceError(caught));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function download() {
    if (!invoice) return;
    setBusy("download");
    setError(null);
    setNotice(null);
    try {
      await downloadInvoicePdf(invoice);
      setNotice("The PDF download started.");
    } catch (caught) {
      setError(invoiceError(caught));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function sendEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invoice) return;
    setBusy("email");
    setError(null);
    setNotice(null);
    try {
      const result = await requestInvoiceEmail(tripId, invoice.id, recipient);
      setNotice(
        `The email to ${result.delivery.recipient_email} was queued. The status below updates by itself.`,
      );
      await loadDeliveries();
    } catch (caught) {
      setError(invoiceError(caught));
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const pdf = pdfStatusText(invoice, state.eligible);
  const payment = state.payment;
  const first = (deliveries ?? []).length === 0;
  const title = invoice?.item_title ?? BOOKING_LABEL[booking.booking_type];

  return (
    <article className="inv-card" aria-labelledby={headingId}>
      <header className="inv-card-head">
        <div>
          <p className="eyebrow">{BOOKING_LABEL[booking.booking_type]}</p>
          <h3 id={headingId}>{title}</h3>
        </div>
        <span className={`inv-pill ${pdf.tone}`}>{pdf.text}</span>
      </header>

      <dl className="inv-facts">
        <div>
          <dt>Invoice number</dt>
          <dd>{invoice ? invoice.invoice_number : "Not issued yet"}</dd>
        </div>
        <div>
          <dt>Booking reference</dt>
          <dd>{booking.confirmation_code ?? "Not available"}</dd>
        </div>
        <div>
          <dt>Booking status</dt>
          <dd>{booking.status.split("_").join(" ")}</dd>
        </div>
        <div>
          <dt>Payment</dt>
          <dd>
            {payment ? PAYMENT_TEXT[payment.status] : "No payment"}
            {payment ? ` · ${payment.payment_reference}` : ""}
          </dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>
            {formatMoney(
              invoice?.currency ?? booking.currency,
              invoice?.total ?? booking.total,
            )}
          </dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{invoice ? formatWhen(invoice.issued_at, timezone) : "—"}</dd>
        </div>
      </dl>
      <p className="inv-note">
        Dummy payment — no real money moved. Price policy{" "}
        {invoice?.pricing_policy ?? booking.pricing_policy}.
      </p>

      <div aria-live="polite" className="inv-live">
        {notice ? (
          <div className="status-banner success" role="status">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="status-banner error" role="alert">
            {error}
          </div>
        ) : null}
      </div>

      {!state.eligible && !invoice ? (
        <p className="helper-text">
          {state.ineligible_reason ?? "No invoice can be issued."}
        </p>
      ) : null}

      <div className="button-row">
        {!invoice || invoice.status === "failed" ? (
          <button
            className="button primary"
            disabled={busy !== null || !state.eligible}
            onClick={() => void generate()}
            type="button"
          >
            {busy === "generate"
              ? "Creating invoice…"
              : invoice?.status === "failed"
                ? "Try creating the invoice again"
                : "Generate invoice"}
          </button>
        ) : null}
        {invoice?.status === "issued" ? (
          <button
            className="button secondary"
            disabled={busy !== null}
            onClick={() => void download()}
            type="button"
          >
            {busy === "download" ? "Preparing download…" : "Download PDF"}
          </button>
        ) : null}
      </div>

      {invoice?.status === "issued" ? (
        <section className="inv-email" aria-labelledby={`${headingId}-email`}>
          <h4 id={`${headingId}-email`}>Email this invoice</h4>
          <form onSubmit={(event) => void sendEmail(event)}>
            <label htmlFor={`${headingId}-to`}>
              Send to (email address you confirm)
            </label>
            <div className="inv-email-row">
              <input
                id={`${headingId}-to`}
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                maxLength={254}
                value={recipient}
                onChange={(event) => setRecipient(event.target.value)}
                placeholder="name@example.com"
                aria-describedby={`${headingId}-hint`}
              />
              <button
                className="button accent"
                disabled={busy !== null || recipient.trim().length === 0}
                type="submit"
              >
                {busy === "email"
                  ? "Requesting…"
                  : first
                    ? "Send invoice"
                    : "Send again"}
              </button>
            </div>
            <small id={`${headingId}-hint`} className="helper-text">
              The invoice is sent only to this address, with the PDF attached.
              Each send is a new request that is recorded below.
            </small>
          </form>

          {deliveriesError ? (
            <p className="helper-text" role="alert">
              Delivery status is unavailable: {deliveriesError}
            </p>
          ) : deliveries === null ? (
            <p className="helper-text" role="status">
              Loading delivery status…
            </p>
          ) : deliveries.length === 0 ? (
            <p className="helper-text">No email was requested yet.</p>
          ) : (
            <ul className="inv-deliveries" aria-label="Email deliveries">
              {deliveries.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  timezone={timezone}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </article>
  );
}
