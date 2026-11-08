"use client";

import { useCallback, useRef, useState } from "react";
import {
  describeAssistantError,
  entityTypeFor,
  newIdempotencyKey,
  requestConfirmation,
  runConfirmedAction,
} from "../../lib/api-assistant";
import type {
  ActionOutcome,
  ConfirmationAction,
  ConfirmationRequest,
} from "../../lib/types-assistant";

export interface ConfirmationFlow {
  /** The request shown in the dialog, or null when no dialog is open. */
  pending: ConfirmationRequest | null;
  busy: boolean;
  /** Error inside the dialog (token used, expired, state changed). */
  dialogError: string | null;
  /** Error before a dialog could open (the backend refused to issue a token). */
  startError: string | null;
  /** Ask the backend for a token for this action, then open the dialog. */
  begin: (action: ConfirmationAction, entityId: string) => Promise<void>;
  /** Open the dialog for a request the assistant already issued. */
  open: (request: ConfirmationRequest) => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => void;
}

/**
 * Shared confirmation flow. A change only happens when the user presses the
 * confirm button in the dialog and the backend accepts the single-use token.
 */
export function useConfirmation(
  tripId: string,
  onDone: (
    outcome: ActionOutcome,
    confirmation: ConfirmationRequest,
  ) => void | Promise<void>,
): ConfirmationFlow {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const keyRef = useRef<string>("");

  const begin = useCallback(
    async (action: ConfirmationAction, entityId: string) => {
      setStartError(null);
      setDialogError(null);
      setBusy(true);
      try {
        const issued = await requestConfirmation(
          tripId,
          { action, entity_type: entityTypeFor(action), entity_id: entityId },
          newIdempotencyKey("confirmation"),
        );
        keyRef.current = newIdempotencyKey("confirmed-action");
        setPending(issued);
      } catch (error) {
        const described = describeAssistantError(error);
        setStartError(
          `${described.message}${described.requestId ? ` (request ${described.requestId})` : ""}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [tripId],
  );

  const open = useCallback(
    async (request: ConfirmationRequest) => {
      if (request.confirmation_token) {
        setStartError(null);
        setDialogError(null);
        keyRef.current = newIdempotencyKey("confirmed-action");
        setPending(request);
        return;
      }
      // A stored answer never keeps the raw token, so ask for a fresh one.
      await begin(request.action, request.entity_id);
    },
    [begin],
  );

  const confirm = useCallback(async () => {
    if (!pending?.confirmation_token) return;
    setBusy(true);
    setDialogError(null);
    try {
      const outcome = await runConfirmedAction(
        tripId,
        { ...pending, confirmation_token: pending.confirmation_token },
        keyRef.current,
      );
      const done = pending;
      setPending(null);
      await onDone(outcome, done);
    } catch (error) {
      const described = describeAssistantError(error);
      setDialogError(
        `${described.message}${described.requestId ? ` (request ${described.requestId})` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }, [onDone, pending, tripId]);

  const cancel = useCallback(() => {
    setPending(null);
    setDialogError(null);
  }, []);

  return {
    pending,
    busy,
    dialogError,
    startError,
    begin,
    open,
    confirm,
    cancel,
  };
}
