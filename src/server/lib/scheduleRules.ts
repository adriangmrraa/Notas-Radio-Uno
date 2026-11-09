/**
 * scheduleRules.ts — reglas de la agenda de transmisiones (PC-08). Puro y
 * testeable: sin DB, sin IO, sin dependencias.
 *
 * Traduce el input de la UI (modo + fecha/hora + timezone) al triple
 * `(rrule, starts_at, next_run_at)` que persiste `scheduled_transmissions`:
 *
 *   - once   (puntual):  RRULE `FREQ=DAILY;COUNT=1` — la única ocurrencia es
 *                        starts_at (DTSTART semantics). next_run_at = starts_at.
 *   - weekly (semanal):  `FREQ=WEEKLY;BYDAY=..;BYHOUR=..;BYMINUTE=..`
 *   - daily  (diario):   `FREQ=DAILY;BYHOUR=..;BYMINUTE=..`
 *   - endsAt opcional ⇒ `;UNTIL=YYYYMMDD` (día completo inclusive, wall-clock
 *     en la tz de la regla) y se persiste en la columna `ends_at`.
 *
 * Semántica de starts_at para recurrencias: la PRIMERA ocurrencia ≥ `now`
 * (un DTSTART RFC-correcto es la primera ocurrencia, no la fecha de carga).
 * next_run_at es esa misma primera ocurrencia. Toda la aritmética de fechas
 * se hace en la timezone IANA de la regla vía `rrule.ts` (PC-07).
 */
import { describeRRule, nextOccurrence, parseRRule, wallToUtcMs } from './rrule.js';

export const SCHEDULE_MODES = ['once', 'weekly', 'daily'] as const;
export type ScheduleMode = (typeof SCHEDULE_MODES)[number];

/** ISO weekday → código RRULE (1=lunes … 7=domingo). */
const ISO_WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 255;
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 480;
const MS_PER_DAY = 86_400_000;

export interface ScheduleInput {
  name: string;
  description: string | null;
  streamUrl: string;
  programId: string | null;
  mode: ScheduleMode;
  /** 'YYYY-MM-DD' — obligatoria en modo once. */
  date?: string;
  /** 'HH:MM' 24h — hora local en `timezone`. */
  time: string;
  /** ISO 1..7 — obligatorio (≥1) en modo weekly. */
  daysOfWeek: number[];
  timezone: string;
  durationMinutes: number;
  autoStart: boolean;
  pipelineConfig: Record<string, unknown>;
  /** 'YYYY-MM-DD' — sólo weekly/daily; fin de la recurrencia, inclusive. */
  endsAt?: string;
  isActive?: boolean;
}

export interface BuiltSchedule {
  rrule: string;
  startsAt: Date;
  endsAt: Date | null;
  nextRunAt: Date;
}

// ── Helpers de validación ─────────────────────────────────────────────────────

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Fecha 'YYYY-MM-DD' con formato y día real (no 2026-02-30). */
function parseDateStr(value: string): { y: number; m: number; d: number } | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > dim) return null;
  return { y, m: mo, d };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── parseScheduleBody — validación del body POST/PUT (sin HTTP) ───────────────

export function parseScheduleBody(body: unknown): { fields?: ScheduleInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body inválido' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== 'string' || b.name.trim() === '') {
    return { error: 'El nombre es obligatorio' };
  }
  const name = b.name.trim();
  if (name.length > MAX_NAME_LENGTH) {
    return { error: `El nombre admite hasta ${MAX_NAME_LENGTH} caracteres` };
  }

  let description: string | null = null;
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string') {
      return { error: 'description debe ser un string' };
    }
    const trimmed = b.description.trim();
    description = trimmed === '' ? null : trimmed;
  }

  if (typeof b.streamUrl !== 'string' || !isHttpUrl(b.streamUrl.trim())) {
    return { error: 'streamUrl debe ser una URL http(s) válida' };
  }
  const streamUrl = b.streamUrl.trim();

  let programId: string | null = null;
  if (b.programId !== undefined && b.programId !== null && b.programId !== '') {
    if (typeof b.programId !== 'string' || !UUID_RE.test(b.programId)) {
      return { error: 'programId inválido: debe ser un UUID' };
    }
    programId = b.programId;
  }

  if (typeof b.mode !== 'string' || !(SCHEDULE_MODES as readonly string[]).includes(b.mode)) {
    return { error: `mode inválido. Valores permitidos: ${SCHEDULE_MODES.join(', ')}` };
  }
  const mode = b.mode as ScheduleMode;

  if (typeof b.time !== 'string' || !TIME_RE.test(b.time)) {
    return { error: 'time inválida: formato HH:MM (24h)' };
  }
  const time = b.time;

  let date: string | undefined;
  if (mode === 'once') {
    if (typeof b.date !== 'string' || !parseDateStr(b.date)) {
      return { error: 'date es obligatoria en modo puntual (YYYY-MM-DD)' };
    }
    date = b.date;
  } else if (b.date !== undefined && b.date !== null && (typeof b.date !== 'string' || !parseDateStr(b.date))) {
    return { error: 'date inválida (YYYY-MM-DD)' };
  }

  const daysOfWeek: number[] = [];
  if (mode === 'weekly') {
    if (!Array.isArray(b.daysOfWeek) || b.daysOfWeek.length === 0) {
      return { error: 'daysOfWeek es obligatorio en modo semanal (al menos un día)' };
    }
    for (const d of b.daysOfWeek as unknown[]) {
      if (!Number.isInteger(d) || (d as number) < 1 || (d as number) > 7) {
        return { error: 'daysOfWeek admite enteros 1..7 (1=lunes … 7=domingo)' };
      }
      if (!daysOfWeek.includes(d as number)) daysOfWeek.push(d as number);
    }
    daysOfWeek.sort((x, y) => x - y);
  } else if (b.daysOfWeek !== undefined && b.daysOfWeek !== null && !Array.isArray(b.daysOfWeek)) {
    return { error: 'daysOfWeek debe ser un array de enteros 1..7' };
  }

  if (typeof b.timezone !== 'string' || !isValidTimeZone(b.timezone)) {
    return { error: 'timezone inválida (IANA, ej: America/Argentina/Buenos_Aires)' };
  }
  const timezone = b.timezone;

  if (
    typeof b.durationMinutes !== 'number' ||
    !Number.isInteger(b.durationMinutes) ||
    b.durationMinutes < MIN_DURATION_MINUTES ||
    b.durationMinutes > MAX_DURATION_MINUTES
  ) {
    return { error: `durationMinutes debe ser un entero entre ${MIN_DURATION_MINUTES} y ${MAX_DURATION_MINUTES}` };
  }
  const durationMinutes = b.durationMinutes;

  let autoStart = true;
  if (b.autoStart !== undefined) {
    if (typeof b.autoStart !== 'boolean') {
      return { error: 'autoStart debe ser boolean' };
    }
    autoStart = b.autoStart;
  }

  let pipelineConfig: Record<string, unknown> = {};
  if (b.pipelineConfig !== undefined && b.pipelineConfig !== null) {
    if (typeof b.pipelineConfig !== 'object' || Array.isArray(b.pipelineConfig)) {
      return { error: 'pipelineConfig debe ser un objeto' };
    }
    pipelineConfig = b.pipelineConfig as Record<string, unknown>;
  }

  let endsAt: string | undefined;
  if (b.endsAt !== undefined && b.endsAt !== null && b.endsAt !== '') {
    if (typeof b.endsAt !== 'string' || !parseDateStr(b.endsAt)) {
      return { error: 'endsAt inválida (YYYY-MM-DD)' };
    }
    if (mode === 'once') {
      return { error: 'endsAt sólo aplica a recurrencias semanales o diarias' };
    }
    endsAt = b.endsAt;
  }

  let isActive: boolean | undefined;
  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') {
      return { error: 'isActive debe ser boolean' };
    }
    isActive = b.isActive;
  }

  return {
    fields: {
      name,
      description,
      streamUrl,
      programId,
      mode,
      date,
      time,
      daysOfWeek,
      timezone,
      durationMinutes,
      autoStart,
      pipelineConfig,
      endsAt,
      isActive,
    },
  };
}

// ── buildRRule / buildSchedule ────────────────────────────────────────────────

/**
 * RRULE generado desde el input validado (la UI nunca escribe RRULE a mano).
 * `endsAt` se embebe como UNTIL=YYYYMMDD (date-only: día completo inclusive
 * en la tz de la regla, según la semántica de `rrule.ts`).
 */
export function buildRRule(
  input: Pick<ScheduleInput, 'mode' | 'time' | 'daysOfWeek' | 'endsAt'>,
): string {
  const [hh, mm] = input.time.split(':').map(Number);
  const until = input.endsAt ? `;UNTIL=${input.endsAt.replace(/-/g, '')}` : '';

  if (input.mode === 'once') {
    return 'FREQ=DAILY;COUNT=1';
  }
  if (input.mode === 'weekly') {
    const days = input.daysOfWeek.map((d) => ISO_WEEKDAY_CODES[d - 1]).join(',');
    return `FREQ=WEEKLY;BYDAY=${days};BYHOUR=${hh};BYMINUTE=${mm}${until}`;
  }
  return `FREQ=DAILY;BYHOUR=${hh};BYMINUTE=${mm}${until}`;
}

/**
 * Calcula `(rrule, starts_at, ends_at, next_run_at)` para `input` evaluado
 * contra `now` (inyectado: testeable). Devuelve `{error}` si la recurrencia
 * ya venció — el caller traduce a 400.
 *
 * Puntual: starts_at es el instante de `date`+`time` en `timezone` y debe ser
 * futuro; su única ocurrencia ES starts_at ⇒ next_run_at = starts_at.
 * Semanal/diario: starts_at y next_run_at son la primera ocurrencia ≥ now
 * (DTSTART de la serie); `null` de nextOccurrence ⇒ recurrencia vencida.
 */
export function buildSchedule(
  input: Pick<ScheduleInput, 'mode' | 'date' | 'time' | 'daysOfWeek' | 'timezone' | 'endsAt'>,
  now: Date,
): { schedule?: BuiltSchedule; error?: string } {
  const rrule = buildRRule(input);
  const [hh, mm] = input.time.split(':').map(Number);

  if (input.mode === 'once') {
    const { y, m, d } = parseDateStr(input.date!)!;
    const startsAt = new Date(wallToUtcMs(y, m, d, hh, mm, 0, input.timezone));
    if (startsAt.getTime() <= now.getTime()) {
      return { error: 'Esa fecha y hora ya pasó en la timezone elegida' };
    }
    return { schedule: { rrule, startsAt, endsAt: null, nextRunAt: startsAt } };
  }

  const first = nextOccurrence(rrule, new Date(now.getTime() - 1), input.timezone);
  if (!first) {
    return { error: 'Esa recurrencia ya terminó: no hay próxima emisión' };
  }

  let endsAt: Date | null = null;
  if (input.endsAt) {
    const { y, m, d } = parseDateStr(input.endsAt)!;
    endsAt = new Date(wallToUtcMs(y, m, d, 23, 59, 59, input.timezone));
  }

  return { schedule: { rrule, startsAt: first, endsAt, nextRunAt: first } };
}

// ── valuesFromFields — input validado + triple → valores a persistir ──────────

/**
 * Valores de la fila para INSERT (POST) y UPDATE completo (PUT): whitelist
 * explícita — `tenantId`, `id` y cualquier clave extra del body no pasan.
 * `isActive` default `true` en create; el PUT puede pisar la clave para
 * preservar el valor existente (`f.isActive ?? existing.isActive`).
 */
export function valuesFromFields(f: ScheduleInput, built: BuiltSchedule) {
  return {
    name: f.name,
    description: f.description,
    streamUrl: f.streamUrl,
    programId: f.programId,
    rrule: built.rrule,
    timezone: f.timezone,
    startsAt: built.startsAt,
    endsAt: built.endsAt,
    durationMinutes: f.durationMinutes,
    autoStart: f.autoStart,
    pipelineConfig: f.pipelineConfig,
    nextRunAt: built.nextRunAt,
    isActive: f.isActive ?? true,
  };
}

// ── deriveSchedule — fila persistida → campos del formulario (edición) ───────

export interface DerivedSchedule {
  mode: ScheduleMode;
  date?: string;
  time: string;
  daysOfWeek: number[];
  endsAt?: string;
}

const dtfLocalCache = new Map<string, Intl.DateTimeFormat>();
function localFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfLocalCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    });
    dtfLocalCache.set(timeZone, fmt);
  }
  return fmt;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Instante → { date:'YYYY-MM-DD', time:'HH:MM' } wall-clock en `timeZone`. */
export function localDateTimeStrings(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = localFormatter(timeZone).formatToParts(instant);
  let year = '', month = '', day = '', hour = '', minute = '';
  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}` };
}

/**
 * Reconstruye el input de la UI a partir de lo persistido — para precargar el
 * modal de edición y para que el cliente no parseé RRULE. `endsAt` se expone
 * como fecha local en `timezone`.
 */
export function deriveSchedule(
  rrule: string,
  startsAt: Date,
  endsAt: Date | null,
  timezone: string,
): DerivedSchedule {
  const p = parseRRule(rrule);

  if (p.freq === 'DAILY' && p.count === 1) {
    const local = localDateTimeStrings(startsAt, timezone);
    return { mode: 'once', date: local.date, time: local.time, daysOfWeek: [] };
  }

  const hour = p.byHour.length ? p.byHour[0] : 0;
  const minute = p.byMinute.length ? p.byMinute[0] : 0;
  const derived: DerivedSchedule = {
    mode: p.freq === 'WEEKLY' ? 'weekly' : 'daily',
    time: `${pad2(hour)}:${pad2(minute)}`,
    // JS weekday (0=dom) → ISO (7=dom)
    daysOfWeek: p.freq === 'WEEKLY' ? p.byDay.map((js) => (js === 0 ? 7 : js)) : [],
  };
  if (endsAt) {
    derived.endsAt = localDateTimeStrings(endsAt, timezone).date;
  }
  return derived;
}

/** Descripción en español para la UI: el puntual se lee como "una sola vez". */
export function describeSchedule(rrule: string): string {
  const p = parseRRule(rrule);
  if (p.freq === 'DAILY' && p.count === 1) return 'Una sola vez';
  return describeRRule(rrule);
}

// ── occurrencesBetween — expansión de instancias para la vista calendario ────

/**
 * Instantes de la regla dentro de `[fromMs, toMs)` — la grilla mensual se arma
 * con esto (cada instante se bucketa por fecha local en `timezone`).
 * La serie arranca en `startsAt` (DTSTART): las ocurrencias se recortan a
 * `>= startsAt` para que meses anteriores a la creación no muestren sheds
 * fantasma. Puntual: la única ocurrencia es `startsAt`. Cap defensivo por
 * reglas densas.
 */
export function occurrencesBetween(
  rrule: string,
  timezone: string,
  startsAt: Date,
  fromMs: number,
  toMs: number,
  cap = 500,
): Date[] {
  const p = parseRRule(rrule);
  const lowerMs = Math.max(fromMs, startsAt.getTime());
  if (p.freq === 'DAILY' && p.count === 1) {
    const t = startsAt.getTime();
    return t >= lowerMs && t < toMs ? [startsAt] : [];
  }

  const out: Date[] = [];
  let cursor = new Date(lowerMs - 1);
  while (out.length < cap) {
    const next = nextOccurrence(rrule, cursor, timezone);
    if (!next || next.getTime() >= toMs) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
