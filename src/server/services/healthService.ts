/**
 * healthService.ts — reporte de salud REAL del servicio (PI-06).
 *
 * El endpoint `/api/health` (usado como healthCheckPath en render.yaml) ya
 * no devuelve un `ok` constante: sondea el estado real de
 *
 *   1. DB alcanzable        — `SELECT 1` contra el pool Neon.
 *   2. Migraciones          — filas de `__drizzle_migrations` vs entradas
 *                             del journal `drizzle/meta/_journal.json`.
 *   3. Providers de IA      — al menos una key configurada
 *                             (getAvailableProviders; nunca los valores).
 *
 * Semántica de estados (justificada en el commit):
 *   - `ok`       → todo verde.                                        200
 *   - `degraded` → DB alcanzable pero migraciones pendientes/verificables
 *                  o ningún provider de IA configurado: la app sirve tráfico
 *                  (el login y la landing funcionan) pero hay funcionalidad
 *                  caída. 200: el load balancer NO debe drenar la instancia
 *                  por una condición no fatal.                         200
 *   - `error`    → DB inalcanzable: el servicio no puede operar.       503
 *
 * NUNCA expone secretos, tokens ni connection strings: sólo nombres de
 * checks, conteos y las keys de provider ('deepseek' | 'google' | 'openai')
 * que son identificadores públicos del catálogo `PROVIDERS`.
 *
 * Las probes son inyectables: los tests pasan fakes deterministas sin DB.
 */
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import { db } from '../db/index.js';
import { getAvailableProviders } from './aiProviders.js';
import { log } from '../lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// services/ → server/ → src/ → raíz del repo (mismo criterio que index.ts).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type HealthStatus = 'ok' | 'degraded' | 'error';
export type CheckStatus = 'up' | 'down' | 'pending' | 'unknown' | 'skipped';

export interface HealthReport {
  status: HealthStatus;
  httpStatus: 200 | 503;
  body: {
    status: HealthStatus;
    timestamp: string;
    checks: {
      database: { status: CheckStatus };
      migrations: {
        status: CheckStatus;
        applied: number | null;
        expected: number | null;
      };
      aiProviders: { status: CheckStatus; configured: string[] };
    };
  };
}

export interface MigrationStatus {
  /** Filas en la tabla de tracking de drizzle; null si no se pudo leer. */
  applied: number | null;
  /** Entradas del journal en disco; null si no se pudo leer el archivo. */
  expected: number | null;
}

/** Probes inyectables — la producción usa `defaultHealthProbes`. */
export interface HealthProbes {
  /** Resuelve si la DB responde; rechaza si no. */
  pingDatabase(): Promise<void>;
  /** Conteo de migraciones aplicadas vs esperadas (nulls = no verificable). */
  getMigrationStatus(): Promise<MigrationStatus>;
  /** Keys de providers de IA con key configurada — nunca los valores. */
  listConfiguredAiProviders(): string[];
  /** Reloj inyectable para timestamp determinista en tests. */
  now?(): Date;
}

// ---------------------------------------------------------------------------
// Lógica de agregación (pura — testeable sin DB ni FS)
// ---------------------------------------------------------------------------

export async function getHealthReport(probes: HealthProbes): Promise<HealthReport> {
  const at = probes.now?.() ?? new Date();

  // 1) DB alcanzable — sin DB no hay servicio: error duro 503.
  try {
    await probes.pingDatabase();
  } catch (err) {
    log.error('[Health] DB inalcanzable', { err });
    return {
      status: 'error',
      httpStatus: 503,
      body: {
        status: 'error',
        timestamp: at.toISOString(),
        checks: {
          database: { status: 'down' },
          migrations: { status: 'skipped', applied: null, expected: null },
          aiProviders: { status: 'skipped', configured: [] },
        },
      },
    };
  }

  // 2) Migraciones: pendiente (applied < expected) o no verificable → degraded.
  let migrations: MigrationStatus;
  try {
    migrations = await probes.getMigrationStatus();
  } catch (err) {
    log.error('[Health] No se pudo verificar el estado de migraciones', { err });
    migrations = { applied: null, expected: null };
  }
  const migrationsPending =
    migrations.applied === null ||
    migrations.expected === null ||
    migrations.applied < migrations.expected;
  const migrationsStatus: CheckStatus =
    migrations.applied === null || migrations.expected === null
      ? 'unknown'
      : migrationsPending
        ? 'pending'
        : 'up';

  // 3) Provider de IA: sin ninguna key configurada las funciones de IA están
  //    caídas aunque la app sirva → degraded.
  let configured: string[] = [];
  try {
    configured = probes.listConfiguredAiProviders();
  } catch (err) {
    log.error('[Health] No se pudo verificar providers de IA', { err });
  }
  const aiStatus: CheckStatus = configured.length > 0 ? 'up' : 'down';

  const degraded = migrationsPending || configured.length === 0;
  const status: HealthStatus = degraded ? 'degraded' : 'ok';

  return {
    status,
    httpStatus: 200,
    body: {
      status,
      timestamp: at.toISOString(),
      checks: {
        database: { status: 'up' },
        migrations: {
          status: migrationsStatus,
          applied: migrations.applied,
          expected: migrations.expected,
        },
        aiProviders: { status: aiStatus, configured },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Probes de producción (Neon + journal en disco + catálogo de providers)
// ---------------------------------------------------------------------------

/**
 * Filas en la tabla de tracking de migraciones. El migrator oficial usa
 * `drizzle.__drizzle_migrations`; el fallback del repo
 * (markExistingMigrationsAsApplied) escribe `public."__drizzle_migrations"`.
 * Se devuelve el MÁXIMO de los que existan — cada uno es una historia
 * alternativa del mismo avance.
 */
async function countAppliedMigrations(): Promise<number | null> {
  let best: number | null = null;
  for (const query of [
    sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
    sql`SELECT count(*)::int AS n FROM "__drizzle_migrations"`,
  ]) {
    try {
      const res = await db.execute(query);
      const n = Number((res.rows[0] as { n: number }).n);
      best = best === null ? n : Math.max(best, n);
    } catch {
      // La tabla no existe en este entorno — se intenta la siguiente.
    }
  }
  return best;
}

/** Entradas del journal drizzle-kit en disco (fuente de "esperadas"). */
function countExpectedMigrations(): number | null {
  const journalPath = path.join(PROJECT_ROOT, 'drizzle', 'meta', '_journal.json');
  try {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
      entries?: unknown[];
    };
    return Array.isArray(journal.entries) ? journal.entries.length : null;
  } catch {
    return null;
  }
}

export const defaultHealthProbes: HealthProbes = {
  async pingDatabase() {
    await db.execute(sql`SELECT 1`);
  },
  async getMigrationStatus() {
    return {
      applied: await countAppliedMigrations(),
      expected: countExpectedMigrations(),
    };
  },
  listConfiguredAiProviders() {
    return getAvailableProviders();
  },
};
