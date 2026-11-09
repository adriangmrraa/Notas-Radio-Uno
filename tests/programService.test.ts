/**
 * Tests del slice PC-10 (repair): cobertura del código extraído de
 * `routes/programs.ts` a `src/server/services/programService.ts`.
 *
 * Sin DB real ni red: `db` se mockea (el módulo crea un Pool Neon al
 * importarse y pediría DATABASE_URL). Se cubre lo testeable en puro:
 *   - slugifyProgram  → diacríticos, espacios, caracteres inválidos, cap 100
 *   - pickUniqueSlug  → loop base/base-1/base-2 con fuente inyectada + excludeId
 *
 * La equivalencia con el `slugify` original de routes/programs.ts queda
 * fijada acá: una regresión futura en el slug rompe estos tests.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/server/db/index.js', () => ({ db: {} }));

import {
  pickUniqueSlug,
  slugifyProgram,
} from '../src/server/services/programService';

// ── slugifyProgram ───────────────────────────────────────────────────────────
describe('slugifyProgram', () => {
  it('minúsculas, sin diacríticos, espacios a guiones', () => {
    expect(slugifyProgram('Crónica Televisión')).toBe('cronica-television');
    expect(slugifyProgram('  Mi Programa 12  ')).toBe('mi-programa-12');
    expect(slugifyProgram('Señal & Café')).toBe('senal-cafe');
  });

  it('caracteres inválidos se eliminan y guiones colapsan', () => {
    expect(slugifyProgram('a---b___c')).toBe('a-bc');
    expect(slugifyProgram('Noticias (24hs)!')).toBe('noticias-24hs');
    expect(slugifyProgram('programa_123@ok')).toBe('programa123ok');
  });

  it('resultado vacío ante input sin caracteres válidos', () => {
    expect(slugifyProgram('   ')).toBe('');
    expect(slugifyProgram('!!!***')).toBe('');
  });

  it('NO recorta guiones de los bordes (comportamiento original preservado)', () => {
    // A diferencia de normalizeTenantSlug, el slugify de programas
    // siempre dejó guiones en los bordes; el refactor no lo cambió.
    expect(slugifyProgram('-Hola-')).toBe('-hola-');
  });

  it('corta a 100 caracteres', () => {
    expect(slugifyProgram('x'.repeat(150))).toBe('x'.repeat(100));
    expect(slugifyProgram('Programa ' + 'y'.repeat(200)).length).toBe(100);
  });
});

// ── pickUniqueSlug (ensureUniqueProgramSlug con fuente inyectada) ─────────────
describe('pickUniqueSlug', () => {
  const finder = (taken: Record<string, { id: string }>) =>
    (candidate: string) => Promise.resolve(taken[candidate] ?? null);

  it('slug libre ⇒ devuelve el base sin tocar', async () => {
    const slug = await pickUniqueSlug('informativo', finder({}));
    expect(slug).toBe('informativo');
  });

  it('slug tomado ⇒ base-1, base-2… hasta encontrar libre', async () => {
    const taken = {
      informativo: { id: 'p1' },
      'informativo-1': { id: 'p2' },
    };
    expect(await pickUniqueSlug('informativo', finder(taken))).toBe('informativo-2');
    expect(await pickUniqueSlug('informativo', finder({ informativo: { id: 'p1' } }))).toBe(
      'informativo-1',
    );
  });

  it('excludeId: el dueño actual del slug puede conservarlo', async () => {
    const taken = { informativo: { id: 'p1' } };
    // p1 re-guarda su propio slug ⇒ no incrementa
    expect(await pickUniqueSlug('informativo', finder(taken), 'p1')).toBe('informativo');
    // otro id ⇒ sí incrementa
    expect(await pickUniqueSlug('informativo', finder(taken), 'p9')).toBe('informativo-1');
  });

  it('consulta la fuente con cada candidato (orden base, base-1, base-2)', async () => {
    const seen: string[] = [];
    const slug = await pickUniqueSlug('show', async (c) => {
      seen.push(c);
      return seen.length <= 2 ? { id: `p${seen.length}` } : null;
    });
    expect(slug).toBe('show-2');
    expect(seen).toEqual(['show', 'show-1', 'show-2']);
  });
});
