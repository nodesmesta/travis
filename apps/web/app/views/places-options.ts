/**
 * Small ISO-3166 list for the checkout forms.
 *
 * Hotel search needs a two-letter country code next to the city name, and the
 * traveller should not have to know it. The list stays short and readable
 * because it is only a picker, not an authority: the trip destination is
 * matched against it to preselect a value, and the code shown is what the
 * provider receives.
 */
export interface CountryOption {
  code: string;
  label: string;
}

export const COUNTRIES: CountryOption[] = [
  { code: "ID", label: "Indonesia" },
  { code: "SG", label: "Singapore" },
  { code: "MY", label: "Malaysia" },
  { code: "TH", label: "Thailand" },
  { code: "VN", label: "Vietnam" },
  { code: "PH", label: "Philippines" },
  { code: "BN", label: "Brunei" },
  { code: "KH", label: "Cambodia" },
  { code: "JP", label: "Japan" },
  { code: "KR", label: "South Korea" },
  { code: "CN", label: "China" },
  { code: "HK", label: "Hong Kong" },
  { code: "TW", label: "Taiwan" },
  { code: "IN", label: "India" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "AE", label: "United Arab Emirates" },
  { code: "SA", label: "Saudi Arabia" },
  { code: "QA", label: "Qatar" },
  { code: "TR", label: "Türkiye" },
  { code: "GB", label: "United Kingdom" },
  { code: "NL", label: "Netherlands" },
  { code: "DE", label: "Germany" },
  { code: "FR", label: "France" },
  { code: "ES", label: "Spain" },
  { code: "IT", label: "Italy" },
  { code: "CH", label: "Switzerland" },
  { code: "US", label: "United States" },
  { code: "CA", label: "Canada" },
  { code: "MX", label: "Mexico" },
  { code: "BR", label: "Brazil" },
  { code: "ZA", label: "South Africa" },
  { code: "EG", label: "Egypt" },
];

export const CURRENCIES: string[] = [
  "USD",
  "IDR",
  "SGD",
  "MYR",
  "THB",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "AED",
];

/** Best effort: the last comma-separated part of the destination that names a country. */
export function guessCountryCode(destination: string | null): string {
  if (!destination) return "";
  const parts = destination.split(",").map((part) => part.trim().toLowerCase());
  for (const part of parts) {
    const match = COUNTRIES.find(
      (country) => country.label.toLowerCase() === part,
    );
    if (match) return match.code;
  }
  const whole = destination.trim().toLowerCase();
  const direct = COUNTRIES.find(
    (country) =>
      whole.includes(country.label.toLowerCase()) || whole === country.code.toLowerCase(),
  );
  return direct?.code ?? "";
}

/** Best effort: the first comma-separated part of the destination. */
export function guessCity(destination: string | null): string {
  if (!destination) return "";
  const [first = ""] = destination.split(",");
  return first.trim();
}
