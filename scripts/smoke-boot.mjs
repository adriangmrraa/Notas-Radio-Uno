/**
 * smoke-boot.mjs — verificación de boot del servidor compilado (Épica J / PJ-06).
 *
 * No necesita Docker ni una Postgres real: ejecuta `node dist/server/index.js`
 * con env de FORMATO VÁLIDO y verifica que los fail-fast correctos disparen:
 *
 *   Caso 1 — NODE_ENV=production sin JWT_SECRET
 *     → el guard de `lib/jwtSecret.ts` (module-level) tira antes de listen.
 *     Esperado: exit ≠ 0 y stderr/stdout menciona "JWT_SECRET".
 *
 *   Caso 2 — JWT_SECRET válido + DATABASE_URL inalcanzable (127.0.0.1:1)
 *     → el boot llega a `runMigrations()`, el `SELECT 1` falla y el proceso
 *     muere con `[Server] Error running migrations` + exit 1.
 *     Esperado: exit ≠ 0 antes del timeout y log de error de migraciones/DB.
 *
 *   Caso 3 (opt-in) — SMOKE_DATABASE_URL=<url real alcanzable>
 *     → boot POSITIVO: espera "Servidor corriendo", pega a /api/health y
 *     exige JSON con `status`. Apaga con SIGTERM. Cubre el camino feliz
 *     cuando hay una DB efímera disponible (local/CI con service).
 *
 * Requiere `npm run build` previo (usa dist/server/index.js + dist/client).
 * Uso: `node scripts/smoke-boot.mjs` → EXIT 0 si todos los casos pasan.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'server', 'index.js');

if (!existsSync(entry)) {
  console.error('[smoke-boot] dist/server/index.js no existe — correr `npm run build` primero.');
  process.exit(1);
}

const TEST_PORT = 3987;
const UNREACHABLE_DB = 'postgres://u:p@127.0.0.1:1/db';
const VALID_JWT = 'a'.repeat(64);

/** Env limpio: hereda lo mínimo (PATH/SystemRoot para spawn en Windows). */
function baseEnv(overrides) {
  const env = { PATH: process.env.PATH };
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  return {
    ...env,
    NODE_ENV: 'production',
    PORT: String(TEST_PORT),
    ...overrides,
  };
}

/**
 * Spawna el server y devuelve { code, output, timedOut, listened }.
 * `listened` se marca en cuanto el log anuncia "Servidor corriendo".
 */
function runServer(env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('node', [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let listened = false;
    let timedOut = false;

    child.stdout.on('data', (d) => {
      output += d;
      if (d.includes('Servidor corriendo')) listened = true;
    });
    child.stderr.on('data', (d) => {
      output += d;
      if (d.includes('Servidor corriendo')) listened = true;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // force-kill si el graceful shutdown no cierra solo
      setTimeout(() => child.kill('SIGKILL'), 6000).unref();
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut, listened });
    });
  });
}

let failures = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} [smoke-boot] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// --- Caso 1: sin JWT_SECRET en producción -----------------------------------
{
  const r = await runServer(
    baseEnv({ DATABASE_URL: UNREACHABLE_DB }),
    30_000,
  );
  const ok =
    !r.timedOut &&
    !r.listened &&
    r.code !== 0 &&
    r.output.includes('JWT_SECRET');
  report(ok, 'sin JWT_SECRET → fail-fast', ok ? undefined : `code=${r.code} timedOut=${r.timedOut} out=${r.output.slice(-300)}`);
}

// --- Caso 2: DB inalcanzable → fail en migraciones ---------------------------
{
  const r = await runServer(
    baseEnv({ DATABASE_URL: UNREACHABLE_DB, JWT_SECRET: VALID_JWT }),
    60_000,
  );
  const migrationFail =
    /Error running migrations|ECONNREFUSED|connect|database|SELECT 1/i.test(r.output);
  const ok =
    !r.timedOut &&
    !r.listened &&
    r.code !== 0 &&
    migrationFail;
  report(ok, 'DB inalcanzable → boot muere en migraciones', ok ? undefined : `code=${r.code} timedOut=${r.timedOut} out=${r.output.slice(-300)}`);
}

// --- Caso 3 (opt-in): boot real contra DB alcanzable -------------------------
if (process.env.SMOKE_DATABASE_URL) {
  const r = await runServer(
    baseEnv({ DATABASE_URL: process.env.SMOKE_DATABASE_URL, JWT_SECRET: VALID_JWT }),
    60_000,
  );
  if (r.listened) {
    let healthOk = false;
    let detail = '';
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
      const body = await res.json();
      healthOk = typeof body?.status === 'string';
      detail = `HTTP ${res.status} status=${body?.status}`;
    } catch (err) {
      detail = `health fetch falló: ${err.message}`;
    }
    report(healthOk, 'boot real + /api/health responde JSON', healthOk ? detail : detail);
  } else {
    report(false, 'boot real + /api/health responde JSON', `no escuchó — code=${r.code} out=${r.output.slice(-300)}`);
  }
} else {
  console.log('SKIP [smoke-boot] caso boot real — setear SMOKE_DATABASE_URL para habilitarlo');
}

if (failures > 0) {
  console.error(`[smoke-boot] ${failures} caso(s) fallaron`);
  process.exit(1);
}
console.log('[smoke-boot] OK — todos los checks pasaron');
