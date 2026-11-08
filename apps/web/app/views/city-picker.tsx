"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { searchCities } from "../../lib/api-liteapi";

/**
 * City combobox backed by the provider's own city list for the chosen country,
 * so the name typed here is the exact string its rate search accepts. A country
 * like Indonesia has thousands of cities, so short lists are shown whole and
 * long ones are searched (prefix matches first) instead of dumping villages.
 */
const suggestionCache = new Map<string, { cities: string[]; total: number }>();

export type CityLookup = (
  country: string,
  query: string,
) => Promise<{ cities: string[]; total: number }>;

export function CityPicker({
  country,
  countryName,
  value,
  onChange,
  error,
  disabled = false,
  pinned,
  lookup,
}: {
  country: string;
  countryName: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  /** Well-known cities floated to the top of the unfiltered list. */
  pinned?: string[] | undefined;
  /** Tests and previews replace the network call; production uses the API. */
  lookup?: CityLookup | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  // The menu opens with a browsable slice and can grow on demand.
  const [limit, setLimit] = useState(60);
  // Opening the list shows the country's cities again; only typing filters them.
  const [typed, setTyped] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // A new country means a new city list: drop what the last one returned.
  useEffect(() => {
    setOptions([]);
    setTotal(0);
    setNote(null);
    setActive(-1);
    setLimit(60);
    setOpen(false);
  }, [country]);

  useEffect(() => {
    if (!open || disabled || !country) return;
    const query = typed ? value.trim() : "";
    const key = `${country}:${query.toLowerCase()}:${limit}:${(pinned ?? []).join("|")}`;
    const cached = suggestionCache.get(key);
    if (cached) {
      setOptions(cached.cities);
      setTotal(cached.total);
      setNote(
        cached.total === 0
          ? `No city in ${countryName} matches “${query}”.`
          : null,
      );
      return;
    }
    const load: CityLookup =
      lookup ??
      ((code: string, text: string) =>
        searchCities(
          code,
          text,
          text.trim() ? 40 : limit,
          text.trim() ? [] : (pinned ?? []),
        ).then((result) => ({
          cities: result.cities,
          total: result.total,
        })));
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(
      () => {
        load(country, query)
          .then((result) => {
            if (cancelled) return;
            suggestionCache.set(key, result);
            setTotal(result.total);
            setOptions(result.cities);
            setNote(
              result.total === 0
                ? `No city in ${countryName} matches “${query}”.`
                : null,
            );
          })
          .catch((caught: unknown) => {
            if (cancelled) return;
            setOptions([]);
            setTotal(0);
            setNote(
              caught instanceof ApiClientError
                ? caught.message
                : "The city list is unavailable right now.",
            );
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      query.length > 0 ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, country, countryName, value, typed, disabled, limit, pinned, lookup]);

  // Closing on pointer-down outside the component keeps clicks inside the menu
  // (options, "show more") from being mistaken for a blur.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function choose(city: string) {
    onChange(city);
    setTyped(false);
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current + step;
        if (next < 0) return display.length - 1;
        if (next >= display.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter" && open && active >= 0 && display[active]) {
      event.preventDefault();
      choose(display[active] as string);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  }

  const display = options.slice(0, limit);

  return (
    <div className="city-picker" ref={rootRef}>
      <input
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label="City"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => {
          setTyped(true);
          onChange(event.target.value);
          setOpen(true);
        }}
        // Clicking an already focused input must reopen the list after a country
        // change closed it, so opening is bound to click as well as focus.
        onClick={() => {
          setTyped(false);
          setOpen(true);
        }}
        onFocus={() => {
          setTyped(false);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={country ? "Type a city" : "Choose a country first"}
        role="combobox"
        value={value}
      />
      {open && country ? (
        <div className="city-menu" id={listId} role="listbox">
          <p className="city-menu-head">Cities in {countryName}</p>
          {loading ? <p className="city-note">Searching…</p> : null}
          {!loading && note ? <p className="city-note">{note}</p> : null}
          {!loading && !note && options.length === 0 ? (
            <p className="city-note">No city found.</p>
          ) : null}
          {display.map((city, index) => (
            <button
              aria-selected={index === active}
              className={`city-option ${index === active ? "active" : ""} ${
                city === value ? "current" : ""
              }`}
              key={city}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(city);
              }}
              role="option"
              type="button"
            >
              {city}
            </button>
          ))}
          {!loading && total > options.length && options.length > 0 ? (
            <button
              className="city-more"
              onMouseDown={(event) => {
                event.preventDefault();
                setLimit((current) => Math.min(current + 140, 500));
              }}
              type="button"
            >
              Show more — {total.toLocaleString("en-US")} cities in{" "}
              {countryName}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}
