import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { db } from './index.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';

export async function runMigrations(): Promise<void> {
  // Verify connection first
  await db.execute(sql`SELECT 1`);
  console.log('[DB] Connected to database.');

  const migrationsFolder = './drizzle';

  if (!fs.existsSync(migrationsFolder)) {
    console.log('[DB] No migrations folder found, skipping.');
    return;
  }

  const hasMigrations = fs.readdirSync(migrationsFolder).some(f => f.endsWith('.sql'));
  if (!hasMigrations) {
    console.log('[DB] No migration files found, skipping.');
    return;
  }

  try {
    console.log('[DB] Running migrations...');
    await migrate(db, { migrationsFolder });
    console.log('[DB] Migrations complete.');
  } catch (err: any) {
    const pgCode = err?.cause?.code;
    // 42710 = type already exists, 42P07 = table already exists
    if (pgCode === '42710' || pgCode === '42P07') {
      console.log('[DB] Schema already exists, marking migrations as applied...');
      // Create the drizzle migrations tracking table if needed and mark as done
      await markExistingMigrationsAsApplied(migrationsFolder);
      console.log('[DB] Migrations marked as applied.');
      return;
    }
    throw err;
  }
}

async function markExistingMigrationsAsApplied(migrationsFolder: string): Promise<void> {
  // Ensure the drizzle journal table exists
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `);

  // Read the migration journal to get hashes
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  if (!fs.existsSync(journalPath)) return;

  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

  for (const entry of journal.entries) {
    const exists = await db.execute(
      sql`SELECT 1 FROM "__drizzle_migrations" WHERE hash = ${entry.tag}`
    );
    if (exists.rows.length === 0) {
      await db.execute(
        sql`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (${entry.tag}, ${Date.now()})`
      );
    }
  }
}
