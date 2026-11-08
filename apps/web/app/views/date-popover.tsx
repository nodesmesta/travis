"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** `2026-12-01` → `1 Dec 2026`. */
export function shortDate(iso: string): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  const name = MONTH_NAMES[Number(month) - 1] ?? "";
  return `${Number(day)} ${name.slice(0, 3)} ${year}`;
}

/** `2026-12-09` → `9 Dec`; the year only shows when it is not the current one. */
function compactDate(iso: string): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  const name = MONTH_NAMES[Number(month) - 1] ?? "";
  const currentYear = `${new Date().getFullYear()}`;
  return year === currentYear
    ? `${Number(day)} ${name.slice(0, 3)}`
    : `${Number(day)} ${name.slice(0, 3)} ${year}`;
}

function isoOf(year: number, month: number, day: number): string {
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function todayIso(): string {
  const now = new Date();
  return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return isoOf(date.getFullYear(), date.getMonth(), date.getDate());
}

function shiftMonth(
  year: number,
  month: number,
  by: number,
): { year: number; month: number } {
  const next = new Date(year, month + by, 1);
  return { year: next.getFullYear(), month: next.getMonth() };
}

/** Monday-first weeks; `null` fills the days before the 1st and after the last. */
function weeksOf(year: number, month: number): Array<Array<number | null>> {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: offset }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<number | null>> = [];
  for (let index = 0; index < cells.length; index += 7)
    weeks.push(cells.slice(index, index + 7));
  return weeks;
}

function MonthGrid({
  year,
  month,
  isDisabled,
  isSelected,
  isInRange,
  onPick,
}: {
  year: number;
  month: number;
  isDisabled: (iso: string) => boolean;
  isSelected: (iso: string) => boolean;
  isInRange: (iso: string) => boolean;
  onPick: (iso: string) => void;
}) {
  return (
    <div className="cal-month">
      <p className="cal-title">
        {MONTH_NAMES[month]} {year}
      </p>
      <div className="cal-weekdays">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="cal-grid">
        {weeksOf(year, month).map((week, weekIndex) => (
          <div className="cal-week" key={`${year}-${month}-${weekIndex}`}>
            {week.map((day, dayIndex) => {
              if (day === null)
                return <span className="cal-empty" key={`e-${dayIndex}`} />;
              const iso = isoOf(year, month, day);
              const disabled = isDisabled(iso);
              const selected = isSelected(iso);
              return (
                <button
                  aria-label={shortDate(iso)}
                  aria-pressed={selected}
                  className={`cal-day ${selected ? "selected" : ""} ${
                    isInRange(iso) ? "in-range" : ""
                  }`}
                  disabled={disabled}
                  key={iso}
                  onClick={() => onPick(iso)}
                  type="button"
                >
                  {day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function useOutsideClose(
  open: boolean,
  close: () => void,
): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);
  return ref;
}

/**
 * The stay's dates live in one card that opens a calendar. Clicking the card is
 * the whole affordance; the popover holds both dates and the night count.
 */
export function DateRangePopover({
  checkin,
  checkout,
  minIso,
  onChange,
}: {
  checkin: string;
  checkout: string;
  minIso?: string;
  onChange: (input: { checkin: string; checkout: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const base = checkin || minIso || todayIso();
    const date = new Date(`${base}T00:00:00`);
    return { year: date.getFullYear(), month: date.getMonth() };
  });
  const ref = useOutsideClose(open, () => setOpen(false));
  const floor = minIso ?? todayIso();
  const next = shiftMonth(cursor.year, cursor.month, 1);

  function pick(iso: string) {
    // First click starts the stay; the second ends it. A click before the start
    // moves the start instead of producing a negative range.
    if (!checkin || (checkin && checkout) || iso <= checkin) {
      onChange({ checkin: iso, checkout: "" });
      return;
    }
    onChange({ checkin, checkout: iso });
    setOpen(false);
  }

  const nights = checkin && checkout
    ? Math.round(
        (Date.parse(`${checkout}T00:00:00`) - Date.parse(`${checkin}T00:00:00`)) /
          86_400_000,
      )
    : 0;

  return (
    <div className="date-popover" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`date-trigger ${checkin && checkout ? "" : "incomplete"}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{checkin ? compactDate(checkin) : "Check-in"}</span>
        <span aria-hidden="true" className="date-arrow">
          →
        </span>
        <span>{checkout ? compactDate(checkout) : "Check-out"}</span>
      </button>
      {open ? (
        <div className="cal-pop" role="dialog" aria-label="Choose dates">
          <div className="cal-nav">
            <button
              aria-label="Previous month"
              className="cal-nav-button"
              onClick={() =>
                setCursor((current) => shiftMonth(current.year, current.month, -1))
              }
              type="button"
            >
              ‹
            </button>
            <span className="cal-nav-hint">
              {nights > 0
                ? `${nights} ${nights === 1 ? "night" : "nights"}`
                : "Pick your dates"}
            </span>
            <button
              aria-label="Next month"
              className="cal-nav-button"
              onClick={() =>
                setCursor((current) => shiftMonth(current.year, current.month, 1))
              }
              type="button"
            >
              ›
            </button>
          </div>
          <div className="cal-months">
            <MonthGrid
              isDisabled={(iso) => iso < floor}
              isInRange={(iso) => iso > checkin && iso < checkout}
              isSelected={(iso) => iso === checkin || iso === checkout}
              month={cursor.month}
              onPick={pick}
              year={cursor.year}
            />
            <MonthGrid
              isDisabled={(iso) => iso < floor}
              isInRange={(iso) => iso > checkin && iso < checkout}
              isSelected={(iso) => iso === checkin || iso === checkout}
              month={next.month}
              onPick={pick}
              year={next.year}
            />
          </div>
          <div className="cal-presets">
            <button
              onClick={() =>
                onChange({ checkin: floor, checkout: addDays(floor, 1) })
              }
              type="button"
            >
              Tonight
            </button>
            <button
              onClick={() =>
                onChange({ checkin: addDays(floor, 1), checkout: addDays(floor, 8) })
              }
              type="button"
            >
              Next week
            </button>
            <button
              className="cal-done"
              onClick={() => setOpen(false)}
              type="button"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One date for a one-way flight, in the same card-and-popover shape. */
export function DatePopover({
  value,
  minIso,
  label,
  onChange,
}: {
  value: string;
  minIso?: string;
  label: string;
  onChange: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const date = new Date(`${value || minIso || todayIso()}T00:00:00`);
    return { year: date.getFullYear(), month: date.getMonth() };
  });
  const ref = useOutsideClose(open, () => setOpen(false));
  const floor = minIso ?? todayIso();

  return (
    <div className="date-popover" ref={ref}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={`date-trigger ${value ? "" : "incomplete"}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>{value ? compactDate(value) : label}</span>
      </button>
      {open ? (
        <div className="cal-pop single" role="dialog" aria-label="Choose a date">
          <div className="cal-nav">
            <button
              aria-label="Previous month"
              className="cal-nav-button"
              onClick={() =>
                setCursor((current) => shiftMonth(current.year, current.month, -1))
              }
              type="button"
            >
              ‹
            </button>
            <span className="cal-nav-hint">
              {value ? shortDate(value) : "Pick a day"}
            </span>
            <button
              aria-label="Next month"
              className="cal-nav-button"
              onClick={() =>
                setCursor((current) => shiftMonth(current.year, current.month, 1))
              }
              type="button"
            >
              ›
            </button>
          </div>
          <MonthGrid
            isDisabled={(iso) => iso < floor}
            isInRange={() => false}
            isSelected={(iso) => iso === value}
            month={cursor.month}
            onPick={(iso) => {
              onChange(iso);
              setOpen(false);
            }}
            year={cursor.year}
          />
        </div>
      ) : null}
    </div>
  );
}
