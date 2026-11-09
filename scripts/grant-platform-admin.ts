/**
 * grant-platform-admin.ts — Otorga o revoca el flag de super admin de plataforma.
 *
 * Uso:
 *   npx tsx scripts/grant-platform-admin.ts admin@periodistapp.com
 *   npx tsx scripts/grant-platform-admin.ts admin@periodistapp.com --revoke
 *
 * Es la ÚNICA vía prevista para setear `users.is_platform_admin`: el flag nunca
 * se puede tocar desde la API pública ni desde la de tenant.
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, disconnectDb } from '../src/server/db/index.js';
import { users } from '../src/server/db/schema/index.js';

async function main(): Promise<void> {
  const email = process.argv[2]?.toLowerCase().trim();
  const revoke = process.argv.includes('--revoke');

  if (!email) {
    console.error('Uso: npx tsx scripts/grant-platform-admin.ts <email> [--revoke]');
    process.exit(1);
  }

  const [user] = await db
    .select({ id: users.id, email: users.email, fullName: users.fullName })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    console.error(`No existe un usuario con email ${email}`);
    process.exit(1);
  }

  await db.update(users).set({ isPlatformAdmin: !revoke }).where(eq(users.id, user.id));

  console.log(
    `${revoke ? 'Revocado' : 'Otorgado'} platform admin a ${user.fullName} <${user.email}> (${user.id})`,
  );
}

main()
  .catch((err) => {
    console.error('[grant-platform-admin] Error:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
