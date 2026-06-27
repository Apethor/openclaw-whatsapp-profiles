import type { AppConfig } from './config.js';

type WeatherConfig = AppConfig['weather'];

export type WeatherPromptContext = {
  status: 'available' | 'needs_location' | 'unavailable';
  prompt: string;
  confidence?: 'high' | 'medium' | 'low';
  locationLabel?: string;
};

type LocationSource = 'whatsapp_location' | 'message_coordinates' | 'message_text';

type WeatherLocation = {
  latitude: number;
  longitude: number;
  label: string;
  source: LocationSource;
  accuracy?: number;
  query?: string;
  candidateCount?: number;
};

type RequestedDate = {
  label: string;
  offsetDays: number;
};

type GeocodingResponse = {
  results?: GeocodingResult[];
};

type GeocodingResult = {
  name?: string;
  latitude?: number;
  longitude?: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  admin2?: string;
  timezone?: string;
  population?: number;
};

type ForecastResponse = {
  latitude?: number;
  longitude?: number;
  timezone?: string;
  timezone_abbreviation?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    relative_humidity_2m?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    weather_code?: number;
    cloud_cover?: number;
    wind_speed_10m?: number;
    wind_gusts_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    precipitation_probability?: number[];
    precipitation?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
    wind_gusts_10m?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    precipitation_probability_max?: number[];
    wind_speed_10m_max?: number[];
    wind_gusts_10m_max?: number[];
  };
};

const WEATHER_CODE_LABELS: Record<number, string> = {
  0: 'ceu limpo',
  1: 'principalmente limpo',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'neblina',
  48: 'neblina com gelo',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa forte',
  56: 'garoa congelante fraca',
  57: 'garoa congelante forte',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  66: 'chuva congelante fraca',
  67: 'chuva congelante forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  77: 'graos de neve',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes',
  85: 'pancadas de neve fracas',
  86: 'pancadas de neve fortes',
  95: 'trovoadas',
  96: 'trovoadas com granizo leve',
  99: 'trovoadas com granizo forte'
};

const LOCATION_ALIASES: Record<string, string> = {
  bh: 'Belo Horizonte',
  bsb: 'Brasilia',
  poa: 'Porto Alegre',
  rj: 'Rio de Janeiro',
  sp: 'Sao Paulo'
};

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s.,:/?-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForIndex(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function isWeatherIntent(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  return [
    /\b(previsao do tempo|previsao|meteorologia|clima|temperatura|chuva|chover|chovendo|garoa|temporal|vento|umidade)\b/u,
    /\b(como esta|como ta|como fica|qual e)\s+o?\s*tempo\b/u,
    /\btempo\s+(hoje|amanha|agora|em|no|na|para|pra)\b/u,
    /\b(weather|forecast|rain|temperature)\b/u
  ].some((pattern) => pattern.test(normalized));
}

function isShortLocationLikeText(text: string): boolean {
  const raw = text.trim();
  const normalized = normalizeText(raw);
  if (!normalized || raw.length > 100 || raw.includes('?')) {
    return false;
  }

  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 10) {
    return false;
  }

  if (
    /\b(sim|nao|ok|blz|beleza|valeu|obrigado|obrigada|cancela|esquece|deixa|precisa|tenta|manda|responde)\b/u.test(
      normalized
    )
  ) {
    return false;
  }

  return [
    /\b\d{5}-?\d{3}\b/u,
    /\b(cep|bairro|cidade|rua|avenida|av|alameda|travessa|estrada|rodovia|centro|zona)\b/u,
    /\b(sao paulo|rio de janeiro|minas gerais|espirito santo|rio grande do sul|rio grande do norte|santa catarina|mato grosso|mato grosso do sul|distrito federal)\b/u,
    /\b(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)\b/u
  ].some((pattern) => pattern.test(normalized)) || (/[,/]/u.test(raw) && /\p{Letter}/u.test(raw));
}

function isWeatherLocationFollowup(input: { text: string; metadata?: Record<string, unknown> }): boolean {
  return Boolean(
    locationFromMetadata(input.metadata) ||
      locationFromCoordinates(input.text) ||
      isShortLocationLikeText(input.text)
  );
}

function hasWeatherLocation(input: { text: string; metadata?: Record<string, unknown> }): boolean {
  return Boolean(locationFromMetadata(input.metadata) || locationFromCoordinates(input.text) || extractLocationQuery(input.text));
}

export function buildWeatherLookupText(input: {
  text: string;
  metadata?: Record<string, unknown>;
  conversationContext?: Array<{ role: 'inbound' | 'outbound'; text: string; createdAt: number }>;
  now?: Date;
  maxFollowUpAgeMs?: number;
}): string {
  const currentWeatherIntent = isWeatherIntent(input.text);
  const nowMs = input.now?.getTime() ?? Date.now();
  const maxAgeMs = input.maxFollowUpAgeMs ?? 15 * 60 * 1000;
  const recentInbound = [...(input.conversationContext ?? [])]
    .reverse()
    .filter((entry) => entry.role === 'inbound' && nowMs - entry.createdAt <= maxAgeMs);

  if (currentWeatherIntent) {
    if (hasWeatherLocation(input)) {
      return input.text;
    }

    const previousLocation = recentInbound.find((entry) => isWeatherLocationFollowup({ text: entry.text }));
    if (!previousLocation) {
      return input.text;
    }

    const locationText = previousLocation.text.trim() || 'localizacao compartilhada no WhatsApp';
    return `${input.text}\nLocalizacao: em ${locationText}`;
  }

  if (!isWeatherLocationFollowup(input)) {
    return input.text;
  }

  const previousWeatherRequest = recentInbound.find((entry) => isWeatherIntent(entry.text));
  if (!previousWeatherRequest) {
    return input.text;
  }

  const locationText = input.text.trim() || 'localizacao compartilhada no WhatsApp';
  return `${previousWeatherRequest.text}\nLocalizacao: em ${locationText}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberFromUnknown(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstNumber(sources: Array<Record<string, unknown>>, keys: string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = numberFromUnknown(source[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function firstString(sources: Array<Record<string, unknown>>, keys: string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = stringFromUnknown(source[key]);
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

function validLatitude(value: number | undefined): value is number {
  return value !== undefined && value >= -90 && value <= 90;
}

function validLongitude(value: number | undefined): value is number {
  return value !== undefined && value >= -180 && value <= 180;
}

function locationFromMetadata(metadata: Record<string, unknown> | undefined): WeatherLocation | undefined {
  if (!metadata) {
    return undefined;
  }

  const nestedLocation = isRecord(metadata.location) ? metadata.location : undefined;
  const sources = [metadata, ...(nestedLocation ? [nestedLocation] : [])];
  const latitude = firstNumber(sources, [
    'LocationLat',
    'LocationLatitude',
    'locationLat',
    'locationLatitude',
    'latitude',
    'lat',
    'degreesLatitude'
  ]);
  const longitude = firstNumber(sources, [
    'LocationLon',
    'LocationLng',
    'LocationLongitude',
    'locationLon',
    'locationLng',
    'locationLongitude',
    'longitude',
    'lon',
    'lng',
    'degreesLongitude'
  ]);

  if (!validLatitude(latitude) || !validLongitude(longitude)) {
    return undefined;
  }

  const name = firstString(sources, ['LocationName', 'locationName', 'name']);
  const address = firstString(sources, ['LocationAddress', 'locationAddress', 'address']);
  const caption = firstString(sources, ['LocationCaption', 'locationCaption', 'caption']);
  const accuracy = firstNumber(sources, ['LocationAccuracy', 'locationAccuracy', 'accuracy']);
  const label = [name, address, caption].find(Boolean) ?? `localizacao do WhatsApp ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  return {
    latitude,
    longitude,
    label,
    source: 'whatsapp_location',
    accuracy
  };
}

function locationFromCoordinates(text: string): WeatherLocation | undefined {
  const match = text.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)/u);
  if (!match) {
    return undefined;
  }

  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!validLatitude(latitude) || !validLongitude(longitude)) {
    return undefined;
  }

  return {
    latitude,
    longitude,
    label: `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
    source: 'message_coordinates'
  };
}

function stripDateWords(value: string): string {
  const stop = normalizeForIndex(value).search(
    /\b(hoje|amanha|agora|depois de amanha|domingo|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado)\b/iu
  );
  return (stop >= 0 ? value.slice(0, stop) : value).trim();
}

function cleanupLocationQuery(value: string): string | undefined {
  const cleaned = normalizeText(stripDateWords(value))
    .replace(/\b(previsao do tempo|previsao|tempo|clima|meteorologia|chuva|chover|temperatura|weather|forecast|rain|temperature)\b/giu, ' ')
    .replace(/[?!.,;:]+$/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) {
    return undefined;
  }

  return LOCATION_ALIASES[normalizeText(cleaned)] ?? cleaned;
}

function extractLocationQuery(text: string): string | undefined {
  const withoutCoordinates = text.replace(/-?\d{1,2}(?:\.\d+)?\s*[,;]\s*-?\d{1,3}(?:\.\d+)?/gu, ' ');
  const direct = withoutCoordinates.match(/\b(?:em|no|na|nos|nas|para|pra|pro|pros|pras)\s+([^?\n]+)/iu);
  const possessive = withoutCoordinates.match(/\b(?:de|do|da)\s+([^?\n]+)/iu);
  const query = cleanupLocationQuery(direct?.[1] ?? possessive?.[1] ?? '');
  if (query) {
    return query;
  }

  // Fallback: the planner often emits the bare location with no preposition
  // ("Dallas", "Rio Pequeno São Paulo"). Treat the whole cleaned text as the
  // location — geocodeSingleLocation validates the result name, so filler that
  // collapses to a stray word ("vai chover hoje?" -> "vai") is rejected instead
  // of being fuzzy-matched to a random town.
  return cleanupLocationQuery(withoutCoordinates);
}

function formatDateInTimeZone(date: Date, timeZone?: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function isoDateToUtcMs(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function dayDifference(fromIso: string, toIso: string): number {
  return Math.round((isoDateToUtcMs(toIso) - isoDateToUtcMs(fromIso)) / 86_400_000);
}

function resolveRequestedDate(text: string, now: Date): RequestedDate {
  const normalized = normalizeText(text);
  const todayIso = formatDateInTimeZone(now);
  const explicitDate = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  if (explicitDate) {
    return {
      label: explicitDate,
      offsetDays: dayDifference(todayIso, explicitDate)
    };
  }

  if (/\bdepois de amanha\b/u.test(normalized)) {
    return { label: 'depois de amanha', offsetDays: 2 };
  }

  if (/\bamanha\b/u.test(normalized)) {
    return { label: 'amanha', offsetDays: 1 };
  }

  const weekdayPatterns: Array<[RegExp, number, string]> = [
    [/\bdomingo\b/u, 0, 'domingo'],
    [/\bsegunda(?: feira)?\b/u, 1, 'segunda'],
    [/\bterca(?: feira)?\b/u, 2, 'terca'],
    [/\bquarta(?: feira)?\b/u, 3, 'quarta'],
    [/\bquinta(?: feira)?\b/u, 4, 'quinta'],
    [/\bsexta(?: feira)?\b/u, 5, 'sexta'],
    [/\bsabado\b/u, 6, 'sabado']
  ];
  const currentWeekday = now.getDay();
  for (const [pattern, weekday, label] of weekdayPatterns) {
    if (pattern.test(normalized)) {
      const offset = (weekday - currentWeekday + 7) % 7;
      return {
        label,
        offsetDays: offset
      };
    }
  }

  return { label: 'hoje', offsetDays: 0 };
}

async function fetchJson<T>(url: URL, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`weather api returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function formatGeocodeLabel(result: GeocodingResult): string {
  return [result.name, result.admin2, result.admin1, result.country]
    .filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index)
    .join(', ');
}

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

const BR_STATE_SUFFIX = /\s+(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/iu;

function geocodeQueryCandidates(query: string): string[] {
  const candidates: string[] = [query];

  // Explicit separators: "bairro, cidade" / "a / b".
  for (const part of query.split(/[\/,;]/u)) {
    const cleaned = cleanupLocationQuery(part);
    if (cleaned && cleaned.length > 2) {
      candidates.push(cleaned);
    }
  }

  // Brazilians often append the state code ("sao paulo sp") or a neighborhood
  // ("rio pequeno sao paulo sp"), which Open-Meteo can't geocode as one string.
  // Strip a trailing UF, then fall back to the last word-groups (the city is
  // usually at the end). geocodeLocation tries candidates in order and keeps the
  // first that resolves, so more specific strings are attempted first.
  const ufStripped = query.replace(BR_STATE_SUFFIX, '').trim();
  if (ufStripped && ufStripped !== query && ufStripped.length > 2) {
    candidates.push(ufStripped);
  }
  const words = ufStripped.split(/\s+/u).filter(Boolean);
  for (const n of [3, 2, 1]) {
    if (words.length > n) {
      candidates.push(words.slice(-n).join(' '));
    }
  }

  return uniqueValues(candidates.filter((candidate) => candidate.length > 1)).slice(0, 6);
}

async function geocodeSingleLocation(query: string, originalQuery: string, config: WeatherConfig): Promise<WeatherLocation | undefined> {
  const url = new URL('/v1/search', config.geocodingBaseUrl.replace(/\/$/, ''));
  url.searchParams.set('name', query);
  url.searchParams.set('count', '3');
  url.searchParams.set('language', config.geocodingLanguage);
  url.searchParams.set('format', 'json');
  if (config.geocodingCountryCode) {
    url.searchParams.set('countryCode', config.geocodingCountryCode);
  }

  const data = await fetchJson<GeocodingResponse>(url, config.timeoutMs);
  const results = (data.results ?? []).filter(
    (result) => validLatitude(result.latitude) && validLongitude(result.longitude)
  );
  const [best] = results.sort((left, right) => (right.population ?? 0) - (left.population ?? 0));
  if (!best || !validLatitude(best.latitude) || !validLongitude(best.longitude)) {
    return undefined;
  }

  // The Open-Meteo geocoder fuzzy-matches anything to some place ("vai" ->
  // "Vanimo"). Accept when the result name relates to the query OR it is a large
  // city (a confident match even when the localized name differs from the query,
  // e.g. "moscow" -> "Moscovo", "tokyo" -> "Tóquio"). Stray words from a
  // locationless message only match low-population places and are rejected.
  const queryNormalized = normalizeForIndex(query);
  const nameNormalized = normalizeForIndex(best.name ?? '');
  const nameRelatesToQuery =
    nameNormalized.length > 0 &&
    (queryNormalized.includes(nameNormalized) ||
      nameNormalized.includes(queryNormalized) ||
      queryNormalized.split(/\s+/u).some((word) => word.length > 3 && nameNormalized.includes(word)));
  const isMajorCity = (best.population ?? 0) >= 100_000;
  if (!nameRelatesToQuery && !isMajorCity) {
    return undefined;
  }

  return {
    latitude: best.latitude,
    longitude: best.longitude,
    label: formatGeocodeLabel(best) || query,
    source: 'message_text',
    query: query === originalQuery ? query : `${originalQuery} -> ${query}`,
    candidateCount: results.length
  };
}

async function geocodeLocation(query: string, config: WeatherConfig): Promise<WeatherLocation | undefined> {
  for (const candidate of geocodeQueryCandidates(query)) {
    const location = await geocodeSingleLocation(candidate, query, config);
    if (location) {
      return location;
    }
  }

  return undefined;
}

async function resolveLocation(
  text: string,
  metadata: Record<string, unknown> | undefined,
  config: WeatherConfig
): Promise<WeatherLocation | undefined> {
  const metadataLocation = locationFromMetadata(metadata);
  if (metadataLocation) {
    return metadataLocation;
  }

  const coordinateLocation = locationFromCoordinates(text);
  if (coordinateLocation) {
    return coordinateLocation;
  }

  const query = extractLocationQuery(text);
  if (!query) {
    return undefined;
  }

  return geocodeLocation(query, config);
}

function conditionLabel(code: number | undefined): string {
  return code === undefined ? 'condicao nao informada' : WEATHER_CODE_LABELS[code] ?? `codigo meteorologico ${code}`;
}

function formatNumber(value: number | undefined, digits = 0): string {
  return value === undefined || !Number.isFinite(value) ? 'n/d' : value.toFixed(digits);
}

function formatMetric(label: string, value: number | undefined, unit: string, digits = 0): string {
  return `${label} ${formatNumber(value, digits)}${unit}`;
}

function confidenceFor(location: WeatherLocation, offsetDays: number): 'high' | 'medium' | 'low' {
  let score =
    location.source === 'whatsapp_location'
      ? 0.9
      : location.source === 'message_coordinates'
        ? 0.82
        : 0.68;

  if ((location.candidateCount ?? 0) > 1) {
    score -= 0.1;
  }
  if (offsetDays > 7) {
    score -= 0.18;
  } else if (offsetDays > 3) {
    score -= 0.08;
  }

  if (score >= 0.75) {
    return 'high';
  }
  if (score >= 0.5) {
    return 'medium';
  }
  return 'low';
}

function hourlyHighlights(forecast: ForecastResponse, selectedDate: string): string[] {
  const hourly = forecast.hourly;
  if (!hourly?.time?.length) {
    return [];
  }

  const wantedTimes = ['06:00', '12:00', '18:00', '21:00'];
  const lines: string[] = [];
  for (const wanted of wantedTimes) {
    const index = hourly.time.findIndex((time) => time.startsWith(`${selectedDate}T${wanted}`));
    if (index < 0) {
      continue;
    }

    lines.push(
      [
        wanted,
        conditionLabel(hourly.weather_code?.[index]),
        formatMetric('temp', hourly.temperature_2m?.[index], 'C'),
        formatMetric('sensacao', hourly.apparent_temperature?.[index], 'C'),
        formatMetric('chuva', hourly.precipitation_probability?.[index], '%'),
        formatMetric('vento', hourly.wind_speed_10m?.[index], ' km/h')
      ].join('; ')
    );
  }

  return lines;
}

async function fetchForecast(location: WeatherLocation, requestedDate: RequestedDate, config: WeatherConfig): Promise<ForecastResponse> {
  const url = new URL('/v1/forecast', config.forecastBaseUrl.replace(/\/$/, ''));
  const forecastDays = Math.min(16, Math.max(1, requestedDate.offsetDays + 1));
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set(
    'current',
    [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'precipitation',
      'rain',
      'showers',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
      'wind_gusts_10m'
    ].join(',')
  );
  url.searchParams.set(
    'hourly',
    [
      'temperature_2m',
      'apparent_temperature',
      'precipitation_probability',
      'precipitation',
      'weather_code',
      'wind_speed_10m',
      'wind_gusts_10m'
    ].join(',')
  );
  url.searchParams.set(
    'daily',
    [
      'weather_code',
      'temperature_2m_max',
      'temperature_2m_min',
      'precipitation_sum',
      'precipitation_probability_max',
      'wind_speed_10m_max',
      'wind_gusts_10m_max'
    ].join(',')
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(forecastDays));

  return fetchJson<ForecastResponse>(url, config.timeoutMs);
}

function buildForecastPrompt(
  location: WeatherLocation,
  requestedDate: RequestedDate,
  forecast: ForecastResponse,
  config: WeatherConfig,
  fetchedAt: Date
): WeatherPromptContext {
  const daily = forecast.daily;
  const selectedDate = daily?.time?.[requestedDate.offsetDays];
  const confidence = confidenceFor(location, requestedDate.offsetDays);

  if (!selectedDate) {
    return {
      status: 'unavailable',
      confidence,
      locationLabel: location.label,
      prompt: [
        'Pedido de clima detectado.',
        `Fonte tentada: Open-Meteo Forecast API (${config.forecastBaseUrl}/v1/forecast).`,
        `Consulta feita em: ${fetchedAt.toISOString()}.`,
        `Local resolvido: ${location.label} (${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}).`,
        `Data pedida: ${requestedDate.label}.`,
        'Resultado: a data nao veio no retorno da previsao estruturada.',
        'Instrucao: diga de forma curta que nao conseguiu consultar uma previsao confiavel para essa data.'
      ].join('\n')
    };
  }

  const dailyLine = [
    conditionLabel(daily?.weather_code?.[requestedDate.offsetDays]),
    formatMetric('min', daily?.temperature_2m_min?.[requestedDate.offsetDays], 'C'),
    formatMetric('max', daily?.temperature_2m_max?.[requestedDate.offsetDays], 'C'),
    formatMetric('chance chuva max', daily?.precipitation_probability_max?.[requestedDate.offsetDays], '%'),
    formatMetric('chuva total', daily?.precipitation_sum?.[requestedDate.offsetDays], ' mm', 1),
    formatMetric('vento max', daily?.wind_speed_10m_max?.[requestedDate.offsetDays], ' km/h')
  ].join('; ');
  const current = forecast.current;
  const currentLine =
    requestedDate.offsetDays === 0 && current
      ? [
          `Condicao atual (${current.time ?? 'horario n/d'})`,
          conditionLabel(current.weather_code),
          formatMetric('temp', current.temperature_2m, 'C'),
          formatMetric('sensacao', current.apparent_temperature, 'C'),
          formatMetric('umidade', current.relative_humidity_2m, '%'),
          formatMetric('precipitacao', current.precipitation, ' mm', 1),
          formatMetric('vento', current.wind_speed_10m, ' km/h')
        ].join('; ')
      : undefined;
  const hourlyLines = hourlyHighlights(forecast, selectedDate);
  const locationSource =
    location.source === 'whatsapp_location'
      ? 'localizacao compartilhada no WhatsApp'
      : location.source === 'message_coordinates'
        ? 'coordenadas na mensagem'
        : `geocoding do texto${location.query ? ` "${location.query}"` : ''}`;

  return {
    status: 'available',
    confidence,
    locationLabel: location.label,
    prompt: [
      'Pedido de clima detectado.',
      `Fonte: Open-Meteo Forecast API (${config.forecastBaseUrl}/v1/forecast).`,
      `Consulta feita em: ${fetchedAt.toISOString()}.`,
      `Horario/base da previsao: timezone=${forecast.timezone ?? 'auto'}${forecast.timezone_abbreviation ? ` (${forecast.timezone_abbreviation})` : ''}; data=${selectedDate}; atual=${current?.time ?? 'n/d'}.`,
      `Local resolvido: ${location.label} (${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}); origem=${locationSource}; confianca=${confidence}.`,
      `Previsao diaria: ${dailyLine}.`,
      currentLine,
      hourlyLines.length ? `Horarios selecionados: ${hourlyLines.join(' | ')}.` : undefined,
      'Instrucao: use somente estes dados para clima. Se responder com a previsao, cite fonte, horario/base e confianca de forma curta.'
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n')
  };
}

function buildNeedsLocationPrompt(config: WeatherConfig, fetchedAt: Date): WeatherPromptContext {
  return {
    status: 'needs_location',
    prompt: [
      'Pedido de clima detectado.',
      `Fonte disponivel: Open-Meteo Forecast API (${config.forecastBaseUrl}/v1/forecast).`,
      `Consulta avaliada em: ${fetchedAt.toISOString()}.`,
      'Resultado: nenhuma cidade/bairro foi detectada no texto e nao veio LocationLat/LocationLon do WhatsApp.',
      'Instrucao: peca a cidade/bairro ou uma localizacao do WhatsApp. Nao invente previsao.'
    ].join('\n')
  };
}

function buildUnavailablePrompt(reason: string, config: WeatherConfig, fetchedAt: Date): WeatherPromptContext {
  return {
    status: 'unavailable',
    prompt: [
      'Pedido de clima detectado.',
      `Fonte tentada: Open-Meteo Forecast API (${config.forecastBaseUrl}/v1/forecast).`,
      `Consulta feita em: ${fetchedAt.toISOString()}.`,
      `Resultado: ${reason}.`,
      'Instrucao: diga de forma curta que nao conseguiu verificar a previsao estruturada agora; nao use busca textual como substituto.'
    ].join('\n')
  };
}

export async function resolveWeatherPromptContext(input: {
  text: string;
  metadata?: Record<string, unknown>;
  weather: WeatherConfig;
  now?: Date;
  force?: boolean;
}): Promise<WeatherPromptContext | undefined> {
  if (!input.force && !isWeatherIntent(input.text)) {
    return undefined;
  }

  const fetchedAt = input.now ?? new Date();
  if (!input.weather.enabled) {
    return buildUnavailablePrompt('recurso de clima estruturado desabilitado', input.weather, fetchedAt);
  }

  const requestedDate = resolveRequestedDate(input.text, fetchedAt);
  if (requestedDate.offsetDays < 0) {
    return buildUnavailablePrompt('a data pedida esta no passado para uma previsao', input.weather, fetchedAt);
  }
  if (requestedDate.offsetDays > 15) {
    return buildUnavailablePrompt('a data pedida esta alem da janela de previsao de 16 dias', input.weather, fetchedAt);
  }

  try {
    const location = await resolveLocation(input.text, input.metadata, input.weather);
    if (!location) {
      return buildNeedsLocationPrompt(input.weather, fetchedAt);
    }

    const forecast = await fetchForecast(location, requestedDate, input.weather);
    return buildForecastPrompt(location, requestedDate, forecast, input.weather, fetchedAt);
  } catch {
    return buildUnavailablePrompt('falha ao consultar a API meteorologica estruturada', input.weather, fetchedAt);
  }
}
