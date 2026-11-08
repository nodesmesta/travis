import { LiteApiClient } from "@travelflow/integrations";
import { AppError } from "../errors.js";
import { writeJson } from "../http.js";
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
  const hotelPath = matchPath(url.pathname, `${PLACES}/hotels/:hotelId`);
  if (!countriesPath && !citiesPath && !hotelPath) return false;
  if (method !== "GET") return false;

  const session = await context.authenticate();

  if (countriesPath) {
    take(context, session.user.id, "countries");
    const cached = await countries(context);
    writeJson(context.response, 200, {
      countries: cached.countries,
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
