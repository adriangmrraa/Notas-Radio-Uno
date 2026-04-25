import { config } from 'dotenv';
config();

import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import * as schema from './schema/index.js';

// Required for Node.js (non-browser) environments
neonConfig.webSocketConstructor = ws;

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
export const db = drizzle({ client: pool, schema });

export type Database = typeof db;

export async function disconnectDb(): Promise<void> {
  await pool.end();
}
