"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiClientError } from "../../lib/api";
import { listAirports, type Airport } from "../../lib/api-liteapi";

/**
 * Airport combobox. Two ways in, matching how the traveller thinks:
 * a country the provider knows (the airports of that country), or free text over
 * every airport it sells when no country is chosen. The chosen value is an IATA
 * code, because that is what the flight search accepts.
 */

const airportCache = new Map<string, Airport[]>();

export type AirportLookup = (params: {
  country?: string;
  q?: string;
}) => Promise<{ airports: Airport[]; total: number }>;

function airportLabel(airport: Airport): string {
  const place = airport.city.length > 0 ? airport.city : airport.name;
  return `${place} · ${airport.name}`;
}

export function AirportPicker({
  country,
  countryName,
  value,
  onChange,
  nearby = [],
  error,
  disabled = false,
  placeholder = "City or airport code",
  lookup,
  onClear,
}: {
  /** When set, the list is this country's airports; otherwise free text search. */
  country?: string | undefined;
  countryName?: string | undefined;
  value: Airport | null;
  onChange: (airport: Airport) => void;
  /** Airports around the traveller, offered above the list. */
  nearby?: Airport[] | undefined;
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  lookup?: AirportLookup | undefined;
  onClear?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [options, setOptions] = useState<Airport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
    setTyped("");
    setOptions([]);
    setActive(-1);
  }, [country]);

  useEffect(() => {
    if (!open || disabled) return;
    const query = typed.trim();
    if (!country && query.length < 2) {
      setOptions([]);
      setTotal(0);
      setNote(country ? null : "Type at least two letters, or pick a country first.");
      return;
    }
    const key = `${country ?? "any"}:${query.toLowerCase()}`;
    const cached = airportCache.get(key);
    if (cached) {
      setOptions(cached);
      setTotal(cached.length);
      setNote(cached.length === 0 ? "No airport matches that." : null);
      return;
    }
    const load: AirportLookup =
      lookup ??
      ((params) =>
        listAirports({
          ...(params.country ? { country: params.country } : {}),
          ...(params.q ? { q: params.q } : {}),
        }).then((result) => ({ airports: result.airports, total: result.total })));
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(
      () => {
        load({ ...(country ? { country } : {}), ...(query ? { q: query } : {}) })
          .then((result) => {
            if (cancelled) return;
            airportCache.set(key, result.airports);
            setOptions(result.airports);
            setTotal(result.total);
            setNote(
              result.airports.length === 0
                ? `No airport in ${countryName ?? "the provider's list"} matches “${query}”.`
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
                : "The airport list is unavailable right now.",
            );
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      query.length > 0 && !country ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, country, countryName, typed, disabled, lookup]);

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

  function choose(airport: Airport) {
    onChange(airport);
    setTyped("");
    setOpen(false);
    setActive(-1);
  }

  const searching = typed.trim().length > 0;
  const shown = searching
    ? options
    : country
      ? options
      : nearby;
  const nearFirst = !searching && !country && nearby.length > 0 ? nearby : [];
  const list = searching || country ? options : nearFirst;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.length === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = current + step;
        if (next < 0) return list.length - 1;
        if (next >= list.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === "Enter" && open && active >= 0 && list[active]) {
      event.preventDefault();
      choose(list[active] as Airport);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  }

  return (
    <div className="city-picker" ref={rootRef}>
      <div className="airport-value">
        <input
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open}
          aria-label="Airport"
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => {
            setTyped(event.target.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value ? undefined : placeholder}
          role="combobox"
          value={typed.length > 0 ? typed : (value ? `${value.iata} · ${value.city || value.name}` : "")}
        />
        {value ? (
          <button
            aria-label="Clear airport"
            className="airport-clear"
            onClick={() => {
              setTyped("");
              if (onClear) onClear();
            }}
            type="button"
          >
            ×
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="city-menu" id={listId} role="listbox">
          <p className="city-menu-head">
            {country && !searching
              ? `Airports in ${countryName ?? country}`
              : searching
                ? `Airports matching “${typed.trim()}”`
                : "Airports near you"}
          </p>
          {loading ? <p className="city-note">Searching…</p> : null}
          {!loading && note ? <p className="city-note">{note}</p> : null}
          {!loading && !note && list.length === 0 ? (
            <p className="city-note">No airport found.</p>
          ) : null}
          {list.map((airport, index) => (
            <button
              aria-selected={index === active}
              className={`city-option airport-option ${index === active ? "active" : ""} ${
                airport.iata === value?.iata ? "current" : ""
              }`}
              key={airport.iata}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(airport);
              }}
              role="option"
              type="button"
            >
              <span className="airport-code">{airport.iata}</span>
              <span className="airport-text">
                <strong>{airport.city || airport.name}</strong>
                <span className="airport-sub">
                  {airport.name}
                  {typeof airport.distance_km === "number"
                    ? ` · ${airport.distance_km} km away`
                    : ""}
                </span>
              </span>
            </button>
          ))}
          {!loading && total > shown.length && shown.length > 0 ? (
            <button
              className="city-more"
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              {total.toLocaleString("en-US")} airports in this list — type to narrow
            </button>
          ) : null}
        </div>
      ) : null}
      {value ? (
        <span className="airport-name">{airportLabel(value)}</span>
      ) : null}
      {error ? <span className="field-error">{error}</span> : null}
    </div>
  );
}
