import { LiteApiClient } from "@travelflow/integrations";
import type {
  HotelContent,
  HotelOffer,
  HotelRoomContent,
  LiteAirport,
} from "@travelflow/integrations";
import { AppError } from "../errors.js";
import { writeJson } from "../http.js";
import { matchRoom } from "../services/room-matching.js";
import { FixedWindowLimiter } from "../rate-limit.js";
import { matchPath } from "../routing.js";
import type { RequestContext, RouteModule } from "./context.js";

const PLACES = "/api/v1/places";
const limiter = new FixedWindowLimiter(120, 60_000);
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The provider publishes one country list and one city list per country. Both
 * change rarely, so they are cached in process memory and the browser asks for
 * a filtered slice instead of the whole list (Indonesia alone has 2,360 cities).
 */
interface CachedCountries {
  at: number;
  countries: Array<{ code: string; name: string }>;
}

const countryCache: { current: CachedCountries | null } = { current: null };
const cityCache = new Map<string, { at: number; cities: string[] }>();
/**
 * One hotel's description, facilities, photos, rooms and the latest guest
 * reviews. Large and slow to fetch, so a hotel is cached after its first open.
 */
const hotelCache = new Map<
  string,
  {
    at: number;
    content: Awaited<ReturnType<LiteApiClient["getHotelContent"]>>;
    reviews: Awaited<ReturnType<LiteApiClient["getHotelReviews"]>>;
  }
>();

function makeClient(context: RequestContext): LiteApiClient {
  return new LiteApiClient({
    apiKey: context.config.liteApiKey,
    timeoutMs: context.config.liteApiTimeoutMs,
  });
}

function take(context: RequestContext, userId: string, scope: string): void {
  const wait = limiter.take(`${userId}:places:${scope}`);
  if (wait <= 0) return;
  context.response.setHeader("retry-after", String(wait));
  throw new AppError(
    "RATE_LIMITED",
    "validation",
    429,
    "Too many place requests. Wait and try again.",
    { retry_after_seconds: wait },
  );
}

/** Airport lookups are stable for a country or a search term, so they are cached. */
const airportCountryCache = new Map<string, { at: number; airports: LiteAirport[] }>();
const airportQueryCache = new Map<string, { at: number; airports: LiteAirport[] }>();
/** A coordinate becomes a city name through OSM, which is cached by ~1 km. */
const geocodeCache = new Map<
  string,
  { at: number; city: string | null; country: string | null; label: string | null }
>();
const GEOCODE_TTL_MS = 60 * 60 * 1000;

/** Great-circle distance, so "nearest airport" means what it says. */
function distanceKm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6371;
  const dLat = toRadians(to.lat - from.lat);
  const dLon = toRadians(to.lon - from.lon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

/**
 * Coordinates to a city name. OpenStreetMap is asked with the caller's own
 * coordinates and a descriptive user agent, as its policy requires.
 */
async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<{ city: string | null; country: string | null; label: string | null }> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.at < GEOCODE_TTL_MS) return cached;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`;
  let value: { city: string | null; country: string | null; label: string | null } = {
    city: null,
    country: null,
    label: null,
  };
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "travelflow/1.0 (hotel and flight search)",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        display_name?: string;
        address?: Record<string, string>;
      };
      const address = body.address ?? {};
      const city =
        address.city ??
        address.town ??
        address.village ??
        address.municipality ??
        address.county ??
        null;
      value = {
        city,
        country: address.country_code?.toUpperCase() ?? null,
        label: body.display_name ?? null,
      };
    }
  } catch {
    // Best effort: the caller falls back to its own default airport.
  }
  geocodeCache.set(key, { at: Date.now(), ...value });
  return value;
}

/** The airports of one country: the provider answers by name, then we filter. */
async function airportsForCountry(
  context: RequestContext,
  countryCode: string,
  countryName: string,
): Promise<LiteAirport[]> {
  const cached = airportCountryCache.get(countryCode);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.airports;
  const found = await makeClient(context).searchAirports(countryName);
  const airports = found
    .filter((airport) => airport.country === countryCode)
    .filter((airport) => airport.has_airline_service)
    .sort((left, right) =>
      `${left.city} ${left.name}`.localeCompare(`${right.city} ${right.name}`),
    );
  airportCountryCache.set(countryCode, { at: Date.now(), airports });
  return airports;
}

async function airportsByQuery(
  context: RequestContext,
  query: string,
): Promise<LiteAirport[]> {
  const key = query.trim().toLowerCase();
  const cached = airportQueryCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.airports;
  const airports = await makeClient(context).searchAirports(query);
  airportQueryCache.set(key, { at: Date.now(), airports });
  return airports;
}

async function countries(context: RequestContext) {
  const cached = countryCache.current;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const fresh = {
    at: Date.now(),
    countries: await makeClient(context).listCountries(),
  };
  countryCache.current = fresh;
  return fresh;
}

async function cities(context: RequestContext, countryCode: string) {
  const cached = cityCache.get(countryCode);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const fresh = {
    at: Date.now(),
    cities: await makeClient(context).listCities(countryCode),
  };
  cityCache.set(countryCode, fresh);
  return fresh;
}

/**
 * Prefix matches first, then substring matches, so "jak" puts Jakarta on top.
 * `first` names the cities the traveller looks for; without a query they lead the
 * list, because the provider answers alphabetically and its first page is villages.
 */
function filterCities(
  cities: string[],
  query: string,
  max: number,
  first: string[],
): { items: string[]; total: number } {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    const byName = new Map(cities.map((city) => [city.toLowerCase(), city]));
    const lead: string[] = [];
    const seen = new Set<string>();
    for (const name of first) {
      const match = byName.get(name.toLowerCase());
      if (!match || seen.has(match)) continue;
      seen.add(match);
      lead.push(match);
    }
    const rest = cities.filter((city) => !seen.has(city));
    return {
      items: lead.concat(rest).slice(0, max),
      total: cities.length,
    };
  }
  const starts: string[] = [];
  const contains: string[] = [];
  for (const city of cities) {
    const lowered = city.toLowerCase();
    if (lowered.startsWith(needle)) starts.push(city);
    else if (lowered.includes(needle)) contains.push(city);
  }
  const matches = starts.concat(contains);
  return { items: matches.slice(0, max), total: matches.length };
}

/** `first=Jakarta,Bandung,Surabaya`: at most 20 names, each trimmed. */
function firstNameParam(context: RequestContext): string[] {
  const raw = context.url.searchParams.get("first") ?? "";
  return raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && name.length <= 80)
    .slice(0, 20);
}

function countryParam(context: RequestContext): string {
  const value = (context.url.searchParams.get("country") ?? "")
    .trim()
    .toUpperCase();
  if (value.length !== 2) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "country must be a 2-letter code.",
    );
  }
  return value;
}

async function hotel(context: RequestContext, hotelId: string) {
  const cached = hotelCache.get(hotelId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached;
  const client = makeClient(context);
  const [content, reviews] = await Promise.all([
    client.getHotelContent(hotelId),
    client.getHotelReviews(hotelId, 12),
  ]);
  const fresh = { at: Date.now(), content, reviews };
  hotelCache.set(hotelId, fresh);
  return fresh;
}

/**
 * One entry per hotel and night range: the rooms the provider actually sells for
 * those dates, joined to the hotel content so each room can show its own photos.
 * Rates move, so this cache is much shorter than the content cache.
 */
const rateCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<typeof loadRateGroups>> }
>();
const RATE_TTL_MS = 10 * 60 * 1000;

function rateGroups(offers: HotelOffer[], rooms: HotelRoomContent[]) {
  const groups = new Map<
    string,
    {
      key: string;
      name: string;
      room: HotelRoomContent | null;
      offers: HotelOffer[];
      seen: Set<string>;
    }
  >();
  for (const offer of offers) {
    const room = matchRoom(offer.room_name, rooms, offer.adults);
    // Provider room ids are often empty, so the name has to carry the key —
    // otherwise every matched room collapses into one card.
    const key = room
      ? room.room_id.length > 0
        ? room.room_id
        : `room:${room.name.trim().toLowerCase()}`
      : `rate:${offer.room_name.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: room?.name ?? offer.room_name,
        room,
        offers: [],
        seen: new Set<string>(),
      };
      groups.set(key, group);
    }
    // The same room and board at the same price is one choice, however many
    // suppliers resell it.
    const signature = `${offer.board_name ?? ""}|${offer.total.amount}|${offer.refundable}`;
    if (group.seen.has(signature)) continue;
    group.seen.add(signature);
    group.offers.push(offer);
  }
  return [...groups.values()]
    .map(({ seen: _seen, ...rest }) => rest)
    .sort(
      (a, b) =>
        (a.offers[0]?.total.amount ?? 0) - (b.offers[0]?.total.amount ?? 0),
    );
}

function nightsBetween(checkin: string, checkout: string): number {
  return Math.max(
    1,
    Math.round(
      (Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) /
        86_400_000,
    ),
  );
}

function dateParam(context: RequestContext, name: string): string {
  const value = (context.url.searchParams.get(name) ?? "").trim();
  const parts = value.split("-");
  const shaped =
    parts.length === 3 &&
    parts[0]?.length === 4 &&
    parts[1]?.length === 2 &&
    parts[2]?.length === 2 &&
    [...value].every(
      (char, index) =>
        index === 4 || index === 7 ||
        (char >= "0" && char <= "9"),
    );
  if (!shaped || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      `${name} must be a date (YYYY-MM-DD).`,
    );
  }
  return value;
}

async function loadRateGroups(
  context: RequestContext,
  input: {
    hotelId: string;
    city: string;
    country: string;
    checkin: string;
    checkout: string;
    adults: number;
    currency: string;
  },
) {
  const client = makeClient(context);
  const [rates, content] = await Promise.all([
    client.getHotelRates({
      hotel_id: input.hotelId,
      city: input.city,
      country_code: input.country,
      checkin: input.checkin,
      checkout: input.checkout,
      adults: input.adults,
      currency: input.currency,
      guest_nationality: input.country,
    }),
    hotel(context, input.hotelId).then((cached) => cached.content as HotelContent),
  ]);
  return {
    nights: nightsBetween(input.checkin, input.checkout),
    hotel_name: rates.hotel?.name ?? content.name,
    offer_count: rates.offers.length,
    groups: rateGroups(rates.offers, content.rooms),
    retrieved_at: rates.retrieved_at,
  };
}

async function rates(
  context: RequestContext,
  hotelId: string,
): Promise<Awaited<ReturnType<typeof loadRateGroups>>> {
  const city = (context.url.searchParams.get("city") ?? "").trim();
  if (city.length === 0 || city.length > 120) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "city is required.",
    );
  }
  const country = countryParam(context);
  const checkin = dateParam(context, "checkin");
  const checkout = dateParam(context, "checkout");
  if (Date.parse(checkout) <= Date.parse(checkin)) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "checkout must be after checkin.",
    );
  }
  const rawAdults = Number(context.url.searchParams.get("adults") ?? "1");
  const adults = Number.isInteger(rawAdults)
    ? Math.min(Math.max(rawAdults, 1), 9)
    : 1;
  const currency = (context.url.searchParams.get("currency") ?? "USD")
    .trim()
    .toUpperCase();
  const key = [
    hotelId,
    checkin,
    checkout,
    adults,
    currency,
    city.toLowerCase(),
    country,
  ].join("|");
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.at < RATE_TTL_MS) return cached.value;
  const value = await loadRateGroups(context, {
    hotelId,
    city,
    country,
    checkin,
    checkout,
    adults,
    currency,
  });
  rateCache.set(key, { at: Date.now(), value });
  return value;
}

/** Provider ids are short alphanumeric tokens such as `lpff41b`. */
function hotelIdParam(value: string | undefined): string {
  const id = (value ?? "").trim();
  const valid =
    id.length >= 3 &&
    id.length <= 40 &&
    [...id].every(
      (char) =>
        (char >= "0" && char <= "9") ||
        (char >= "a" && char <= "z") ||
        (char >= "A" && char <= "Z") ||
        char === "-" ||
        char === "_",
    );
  if (!valid) {
    throw new AppError(
      "REQUEST_INVALID",
      "validation",
      400,
      "hotel id is not valid.",
    );
  }
  return id;
}

export const placeRoutes: RouteModule = async (context) => {
  const { method, url } = context;
  const countriesPath = matchPath(url.pathname, `${PLACES}/countries`);
  const citiesPath = matchPath(url.pathname, `${PLACES}/cities`);
  const hotelRatesPath = matchPath(
    url.pathname,
    `${PLACES}/hotels/:hotelId/rates`,
  );
  const hotelPath = matchPath(url.pathname, `${PLACES}/hotels/:hotelId`);
  const airportNearbyPath = matchPath(url.pathname, `${PLACES}/airports/nearby`);
  const airportsPath = matchPath(url.pathname, `${PLACES}/airports`);
  if (
    !countriesPath &&
    !citiesPath &&
    !hotelPath &&
    !hotelRatesPath &&
    !airportsPath &&
    !airportNearbyPath
  )
    return false;
  if (method !== "GET") return false;

  const session = await context.authenticate();

  if (airportNearbyPath) {
    take(context, session.user.id, "airport-nearby");
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "lat and lon must be valid coordinates.",
      );
    }
    const place = await reverseGeocode(lat, lon);
    const from = { lat, lon };
    const nearbyLimit = 4;
    let airports: LiteAirport[] = [];
    if (place.city) {
      const candidates = await airportsByQuery(context, place.city);
      airports = candidates
        .filter((airport) => airport.lat !== null && airport.lon !== null)
        .filter((airport) => airport.has_airline_service)
        .map((airport) => airport)
        .sort(
          (left, right) =>
            distanceKm(from, { lat: left.lat as number, lon: left.lon as number }) -
            distanceKm(from, { lat: right.lat as number, lon: right.lon as number }),
        )
        .slice(0, nearbyLimit);
      if (airports.length === 0) {
        // "Jakarta Barat" is a neighbourhood to the provider; the first word is the city.
        const first = place.city.split(" ")[0] ?? place.city;
        const wider = await airportsByQuery(context, first);
        airports = wider
          .filter((airport) => airport.lat !== null && airport.lon !== null)
          .filter((airport) => airport.has_airline_service)
          .sort(
            (left, right) =>
              distanceKm(from, { lat: left.lat as number, lon: left.lon as number }) -
              distanceKm(from, { lat: right.lat as number, lon: right.lon as number }),
          )
          .slice(0, nearbyLimit);
      }
    }
    writeJson(context.response, 200, {
      city: place.city,
      country: place.country,
      label: place.label,
      airports: airports.map((airport) => ({
        ...airport,
        distance_km: Math.round(
          distanceKm(from, { lat: airport.lat as number, lon: airport.lon as number }) * 10,
        ) / 10,
      })),
      request_id: context.requestId,
    });
    return true;
  }

  if (airportsPath) {
    take(context, session.user.id, "airports");
    const query = (url.searchParams.get("q") ?? "").trim();
    const countryCode = (url.searchParams.get("country") ?? "").trim().toUpperCase();
    let airports: LiteAirport[] = [];
    if (countryCode.length === 2) {
      const list = await countries(context);
      const named = list.countries.find((entry) => entry.code === countryCode);
      if (!named) {
        throw new AppError(
          "REQUEST_INVALID",
          "validation",
          400,
          "country is not in the provider's list.",
        );
      }
      airports = await airportsForCountry(context, countryCode, named.name);
      if (query.length > 0) {
        const needle = query.toLowerCase();
        airports = airports.filter(
          (airport) =>
            airport.city.toLowerCase().includes(needle) ||
            airport.name.toLowerCase().includes(needle) ||
            airport.iata.toLowerCase() === needle,
        );
      }
    } else if (query.length >= 2) {
      airports = await airportsByQuery(context, query);
    } else {
      throw new AppError(
        "REQUEST_INVALID",
        "validation",
        400,
        "q or country is required.",
      );
    }
    writeJson(context.response, 200, {
      airports: airports.slice(0, 60),
      total: airports.length,
      request_id: context.requestId,
    });
    return true;
  }

  if (countriesPath) {
    take(context, session.user.id, "countries");
    const cached = await countries(context);
    writeJson(context.response, 200, {
      countries: cached.countries,
      request_id: context.requestId,
    });
    return true;
  }

  if (hotelRatesPath) {
    take(context, session.user.id, "hotel-rates");
    const id = hotelIdParam(hotelRatesPath.hotelId);
    const value = await rates(context, id);
    writeJson(context.response, 200, {
      hotel_id: id,
      ...value,
      request_id: context.requestId,
    });
    return true;
  }

  if (hotelPath) {
    take(context, session.user.id, "hotel");
    const id = hotelIdParam(hotelPath.hotelId);
    const cached = await hotel(context, id);
    writeJson(context.response, 200, {
      hotel: cached.content,
      reviews: cached.reviews,
      request_id: context.requestId,
    });
    return true;
  }

  take(context, session.user.id, "cities");
  const code = countryParam(context);
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const max = Number.isInteger(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 500)
    : 50;
  const cached = await cities(context, code);
  const query = url.searchParams.get("q") ?? "";
  const filtered = filterCities(cached.cities, query, max, firstNameParam(context));
  const needle = query.trim().toLowerCase();
  // The form uses this to reject a city that belongs to another country, which
  // the rate search would otherwise answer with an empty result.
  const exact =
    needle.length > 0 &&
    cached.cities.some((city) => city.toLowerCase() === needle);
  writeJson(context.response, 200, {
    country: code,
    cities: filtered.items,
    total: filtered.total,
    exact,
    request_id: context.requestId,
  });
  return true;
};
