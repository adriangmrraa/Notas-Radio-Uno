/**
 * rrule.ts — helper mínimo de recurrencia RRULE (iCalendar/RFC 5545) para
 * `scheduled_transmissions`. Puro y testeable: sin DB, sin IO, sin dependencias.
 *
 * Soporta FREQ=DAILY|WEEKLY|MONTHLY|YEARLY con INTERVAL, BYDAY, BYHOUR,
 * BYMINUTE, BYMONTHDAY, UNTIL y COUNT. Toda la aritmética de fecha/hora se hace
 * en la timezone IANA indicada (la del tenant/programa), NO en la del server:
 * un `from` se expande a hora local con Intl.DateTimeFormat y las ocurrencias
 * candidatas (wall-clock) se contraen de vuelta a instantes UTC.
 *
 * Semántica documentada:
 *   - `nextOccurrence` devuelve el primer instante estrictamente posterior a
 *     `from` (si `from` cae justo en una ocurrencia, esa ya se considera usada).
 *   - Sin DTSTART persistido, INTERVAL y COUNT se anclan en el PERÍODO local de
 *     `from` (día/semana/mes/año que contiene a `from` en la tz): INTERVAL salta
 *     períodos desde ese ancla y COUNT cuenta ocurrencias de la serie a partir
 *     de ahí. Cuando el scheduler guarde `starts_at`, anclar pasándolo como
 *     `from` en la primera llamada reproduce la semántica RFC completa.
 *   - Sin BYHOUR/BYMINUTE se usa la hora/minuto local de `from` (equivalente a
 *     DTSTART). Sin BYDAY (WEEKLY) el weekday de `from`; sin BYMONTHDAY
 *     (MONTHLY/YEARLY) el día de mes de `from`.
 */
export type RRuleFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ParsedRRule {
  freq: RRuleFreq;
  interval: number;
  /** Weekdays JS: 0=domingo … 6=sábado, orden MO→SU. Vacío = "el de `from`". */
  byDay: number[];
  /** Horas 0-23 asc. Vacío = "la hora de `from`". */
  byHour: number[];
  /** Minutos 0-59 asc. Vacío = "el minuto de `from`". */
  byMinute: number[];
  /** Días de mes -31..31 (≠0; negativos cuentan desde el fin). Vacío = "el de `from`". */
  byMonthDay: number[];
  until?: UntilBound;
  count?: number;
}

export interface UntilBound {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** true si venía con Z (instante UTC); false = wall-clock en la tz de la regla. */
  utc: boolean;
  /** true si era YYYYMMDD sin hora (el límite cubre el día entero, inclusive). */
  dateOnly: boolean;
}

// ── Parse ─────────────────────────────────────────────────────────────────────

const SUPPORTED_FREQS: readonly string[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const KNOWN_KEYS = new Set([
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYMONTHDAY',
]);
const IGNORED_KEYS = new Set(['WKST']); // inofensivo para reglas día-granulares
const WEEKDAY_CODE: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

export function parseRRule(rrule: string): ParsedRRule {
  const text = (rrule ?? '').trim();
  if (!text) throw new Error('RRULE inválido: el string está vacío');

  const body = text.replace(/^RRULE:/i, '');
  const props = new Map<string, string>();
  for (const segment of body.split(';')) {
    const seg = segment.trim();
    if (!seg) continue;
    const eq = seg.indexOf('=');
    if (eq <= 0) throw new Error(`RRULE inválido: segmento "${seg}" sin formato CLAVE=valor`);
    const key = seg.slice(0, eq).trim().toUpperCase();
    const value = seg.slice(eq + 1).trim().toUpperCase();
    if (!key) throw new Error(`RRULE inválido: segmento "${seg}" con clave vacía`);
    if (!value) throw new Error(`RRULE inválido: "${key}" sin valor`);
    if (props.has(key)) throw new Error(`RRULE inválido: "${key}" duplicado`);
    props.set(key, value);
  }

  const freqRaw = props.get('FREQ');
  if (!freqRaw) throw new Error('RRULE inválido: falta la clave obligatoria FREQ');
  if (!SUPPORTED_FREQS.includes(freqRaw)) {
    throw new Error(`RRULE inválido: FREQ=${freqRaw} no soportado (soportados: ${SUPPORTED_FREQS.join(', ')})`);
  }

  for (const key of props.keys()) {
    if (!KNOWN_KEYS.has(key) && !IGNORED_KEYS.has(key)) {
      throw new Error(`RRULE inválido: clave "${key}" no soportada`);
    }
  }

  return {
    freq: freqRaw as RRuleFreq,
    interval: props.has('INTERVAL') ? parsePositiveInt(props.get('INTERVAL')!, 'INTERVAL') : 1,
    count: props.has('COUNT') ? parsePositiveInt(props.get('COUNT')!, 'COUNT') : undefined,
    until: props.has('UNTIL') ? parseUntil(props.get('UNTIL')!) : undefined,
    byDay: parseByDay(props.get('BYDAY')),
    byHour: parseNumList(props.get('BYHOUR'), 'BYHOUR', 0, 23),
    byMinute: parseNumList(props.get('BYMINUTE'), 'BYMINUTE', 0, 59),
    byMonthDay: parseNumList(props.get('BYMONTHDAY'), 'BYMONTHDAY', -31, 31, (n) => n !== 0),
  };
}

function parsePositiveInt(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`RRULE inválido: ${key}="${raw}" tiene que ser un entero ≥ 1`);
  }
  return n;
}

function parseNumList(
  raw: string | undefined,
  key: string,
  min: number,
  max: number,
  extra?: (n: number) => boolean,
): number[] {
  if (raw === undefined) return [];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < min || n > max || (extra !== undefined && !extra(n))) {
      throw new Error(`RRULE inválido: ${key} con valor fuera de rango "${part.trim()}" (${min}..${max}, ≠0)`);
    }
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function parseByDay(raw: string | undefined): number[] {
  if (raw === undefined) return [];
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const code = part.trim();
    if (/^-?\d/.test(code)) {
      throw new Error(`RRULE inválido: BYDAY con ordinal "${code}" no soportado (usá códigos SU,MO,TU,WE,TH,FR,SA)`);
    }
    if (!(code in WEEKDAY_CODE)) {
      throw new Error(`RRULE inválido: BYDAY con día inexistente "${code}" (válidos: SU,MO,TU,WE,TH,FR,SA)`);
    }
    out.add(WEEKDAY_CODE[code]);
  }
  return [...out].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

function parseUntil(raw: string): UntilBound {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) {
    throw new Error(`RRULE inválido: UNTIL="${raw}" sin formato YYYYMMDD[THHMMSS[Z]]`);
  }
  const bound: UntilBound = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: m[4] !== undefined ? Number(m[4]) : 0,
    minute: m[5] !== undefined ? Number(m[5]) : 0,
    second: m[6] !== undefined ? Number(m[6]) : 0,
    utc: m[7] === 'Z',
    dateOnly: m[4] === undefined,
  };
  const dim = daysInMonth(bound.year, bound.month);
  if (bound.month < 1 || bound.month > 12 || bound.day < 1 || bound.day > dim) {
    throw new Error(`RRULE inválido: UNTIL="${raw}" con fecha inexistente`);
  }
  if (bound.hour > 23 || bound.minute > 59 || bound.second > 59) {
    throw new Error(`RRULE inválido: UNTIL="${raw}" con hora fuera de rango`);
  }
  return bound;
}

// ── Aritmética en timezone (Intl, sin libs) ───────────────────────────────────

const MS_PER_DAY = 86_400_000;
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  epochDay: number;
  weekday: number;
}

/** Instante → componentes wall-clock en `timeZone` (más epochDay/weekday locales). */
function localParts(instant: Date, timeZone: string): LocalDateTime {
  const parts = formatter(timeZone).formatToParts(instant);
  let year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0;
  for (const p of parts) {
    const n = Number(p.value);
    if (p.type === 'year') year = n;
    else if (p.type === 'month') month = n;
    else if (p.type === 'day') day = n;
    else if (p.type === 'hour') hour = n;
    else if (p.type === 'minute') minute = n;
    else if (p.type === 'second') second = n;
  }
  const epochDay = Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
  // epochDay 0 = 1970-01-01 = jueves; weekday JS: domingo=0 … sábado=6.
  const weekday = (((epochDay + 4) % 7) + 7) % 7;
  return { year, month, day, hour, minute, second, epochDay, weekday };
}

/** Offset de la tz respecto a UTC en un instante: utcMs + offset = wall-clock local. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const p = localParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * Wall-clock local (componentes en `timeZone`) → instante UTC en ms.
 * Doble lectura del offset: si el instante cae cerca de un cambio de DST, el
 * offset corregido puede diferir del inicial; una segunda pasada lo resuelve.
 */
function wallToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = naive - tzOffsetMs(timeZone, naive);
  const reoffset = naive - tzOffsetMs(timeZone, utc);
  if (reoffset !== utc) utc = reoffset;
  return utc;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ── nextOccurrence ────────────────────────────────────────────────────────────

interface LocalDay {
  year: number;
  month: number;
  day: number;
}

function epochDayToYMD(epochDay: number): LocalDay {
  const d = new Date(epochDay * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Toque de queda defensivo del generador de días (~95 años de semanas). */
const MAX_PERIODS = 5000;

/**
 * Días locales candidatos en orden cronológico, desde el período que contiene
 * a `fromLocal`, avanzando de a `interval` períodos según FREQ.
 */
function* candidateDays(parsed: ParsedRRule, fromLocal: LocalDateTime): Generator<LocalDay> {
  const { freq, interval } = parsed;

  if (freq === 'DAILY') {
    for (let k = 0; k < MAX_PERIODS; k += interval) {
      yield epochDayToYMD(fromLocal.epochDay + k);
    }
  } else if (freq === 'WEEKLY') {
    const offsets = (parsed.byDay.length ? parsed.byDay : [fromLocal.weekday])
      .map((wd) => (wd + 6) % 7) // distancia desde el lunes (MO=0 … SU=6)
      .sort((a, b) => a - b);
    const monday = fromLocal.epochDay - ((fromLocal.weekday + 6) % 7);
    for (let w = 0; w < MAX_PERIODS; w += interval) {
      for (const off of offsets) {
        yield epochDayToYMD(monday + w * 7 + off);
      }
    }
  } else {
    // MONTHLY y YEARLY comparten la resolución de BYMONTHDAY (negativos = desde
    // el fin del mes). YEARLY recae siempre sobre el mes local de `from`.
    const monthDays = parsed.byMonthDay.length ? parsed.byMonthDay : [fromLocal.day];
    const anchorMonth = fromLocal.year * 12 + (fromLocal.month - 1);
    for (let k = 0; k < MAX_PERIODS; k += interval) {
      let year: number, month: number;
      if (freq === 'MONTHLY') {
        const mIdx = anchorMonth + k;
        year = Math.floor(mIdx / 12);
        month = (mIdx % 12) + 1;
      } else {
        year = fromLocal.year + k;
        month = fromLocal.month;
      }
      const dim = daysInMonth(year, month);
      const resolved = monthDays
        .map((md) => (md > 0 ? md : dim + md + 1))
        .filter((d) => d >= 1 && d <= dim)
        .sort((a, b) => a - b);
      for (const day of resolved) yield { year, month, day };
    }
  }
}

/**
 * Próxima ocurrencia de la regla, estrictamente posterior a `from`, calculada
 * en `timezone` (IANA). `null` si la recurrencia ya venció (UNTIL pasado o
 * COUNT agotado). Lanza Error si el RRULE o la timezone son inválidos.
 */
export function nextOccurrence(rrule: string, from: Date, timezone: string): Date | null {
  const parsed = parseRRule(rrule);
  try {
    formatter(timezone);
  } catch {
    throw new Error(`Timezone IANA inválida: "${timezone}"`);
  }

  const fromMs = from.getTime();
  const fromLocal = localParts(from, timezone);
  const hours = parsed.byHour.length ? parsed.byHour : [fromLocal.hour];
  const minutes = parsed.byMinute.length ? parsed.byMinute : [fromLocal.minute];

  let untilMs: number | null = null;
  if (parsed.until) {
    const u = parsed.until;
    untilMs = u.utc
      ? Date.UTC(u.year, u.month - 1, u.day, u.hour, u.minute, u.second)
      : wallToUtcMs(u.year, u.month, u.day, u.hour, u.minute, u.second, timezone);
    if (u.dateOnly) untilMs += MS_PER_DAY - 1; // el día UNTIL completo, inclusive
  }

  let seen = 0;
  for (const day of candidateDays(parsed, fromLocal)) {
    for (const hour of hours) {
      for (const minute of minutes) {
        const ms = wallToUtcMs(day.year, day.month, day.day, hour, minute, 0, timezone);
        seen++;
        if (parsed.count !== undefined && seen > parsed.count) return null;
        if (untilMs !== null && ms > untilMs) return null;
        if (ms > fromMs) return new Date(ms);
      }
    }
  }
  return null;
}

// ── describeRRule ─────────────────────────────────────────────────────────────

const DAY_NAMES_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados'];

function joinEs(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function describeMonthDay(md: number): string {
  if (md === -1) return 'el último día';
  if (md === -2) return 'el anteúltimo día';
  if (md < 0) return `a ${-md} días de fin de mes`;
  return `el día ${md}`;
}

/** Descripción en español para la UI (PC-08). Lanza Error si el RRULE es inválido. */
export function describeRRule(rrule: string): string {
  const p = parseRRule(rrule);
  let text: string;

  if (p.freq === 'DAILY') {
    text = p.interval === 1 ? 'Todos los días' : `Cada ${p.interval} días`;
  } else if (p.freq === 'WEEKLY') {
    if (p.byDay.length) {
      const days = p.byDay.map((wd) => DAY_NAMES_PLURAL[wd]);
      text = p.interval === 1 ? `Todos los ${joinEs(days)}` : `Cada ${p.interval} semanas los ${joinEs(days)}`;
    } else {
      text = p.interval === 1 ? 'Cada semana' : `Cada ${p.interval} semanas`;
    }
  } else if (p.freq === 'MONTHLY') {
    text = p.interval === 1 ? 'Cada mes' : `Cada ${p.interval} meses`;
    if (p.byMonthDay.length) text += ` ${joinEs(p.byMonthDay.map(describeMonthDay))}`;
  } else {
    text = p.interval === 1 ? 'Cada año' : `Cada ${p.interval} años`;
  }

  if (p.byHour.length) {
    const minutes = p.byMinute.length ? p.byMinute : [0];
    const times = p.byHour.flatMap((h) => minutes.map((mi) => `${pad2(h)}:${pad2(mi)}`));
    text += ` a las ${joinEs(times)}`;
  }
  if (p.until) {
    text += ` hasta el ${pad2(p.until.day)}/${pad2(p.until.month)}/${p.until.year}`;
  }
  return text;
}
