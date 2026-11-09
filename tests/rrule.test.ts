/**
 * Tests del slice PC-07: helper de recurrencia RRULE (`src/server/lib/rrule.ts`).
 *
 * Sin DB, sin red: funciones puras. Los AC centrales:
 *   - FREQ=DAILY ⇒ próxima ocurrencia al día siguiente a la hora indicada.
 *   - FREQ=WEEKLY;BYDAY=MO,WE,FR ⇒ el próximo día de esos a la hora indicada.
 *   - INTERVAL=2 con WEEKLY ⇒ salta una semana.
 *   - UNTIL pasado / COUNT agotado ⇒ null.
 *   - RRULE inválido ⇒ error descriptivo.
 *   - El mismo RRULE en distintas timezone da instantes distintos (la tz manda).
 *
 * Referencia de fechas: 2026-11-09 es LUNES. America/Argentina/Buenos_Aires es
 * UTC-3 todo el año (sin DST).
 */
import { describe, expect, it } from 'vitest';
import { describeRRule, nextOccurrence, parseRRule } from '../src/server/lib/rrule';

const UTC = 'UTC';
const BA = 'America/Argentina/Buenos_Aires';

// ── parseRRule ────────────────────────────────────────────────────────────────
describe('parseRRule', () => {
  it('parsea FREQ, INTERVAL, BYDAY, BYHOUR, BYMINUTE, BYMONTHDAY, UNTIL y COUNT', () => {
    const p = parseRRule(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR,MO;BYHOUR=18;BYMINUTE=0,30;BYMONTHDAY=15;UNTIL=20261231T235959Z;COUNT=10',
    );
    expect(p.freq).toBe('WEEKLY');
    expect(p.interval).toBe(2);
    expect(p.byDay).toEqual([1, 5]); // orden MO→SU
    expect(p.byHour).toEqual([18]);
    expect(p.byMinute).toEqual([0, 30]);
    expect(p.byMonthDay).toEqual([15]);
    expect(p.count).toBe(10);
    expect(p.until).toMatchObject({ year: 2026, month: 12, day: 31, utc: true });
  });

  it('tolera el prefijo RRULE: y defaults sensatos', () => {
    const p = parseRRule('RRULE:FREQ=DAILY');
    expect(p).toMatchObject({ freq: 'DAILY', interval: 1, byDay: [], byHour: [], count: undefined });
  });
});

// ── nextOccurrence — happy paths ──────────────────────────────────────────────
describe('nextOccurrence', () => {
  it('FREQ=DAILY ⇒ próxima ocurrencia es mañana a la hora indicada', () => {
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=9;BYMINUTE=30', new Date('2026-11-09T20:00:00Z'), UTC);
    expect(next?.toISOString()).toBe('2026-11-10T09:30:00.000Z');
  });

  it('FREQ=DAILY ⇒ si la hora de hoy todavía no pasó, dispara hoy', () => {
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=9;BYMINUTE=30', new Date('2026-11-09T08:00:00Z'), UTC);
    expect(next?.toISOString()).toBe('2026-11-09T09:30:00.000Z');
  });

  it('FREQ=WEEKLY;BYDAY=MO,WE,FR ⇒ el próximo día de esos a las 18:00', () => {
    // martes ⇒ miércoles
    expect(
      nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0', new Date('2026-11-10T12:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-11-11T18:00:00.000Z');
    // viernes después de las 18:00 ⇒ lunes de la semana siguiente
    expect(
      nextOccurrence('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0', new Date('2026-11-13T19:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-11-16T18:00:00.000Z');
  });

  it('una ocurrencia exactamente en `from` ya se considera usada (estrictamente posterior)', () => {
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=18;BYMINUTE=0', new Date('2026-11-09T18:00:00Z'), UTC);
    expect(next?.toISOString()).toBe('2026-11-10T18:00:00.000Z');
  });

  it('INTERVAL=2 con FREQ=WEEKLY ⇒ salta una semana', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=18;BYMINUTE=0';
    const from = new Date('2026-11-10T12:00:00Z'); // martes; el lunes 9 ya pasó
    // sin INTERVAL el próximo lunes sería 2026-11-16
    expect(
      nextOccurrence('FREQ=WEEKLY;BYDAY=MO;BYHOUR=18;BYMINUTE=0', from, UTC)?.toISOString(),
    ).toBe('2026-11-16T18:00:00.000Z');
    // con INTERVAL=2 la semana del 16 se salta ⇒ lunes 23
    expect(nextOccurrence(rule, from, UTC)?.toISOString()).toBe('2026-11-23T18:00:00.000Z');
  });

  it('FREQ=MONTHLY con BYMONTHDAY respeta el día y soporta negativos (fin de mes)', () => {
    expect(
      nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=12;BYMINUTE=0', new Date('2026-11-09T12:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-11-15T12:00:00.000Z');
    // -1 = último día del mes
    expect(
      nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=12;BYMINUTE=0', new Date('2026-11-09T12:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-11-30T12:00:00.000Z');
    // día 31 en mes de 30 se salta ese mes
    expect(
      nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=12;BYMINUTE=0', new Date('2026-11-09T12:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-12-31T12:00:00.000Z');
  });

  // ── Límites de la recurrencia ───────────────────────────────────────────────
  it('UNTIL en el pasado ⇒ null (recurrencia vencida)', () => {
    expect(
      nextOccurrence('FREQ=DAILY;BYHOUR=10;BYMINUTE=0;UNTIL=20200101T000000Z', new Date('2026-11-09T12:00:00Z'), UTC),
    ).toBeNull();
  });

  it('UNTIL corta la serie: devuelve la última ocurrencia válida y después null', () => {
    const rule = 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0;UNTIL=20261110T120000Z';
    expect(nextOccurrence(rule, new Date('2026-11-10T09:00:00Z'), UTC)?.toISOString()).toBe(
      '2026-11-10T10:00:00.000Z',
    );
    expect(nextOccurrence(rule, new Date('2026-11-10T13:00:00Z'), UTC)).toBeNull();
  });

  it('COUNT agotado ⇒ null', () => {
    const rule = 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0;COUNT=1';
    // lunes 17:00 ⇒ la ocurrencia #1 (hoy 18:00) todavía corre
    expect(nextOccurrence(rule, new Date('2026-11-09T17:00:00Z'), UTC)?.toISOString()).toBe(
      '2026-11-09T18:00:00.000Z',
    );
    // lunes 20:00 ⇒ la #1 ya se usó; la de mañana sería la #2 > COUNT ⇒ null
    expect(nextOccurrence(rule, new Date('2026-11-09T20:00:00Z'), UTC)).toBeNull();
    // con COUNT=2 la de mañana es la #2 y alcanza
    expect(
      nextOccurrence('FREQ=DAILY;BYHOUR=18;BYMINUTE=0;COUNT=2', new Date('2026-11-09T20:00:00Z'), UTC)
        ?.toISOString(),
    ).toBe('2026-11-10T18:00:00.000Z');
  });

  // ── Timezone: la tz de la regla manda, no la del server ─────────────────────
  it('el mismo RRULE en Buenos_Aires vs UTC da instantes distintos', () => {
    const rule = 'FREQ=DAILY;BYHOUR=18;BYMINUTE=0';
    const from = new Date('2026-11-09T20:00:00Z'); // lunes 20:00 UTC = lunes 17:00 en BA

    const nextUtc = nextOccurrence(rule, from, UTC);
    const nextBa = nextOccurrence(rule, from, BA);

    // En UTC las 18:00 de hoy ya pasaron ⇒ mañana 18:00Z.
    expect(nextUtc?.toISOString()).toBe('2026-11-10T18:00:00.000Z');
    // En BA recién son las 17:00 ⇒ las 18:00 de HOY (21:00Z).
    expect(nextBa?.toISOString()).toBe('2026-11-09T21:00:00.000Z');
    // Mismo input, distinto instante: la timezone de la regla decide.
    expect(nextBa?.getTime()).not.toBe(nextUtc?.getTime());
  });

  it('la fecha local también depende de la tz (mismo instante, distinto "hoy")', () => {
    const rule = 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=18;BYMINUTE=0';
    const from = new Date('2026-11-10T01:00:00Z'); // UTC: martes 01:00 · BA: lunes 22:00
    // En UTC hoy es martes ⇒ hoy 18:00.
    expect(nextOccurrence(rule, from, UTC)?.toISOString()).toBe('2026-11-10T18:00:00.000Z');
    // En BA hoy todavía es lunes ⇒ el martes 18:00 BA = 21:00Z.
    expect(nextOccurrence(rule, from, BA)?.toISOString()).toBe('2026-11-10T21:00:00.000Z');
  });

  // ── Errores descriptivos ────────────────────────────────────────────────────
  it('RRULE inválido ⇒ error descriptivo', () => {
    expect(() => nextOccurrence('', new Date(), UTC)).toThrow(/vacío/i);
    expect(() => nextOccurrence('   ', new Date(), UTC)).toThrow(/vacío/i);
    expect(() => nextOccurrence('BYDAY=MO;BYHOUR=18', new Date(), UTC)).toThrow(/FREQ/);
    expect(() => nextOccurrence('FREQ=WEEKLY;BYDAY=XX', new Date(), UTC)).toThrow(/BYDAY.*XX/);
    expect(() => nextOccurrence('FREQ=SECONDLY', new Date(), UTC)).toThrow(/FREQ=SECONDLY/);
    expect(() => nextOccurrence('FREQ=DAILY;BYHOUR=25', new Date(), UTC)).toThrow(/BYHOUR/);
    expect(() => nextOccurrence('FREQ=DAILY;INTERVAL=0', new Date(), UTC)).toThrow(/INTERVAL/);
    expect(() => nextOccurrence('FREQ=DAILY;BYMONTHDAY=0', new Date(), UTC)).toThrow(/BYMONTHDAY/);
    expect(() => nextOccurrence('FREQ=DAILY;UNTIL=ayer', new Date(), UTC)).toThrow(/UNTIL/);
    expect(() => nextOccurrence('FREQ=DAILY', new Date(), 'Marte/Olympus')).toThrow(/[Tt]imezone/);
  });
});

// ── describeRRule ─────────────────────────────────────────────────────────────
describe('describeRRule', () => {
  it('genera descripciones en español razonables', () => {
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0')).toBe(
      'Todos los lunes, miércoles y viernes a las 18:00',
    );
    expect(describeRRule('FREQ=DAILY;BYHOUR=9;BYMINUTE=30')).toBe('Todos los días a las 09:30');
    expect(describeRRule('FREQ=DAILY')).toBe('Todos los días');
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Cada mes el día 15');
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=20;BYMINUTE=0')).toBe(
      'Cada mes el último día a las 20:00',
    );
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU')).toBe('Cada 2 semanas los domingos');
  });

  it('RRULE inválido ⇒ error descriptivo', () => {
    expect(() => describeRRule('sin-freq')).toThrow();
  });
});
