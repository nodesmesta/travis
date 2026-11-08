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

/** Above this many cities the menu asks for a few letters before listing. */
const LIST_ALL_BELOW = 40;

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
  lookup,
}: {
  country: string;
  countryName: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  /** Tests and previews replace the network call; production uses the API. */
  lookup?: CityLookup | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new country means a new city list: drop what the last one returned.
  useEffect(() => {
    setOptions([]);
    setTotal(0);
    setNote(null);
    setActive(-1);
    setOpen(false);
  }, [country]);

  useEffect(() => {
    if (!open || disabled || !country) return;
    const query = value.trim();
    const key = `${country}:${query.toLowerCase()}`;
    const cached = suggestionCache.get(key);
    if (cached) {
      setOptions(cached.total > LIST_ALL_BELOW && !query ? [] : cached.cities);
      setTotal(cached.total);
      setNote(
        cached.total > LIST_ALL_BELOW && !query
          ? `${cached.total.toLocaleString("en-US")} cities in ${countryName} — type a few letters.`
          : null,
      );
      return;
    }
    const load: CityLookup =
      lookup ??
      ((code: string, text: string) =>
        searchCities(code, text).then((result) => ({
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
            const hidden = result.total > LIST_ALL_BELOW && query.length === 0;
            setOptions(hidden ? [] : result.cities);
            setNote(
              hidden
                ? `${result.total.toLocaleString("en-US")} cities in ${countryName} — type a few letters.`
                : result.total === 0
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
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, [open, country, countryName, value, disabled, lookup]);

  function choose(city: string) {
    onChange(city);
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
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter" && open && active >= 0 && options[active]) {
      event.preventDefault();
      choose(options[active] as string);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <div className="city-picker">
      <input
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label="City"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        // Clicking an already focused input must reopen the list after a country
        // change closed it, so opening is bound to click as well as focus.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setOpen(false), 120);
        }}
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
          {options.map((city, index) => (
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
            <p className="city-note">
              Showing {options.length} of {total.toLocaleString("en-US")} — keep
              typing to narrow it down.
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}
