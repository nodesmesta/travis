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

export interface CityOption {
  name: string;
  country: string;
}

/**
 * City suggestions for the search fields. Picking one also answers the country
 * question the hotel provider asks for, which is otherwise unguessable from a
 * free-text city. Ordered by how often they are typed from Indonesia.
 */
export const CITIES: CityOption[] = [
  { name: "Jakarta", country: "ID" },
  { name: "Surabaya", country: "ID" },
  { name: "Bandung", country: "ID" },
  { name: "Medan", country: "ID" },
  { name: "Denpasar", country: "ID" },
  { name: "Yogyakarta", country: "ID" },
  { name: "Semarang", country: "ID" },
  { name: "Makassar", country: "ID" },
  { name: "Balikpapan", country: "ID" },
  { name: "Batam", country: "ID" },
  { name: "Singapore", country: "SG" },
  { name: "Kuala Lumpur", country: "MY" },
  { name: "Penang", country: "MY" },
  { name: "Johor Bahru", country: "MY" },
  { name: "Bangkok", country: "TH" },
  { name: "Phuket", country: "TH" },
  { name: "Chiang Mai", country: "TH" },
  { name: "Ho Chi Minh City", country: "VN" },
  { name: "Hanoi", country: "VN" },
  { name: "Manila", country: "PH" },
  { name: "Cebu", country: "PH" },
  { name: "Tokyo", country: "JP" },
  { name: "Osaka", country: "JP" },
  { name: "Seoul", country: "KR" },
  { name: "Busan", country: "KR" },
  { name: "Hong Kong", country: "HK" },
  { name: "Taipei", country: "TW" },
  { name: "Beijing", country: "CN" },
  { name: "Shanghai", country: "CN" },
  { name: "Sydney", country: "AU" },
  { name: "Melbourne", country: "AU" },
  { name: "Perth", country: "AU" },
  { name: "Auckland", country: "NZ" },
  { name: "Dubai", country: "AE" },
  { name: "Abu Dhabi", country: "AE" },
  { name: "Riyadh", country: "SA" },
  { name: "Jeddah", country: "SA" },
  { name: "Doha", country: "QA" },
  { name: "Istanbul", country: "TR" },
  { name: "London", country: "GB" },
  { name: "Manchester", country: "GB" },
  { name: "Amsterdam", country: "NL" },
  { name: "Frankfurt", country: "DE" },
  { name: "Berlin", country: "DE" },
  { name: "Paris", country: "FR" },
  { name: "Madrid", country: "ES" },
  { name: "Barcelona", country: "ES" },
  { name: "Rome", country: "IT" },
  { name: "Milan", country: "IT" },
  { name: "Zurich", country: "CH" },
  { name: "New York", country: "US" },
  { name: "Los Angeles", country: "US" },
  { name: "San Francisco", country: "US" },
  { name: "Toronto", country: "CA" },
  { name: "Vancouver", country: "CA" },
  { name: "Mexico City", country: "MX" },
  { name: "Sao Paulo", country: "BR" },
  { name: "Cape Town", country: "ZA" },
  { name: "Cairo", country: "EG" },
];

/** The country code that belongs to a typed city, or "" when it is not in the list. */
export function countryForCity(city: string): string {
  const wanted = city.trim().toLowerCase();
  if (!wanted) return "";
  const match = CITIES.find((item) => item.name.toLowerCase() === wanted);
  return match?.country ?? "";
}

export function countryLabel(code: string): string {
  return COUNTRIES.find((item) => item.code === code)?.label ?? "";
}

/** Nights between two `YYYY-MM-DD` dates, or 0 when the range is unusable. */
export function nightsBetween(checkin: string, checkout: string): number {
  if (!checkin || !checkout) return 0;
  const start = Date.parse(`${checkin}T00:00:00Z`);
  const end = Date.parse(`${checkout}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 86_400_000);
}
