/**
 * jwtSecret.ts — resolución del secreto JWT (Épica J / PJ-01).
 *
 * En producción JWT_SECRET es OBLIGATORIO: arrancar con el fallback público
 * deja firmar/verificar tokens con un secreto conocido. En dev/test se
 * mantiene el fallback para no exigir env en `vitest`/`tsx watch`.
 *
 * Se resuelve a nivel módulo en los callsites → el throw es fail-fast al boot.
 */
const DEV_FALLBACK = 'dev-secret-change-in-production';

export function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET es obligatorio cuando NODE_ENV=production. ' +
        'Generalo con: openssl rand -hex 32',
    );
  }
  return DEV_FALLBACK;
}
