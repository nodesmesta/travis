"use client";

import type { ReactNode } from "react";

/**
 * Building blocks for the search bars.
 *
 * The reference is the pattern every large travel site uses: one row of labelled
 * segments (Where / When / Who) instead of a grid of labelled inputs, a stepper
 * instead of a number field, and inline validation under the field that failed.
 */
export function SearchField({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | null | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label
      className={`search-field ${className ?? ""} ${error ? "has-error" : ""}`}
    >
      <span className="search-field-label">{label}</span>
      {children}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="search-field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function GuestStepper({
  value,
  min = 1,
  max = 9,
  onChange,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
}) {
  return (
    <span className="stepper">
      <button
        aria-label="Remove a guest"
        className="stepper-button"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        type="button"
      >
        −
      </button>
      <span className="stepper-value">
        {value} {value === 1 ? "adult" : "adults"}
      </span>
      <button
        aria-label="Add a guest"
        className="stepper-button"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        type="button"
      >
        +
      </button>
    </span>
  );
}
