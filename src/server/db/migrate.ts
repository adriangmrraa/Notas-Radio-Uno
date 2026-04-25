import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { db } from './index.js';
import fs from 'fs';
import path from 'path';

export async function runMigrations(): Promise<void> {
  const migrationsFolder = './drizzle';

  // Check if migrations folder exists and has migration files
  if (!fs.existsSync(migrationsFolder)) {
    console.log('[DB] No migrations folder found, skipping migrations.');
    return;
  }

  const files = fs.readdirSync(migrationsFolder);
  const hasMigrations = files.some(f => f.endsWith('.sql'));

  if (!hasMigrations) {
    console.log('[DB] No migration files found, skipping.');
    return;
  }

  console.log('[DB] Running migrations...');
  await migrate(db, { migrationsFolder });
  console.log('[DB] Migrations complete.');
}
