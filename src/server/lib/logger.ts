/**
 * logger.ts — logger estructurado del server (PI-02).
 *
 * Sin dependencias nuevas: `node:util` para el formato legible y `console`
 * como sink. API mínima y explícita:
 *
 *   log.info(msg, fields?) / log.warn / log.error / log.debug
 *   log.child(fields)      → logger derivado con campos fijos (p.ej.
 *                            { transmissionId } — trazabilidad por emisión)
 *
 * Formato:
 *   - `NODE_ENV === 'production'` → UNA línea JSON por evento, parseable por
 *     cualquier agregador: {ts, level, msg, ...fields}.
 *   - Fuera de producción → línea legible `[LEVEL] ts msg key=value …` con
 *     el mismo nivel de detalle.
 *
 * Contexto (requestContext.ts): si hay un scope activo, `requestId`,
 * `tenantId` y `transmissionId` se inyectan solos en cada línea. Precedencia
 * de campos: call-site > child > contexto.
 *
 * Redacción OBLIGATORIA (regla dura — nunca se loguean secretos):
 *   - Claves cuyo nombre matchee (case-insensitive, ignorando `_-.`) una
 *     entrada de SENSITIVE_KEYS salen como "[REDACTED]": password, passwd,
 *     secret, token, apiKey/api_key, authorization, cookie, accessToken,
 *     refreshToken, credential(s), connectionString, databaseUrl,
 *     privateKey — y cualquier clave que las contenga (p.ej.
 *     `stripeSecretKey`, `proxy-authorization`).
 *   - Strings que contengan una URL de Postgres con credenciales
 *     (`postgres://user:pass@…`) se redactan en CUALQUIER clave, y también
 *     dentro del `msg`.
 *   - Aplica recursivo a objetos anidados (profundidad acotada).
 *
 * Reglas:
 *   - `Error` como campo sale como {name, message, stack} — jamás
 *     "[object Object]".
 *   - `LOG_LEVEL=debug|info|warn|error` (default `info`): lo que esté por
 *     debajo no se emite. Se lee en cada emisión — cambiar el env en caliente
 *     tiene efecto inmediato.
 *   - Un error al loguear NUNCA tumba la app: la emisión entera va envuelta
 *     en try/catch.
 *   - NUNCA se loguean bodies de request ni cabeceras de autenticación:
 *     es responsabilidad del call-site (la redacción es la segunda barrera).
 */
import { inspect } from 'node:util';

import { getRequestContext } from './requestContext.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Logger derivado: `fields` queda fijo en todas sus líneas. */
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACTED = '[REDACTED]';

/**
 * Nombres de clave sensibles, normalizados (minúsculas, sin `_-.`). El
 * matcheo es por substring: `apikey` cubre `apiKey`, `api_key`, `X-Api-Key`;
 * `token` cubre `accessToken`, `refreshToken`, `idToken`, `csrfToken`, etc.
 * Se prefiere sobre-redactar antes que filtrar un secreto.
 */
const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'connectionstring',
  'databaseurl',
  'privatekey',
];

/**
 * Credenciales embebidas en una URL de Postgres dentro de un string:
 * `postgres://user:pass@host/db` → `postgres://[REDACTED]@host/db`.
 */
const CREDENTIAL_URL_RE =
  /(postgres(?:ql)?|postgis):\/\/[^/\s:@]+:[^@\s]+@/gi;

/** Profundidad máxima al redactar objetos anidados. */
const MAX_DEPTH = 5;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_\-.]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some((s) => normalized.includes(s));
}

function scrubString(value: string): string {
  return value.replace(CREDENTIAL_URL_RE, (_m, scheme) => `${scheme}://${REDACTED}@`);
}

/**
 * Convierte `value` en algo JSON-seguro y redactado: claves sensibles,
 * credenciales en strings, Error → {name, message, stack}, BigInt → string,
 * Date → ISO, ciclos → "[Circular]", profundidad acotada → "[Truncated]".
 * `seen` trackea ancestros (no siblings): un objeto compartido en dos ramas
 * NO se marca circular.
 */
function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => sanitizeValue(item, seen, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSensitiveKey(key)
          ? REDACTED
          : sanitizeValue(nested, seen, depth + 1);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

function currentMinLevel(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  return (LEVEL_ORDER as Record<string, number>)[raw] ?? LEVEL_ORDER.info;
}

function write(level: LogLevel, line: string): void {
  try {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch {
    /* ni el fallback puede tumbar la app */
  }
}

function formatDevValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  return inspect(value, { depth: 4, colors: false, compact: true, breakLength: Infinity });
}

function emit(level: LogLevel, msg: string, fields: LogFields | undefined, base: LogFields): void {
  if (LEVEL_ORDER[level] < currentMinLevel()) return;
  try {
    const ctx = getRequestContext();
    const merged: LogFields = {
      ...(ctx?.requestId !== undefined ? { requestId: ctx.requestId } : {}),
      ...(ctx?.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
      ...(ctx?.transmissionId !== undefined
        ? { transmissionId: ctx.transmissionId }
        : {}),
      ...base,
      ...(fields ?? {}),
    };

    const seen = new WeakSet<object>();
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) {
      sanitized[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(value, seen, 0);
    }

    const text = scrubString(String(msg));
    const ts = new Date().toISOString();
    if (process.env.NODE_ENV === 'production') {
      write(level, JSON.stringify({ ts, level, msg: text, ...sanitized }));
    } else {
      const pairs = Object.entries(sanitized).map(([k, v]) => `${k}=${formatDevValue(v)}`);
      write(
        level,
        `[${level.toUpperCase()}] ${ts} ${text}${pairs.length > 0 ? ` ${pairs.join(' ')}` : ''}`,
      );
    }
  } catch {
    // Un fallo al loguear jamás tumba la request (regla dura del slice).
  }
}

function createLogger(base: LogFields = {}): Logger {
  return {
    debug: (msg, fields) => emit('debug', msg, fields, base),
    info: (msg, fields) => emit('info', msg, fields, base),
    warn: (msg, fields) => emit('warn', msg, fields, base),
    error: (msg, fields) => emit('error', msg, fields, base),
    child: (fields) => createLogger({ ...base, ...(fields ?? {}) }),
  };
}

/** Logger raíz del server. `log.child({ transmissionId })` para derivados. */
export const log: Logger = createLogger();
