import { db } from './index.js';
import { sql } from 'drizzle-orm';

export async function runMigrations(): Promise<void> {
  try {
    // Verify database connection
    await db.execute(sql`SELECT 1`);
    console.log('[DB] Connected to database.');
  } catch (err) {
    console.error('[DB] Failed to connect to database:', err);
    throw err;
  }
}
