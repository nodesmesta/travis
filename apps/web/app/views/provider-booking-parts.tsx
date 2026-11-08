"use client";

import { useState } from "react";
import { ApiClientError } from "../../lib/api";
import {
  cancelFlightBooking,
  cancelHotelBooking,
  getFlightBooking,
  getHotelBooking,
  type ProviderActionResponse,
} from "../../lib/api-liteapi";
import type { ProviderBookingSummary } from "../../lib/types";

type ProviderBookingType = "hotel" | "flight";

const STATE_LABELS: Record<string, string> = {
  created: "Created",
  prebooked: "Prebooked",
  paid: "Paid, not sent to provider",
  booking: "Sending to provider",
  pending: "Provider pending",
  confirmed: "Confirmed",
  cancel_requested: "Cancellation requested",
  cancelled: "Cancelled",
  failed: "Failed",
  unknown: "Provider status unknown",
};

export function providerStateLabel(state: string | null | undefined): string {
  if (!state) return "No provider state";
  return STATE_LABELS[state] ?? state;
}

export function providerStateTone(
  state: string | null | undefined,
): "confirmed" | "failed" | "pending" {
  if (state === "confirmed") return "confirmed";
  if (state === "failed" || state === "cancelled") return "failed";
  return "pending";
}

export function providerErrorText(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return error instanceof Error ? error.message : "Provider request failed.";
}

function providerBookingPath(
  tripId: string,
  bookingType: ProviderBookingType,
  providerBookingId: string,
): {
  get: () => Promise<ProviderActionResponse>;
  cancel: () => Promise<ProviderActionResponse>;
} {
  return bookingType === "hotel"
    ? {
        get: () => getHotelBooking(tripId, providerBookingId),
        cancel: () => cancelHotelBooking(tripId, providerBookingId),
      }
    : {
        get: () => getFlightBooking(tripId, providerBookingId),
        cancel: () => cancelFlightBooking(tripId, providerBookingId),
      };
}

export function fetchProviderBooking(
  tripId: string,
  bookingType: ProviderBookingType,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return providerBookingPath(tripId, bookingType, providerBookingId).get();
}

export function cancelProviderBooking(
  tripId: string,
  bookingType: ProviderBookingType,
  providerBookingId: string,
): Promise<ProviderActionResponse> {
  return providerBookingPath(tripId, bookingType, providerBookingId).cancel();
}

export function isoTime(value: string | null): string {
  if (!value) return "not yet";
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

export function ProviderBookingStatus({
  provider,
  bookingType,
}: {
  provider: ProviderBookingSummary;
  bookingType: ProviderBookingType;
}) {
  return (
    <div className="provider-status">
      <div>
        <span className="provider-label">Last checked</span>
        <span className="provider-value">
          {isoTime(provider.last_reconciled_at)}
        </span>
      </div>
      {provider.cancellation_fee !== null ? (
        <div>
          <span className="provider-label">Cancellation fee</span>
          <span className="provider-value">
            {provider.currency} {provider.cancellation_fee}
          </span>
        </div>
      ) : null}
      {bookingType === "flight" && provider.ticket_deadline ? (
        <div>
          <span className="provider-label">Ticket deadline</span>
          <span className="provider-value">
            {isoTime(provider.ticket_deadline)}
          </span>
        </div>
      ) : null}
      {provider.provider_status &&
      provider.provider_status.toLowerCase() !== provider.state ? (
        <span className="provider-footnote">
          Provider reports: {provider.provider_status}
        </span>
      ) : null}
    </div>
  );
}

export function ProviderBookingActions({
  tripId,
  bookingType,
  providerBookingId,
  canCancel,
  onUpdated,
}: {
  tripId: string;
  bookingType: ProviderBookingType;
  providerBookingId: string;
  canCancel: boolean;
  onUpdated: (response: ProviderActionResponse) => void;
}) {
  const [busy, setBusy] = useState<"refresh" | "cancel" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy("refresh");
    setError(null);
    try {
      onUpdated(
        await fetchProviderBooking(tripId, bookingType, providerBookingId),
      );
    } catch (caught) {
      setError(providerErrorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      onUpdated(
        await cancelProviderBooking(tripId, bookingType, providerBookingId),
      );
      setConfirming(false);
    } catch (caught) {
      setError(providerErrorText(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="provider-actions">
      {error ? (
        <p className="helper-text provider-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="provider-action-row">
        <button
          className="button secondary"
          disabled={busy !== null}
          onClick={() => void refresh()}
          type="button"
        >
          {busy === "refresh" ? "Refreshing…" : "Refresh status"}
        </button>
        {!canCancel ? null : confirming ? (
          <>
            <button
              className="button danger"
              disabled={busy !== null}
              onClick={() => void cancel()}
              type="button"
            >
              {busy === "cancel" ? "Cancelling…" : "Confirm cancel"}
            </button>
            <button
              className="button ghost"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Keep reservation
            </button>
          </>
        ) : (
          <button
            className="button ghost danger-text"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
            type="button"
          >
            Cancel reservation
          </button>
        )}
      </div>
    </div>
  );
}

export function cancellableState(state: string | null | undefined): boolean {
  return (
    state === "prebooked" ||
    state === "paid" ||
    state === "booking" ||
    state === "pending" ||
    state === "confirmed"
  );
}
