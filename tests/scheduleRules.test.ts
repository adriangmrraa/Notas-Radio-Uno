/**
 * Tests del slice PC-08: reglas de agenda (`src/server/lib/scheduleRules.ts`).
 *
 * Sin DB, sin red: `parseScheduleBody` (validación del body), `buildRRule`
 * (UI → RRULE) y `buildSchedule` (rrule + starts_at + next_run_at contra un
 * `now` inyectado). Los AC centrales:
 *   - puntual ⇒ `FREQ=DAILY;COUNT=1`, starts_at = la fecha/hora en la tz.
 *   - semanal [1,3,5] 18:00 ⇒ `FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0`.
 *   - diario ⇒ `FREQ=DAILY;BYHOUR=..;BYMINUTE=..`.
 *   - starts_at respeta la timezone (el mismo wall-clock da instantes UTC
 *     distintos en UTC vs America/Argentina/Buenos_Aires).
 *   - recurrencia vencida / fecha pasada ⇒ error (→ 400 en la ruta).
 *
 * Referencia: 2026-11-09 es LUNES. Buenos_Aires = UTC-3 todo el año.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRRule,
  buildSchedule,
  deriveSchedule,
  describeSchedule,
  occurrencesBetween,
  parseScheduleBody,
  type ScheduleInput,
} from '../src/server/lib/scheduleRules';

const UTC = 'UTC';
const BA = 'America/Argentina/Buenos_Aires';
const NOW = new Date('2026-11-09T12:00:00Z'); // lunes 09:00 ART / 12:00 UTC

const baseBody = {
  name: 'Informativo Central',
  streamUrl: 'https://youtube.com/@canal',
  mode: 'weekly',
  time: '18:00',
  daysOfWeek: [1, 3, 5],
  timezone: BA,
  durationMinutes: 60,
  autoStart: true,
};

// ── parseScheduleBody — happy path ────────────────────────────────────────────
describe('parseScheduleBody', () => {
  it('acepta un body completo válido y normaliza', () => {
    const parsed = parseScheduleBody(baseBody);
    expect(parsed.error).toBeUndefined();
    expect(parsed.fields).toMatchObject({
      name: 'Informativo Central',
      streamUrl: 'https://youtube.com/@canal',
      mode: 'weekly',
      time: '18:00',
      daysOfWeek: [1, 3, 5],
      timezone: BA,
      durationMinutes: 60,
      autoStart: true,
    });
  });

  it('rechaza body que no es objeto, nombre vacío y URL no-http', () => {
    expect(parseScheduleBody(null).error).toBeTruthy();
    expect(parseScheduleBody('x').error).toBeTruthy();
    expect(parseScheduleBody({ ...baseBody, name: '   ' }).error).toMatch(/nombre/i);
    expect(parseScheduleBody({ ...baseBody, streamUrl: 'ftp://x' }).error).toMatch(/streamUrl/i);
    expect(parseScheduleBody({ ...baseBody, streamUrl: 'no-url' }).error).toMatch(/streamUrl/i);
  });

  it('rechaza mode inválido, time inválida y timezone inexistente', () => {
    expect(parseScheduleBody({ ...baseBody, mode: 'monthly' }).error).toMatch(/mode/i);
    expect(parseScheduleBody({ ...baseBody, time: '25:00' }).error).toMatch(/time/i);
    expect(parseScheduleBody({ ...baseBody, time: '8:00' }).error).toMatch(/time/i);
    expect(parseScheduleBody({ ...baseBody, timezone: 'Marte/Olympus' }).error).toMatch(/timezone/i);
  });

  it('rechaza durationMinutes fuera de 5..480 y no entero', () => {
    expect(parseScheduleBody({ ...baseBody, durationMinutes: 4 }).error).toMatch(/durationMinutes/i);
    expect(parseScheduleBody({ ...baseBody, durationMinutes: 481 }).error).toMatch(/durationMinutes/i);
    expect(parseScheduleBody({ ...baseBody, durationMinutes: 60.5 }).error).toMatch(/durationMinutes/i);
    expect(parseScheduleBody({ ...baseBody, durationMinutes: '60' }).error).toMatch(/durationMinutes/i);
  });

  it('exige daysOfWeek no vacío en weekly, enteros 1..7, y date en once', () => {
    expect(parseScheduleBody({ ...baseBody, daysOfWeek: [] }).error).toMatch(/daysOfWeek/i);
    expect(parseScheduleBody({ ...baseBody, daysOfWeek: [0] }).error).toMatch(/daysOfWeek/i);
    expect(parseScheduleBody({ ...baseBody, daysOfWeek: [8] }).error).toMatch(/daysOfWeek/i);
    expect(
      parseScheduleBody({ ...baseBody, mode: 'once', daysOfWeek: undefined }).error,
    ).toMatch(/date/i);
    expect(
      parseScheduleBody({ ...baseBody, mode: 'once', date: '2026-02-30' }).error,
    ).toMatch(/date/i);
  });

  it('deduplica y ordena daysOfWeek; endsAt sólo en recurrencias', () => {
    const parsed = parseScheduleBody({ ...baseBody, daysOfWeek: [5, 1, 5, 3] });
    expect(parsed.fields?.daysOfWeek).toEqual([1, 3, 5]);
    expect(
      parseScheduleBody({ ...baseBody, mode: 'once', date: '2026-12-01', endsAt: '2026-12-31' }).error,
    ).toMatch(/endsAt/i);
  });

  it('programId debe ser UUID; autoStart/isActive booleans', () => {
    expect(parseScheduleBody({ ...baseBody, programId: 'abc' }).error).toMatch(/programId/i);
    expect(parseScheduleBody({ ...baseBody, autoStart: 'si' }).error).toMatch(/autoStart/i);
    expect(parseScheduleBody({ ...baseBody, isActive: 1 }).error).toMatch(/isActive/i);
    const ok = parseScheduleBody({
      ...baseBody,
      programId: '11111111-2222-3333-4444-555555555555',
    });
    expect(ok.fields?.programId).toBe('11111111-2222-3333-4444-555555555555');
  });
});

// ── buildRRule — UI → RRULE ───────────────────────────────────────────────────
describe('buildRRule', () => {
  const input = (over: Partial<ScheduleInput>): ScheduleInput =>
    ({ ...(baseBody as ScheduleInput), ...over });

  it('puntual ⇒ FREQ=DAILY;COUNT=1', () => {
    expect(buildRRule(input({ mode: 'once', date: '2026-12-25' }))).toBe('FREQ=DAILY;COUNT=1');
  });

  it('semanal [1,3,5] 18:00 ⇒ FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0', () => {
    expect(buildRRule(input({}))).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0');
  });

  it('domingo (ISO 7) ⇒ SU; diario ⇒ FREQ=DAILY;BYHOUR', () => {
    expect(buildRRule(input({ daysOfWeek: [7] }))).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=18;BYMINUTE=0',
    );
    expect(buildRRule(input({ mode: 'daily', time: '07:30' }))).toBe(
      'FREQ=DAILY;BYHOUR=7;BYMINUTE=30',
    );
  });

  it('endsAt ⇒ UNTIL=YYYYMMDD', () => {
    expect(buildRRule(input({ endsAt: '2026-12-31' }))).toBe(
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0;UNTIL=20261231',
    );
  });
});

// ── buildSchedule — starts_at + next_run_at con timezone ─────────────────────
describe('buildSchedule', () => {
  it('puntual: starts_at = fecha/hora en la tz; next_run_at = starts_at', () => {
    const ba = buildSchedule(
      { mode: 'once', date: '2026-11-10', time: '18:00', daysOfWeek: [], timezone: BA },
      NOW,
    );
    expect(ba.schedule?.startsAt.toISOString()).toBe('2026-11-10T21:00:00.000Z'); // 18:00 ART = 21:00 UTC
    expect(ba.schedule?.nextRunAt?.toISOString()).toBe('2026-11-10T21:00:00.000Z');
    expect(ba.schedule?.rrule).toBe('FREQ=DAILY;COUNT=1');

    // El MISMO wall-clock en UTC da otro instante ⇒ la tz manda.
    const utc = buildSchedule(
      { mode: 'once', date: '2026-11-10', time: '18:00', daysOfWeek: [], timezone: UTC },
      NOW,
    );
    expect(utc.schedule?.startsAt.toISOString()).toBe('2026-11-10T18:00:00.000Z');
    expect(utc.schedule!.startsAt.getTime()).not.toBe(ba.schedule!.startsAt.getTime());
  });

  it('puntual en el pasado ⇒ error (la fecha ya pasó)', () => {
    const r = buildSchedule(
      { mode: 'once', date: '2026-11-08', time: '18:00', daysOfWeek: [], timezone: BA },
      NOW,
    );
    expect(r.error).toMatch(/ya pas/i);
    expect(r.schedule).toBeUndefined();
  });

  it('semanal: starts_at = primera ocurrencia ≥ now (hoy lunes 18:00 ART = 21:00Z)', () => {
    const r = buildSchedule(
      { mode: 'weekly', time: '18:00', daysOfWeek: [1, 3, 5], timezone: BA },
      NOW,
    );
    expect(r.error).toBeUndefined();
    // NOW es lunes 09:00 ART: el lunes 18:00 todavía no pasó ⇒ es la primera.
    expect(r.schedule?.startsAt.toISOString()).toBe('2026-11-09T21:00:00.000Z');
    expect(r.schedule?.nextRunAt?.toISOString()).toBe('2026-11-09T21:00:00.000Z');
    expect(r.schedule?.endsAt).toBeNull();
  });

  it('semanal: si el slot de hoy ya pasó, la primera ocurrencia es el próximo día', () => {
    const r = buildSchedule(
      { mode: 'weekly', time: '18:00', daysOfWeek: [1, 3, 5], timezone: BA },
      new Date('2026-11-10T12:00:00Z'), // martes ⇒ primera = miércoles 18:00 ART
    );
    expect(r.schedule?.startsAt.toISOString()).toBe('2026-11-11T21:00:00.000Z');
  });

  it('diario: primera ocurrencia ≥ now; si la hora de hoy pasó, va mañana', () => {
    const r = buildSchedule(
      { mode: 'daily', time: '08:00', daysOfWeek: [], timezone: BA }, // 08:00 ART = 11:00Z < NOW
      NOW,
    );
    expect(r.schedule?.startsAt.toISOString()).toBe('2026-11-10T11:00:00.000Z');
  });

  it('recurrencia vencida (endsAt pasado) ⇒ error', () => {
    const r = buildSchedule(
      { mode: 'weekly', time: '18:00', daysOfWeek: [1, 3, 5], timezone: BA, endsAt: '2026-11-01' },
      NOW,
    );
    expect(r.error).toMatch(/ya termin/i);
  });

  it('endsAt futuro ⇒ columna ends_at = fin del día en la tz', () => {
    const r = buildSchedule(
      { mode: 'daily', time: '18:00', daysOfWeek: [], timezone: BA, endsAt: '2026-12-31' },
      NOW,
    );
    expect(r.schedule?.endsAt?.toISOString()).toBe('2027-01-01T02:59:59.000Z'); // 23:59:59 ART
    expect(r.schedule?.rrule).toContain('UNTIL=20261231');
  });
});

// ── deriveSchedule / describeSchedule — fila → formulario/UI ─────────────────
describe('deriveSchedule + describeSchedule', () => {
  it('puntual ⇒ mode once con date/time locales; descripción "Una sola vez"', () => {
    const d = deriveSchedule(
      'FREQ=DAILY;COUNT=1',
      new Date('2026-11-10T21:00:00Z'),
      null,
      BA,
    );
    expect(d).toEqual({ mode: 'once', date: '2026-11-10', time: '18:00', daysOfWeek: [] });
    expect(describeSchedule('FREQ=DAILY;COUNT=1')).toBe('Una sola vez');
  });

  it('semanal ⇒ días ISO y hora del RRULE; describeRRule para el resto', () => {
    const d = deriveSchedule(
      'FREQ=WEEKLY;BYDAY=SU,FR;BYHOUR=18;BYMINUTE=30',
      new Date('2026-11-11T21:00:00Z'),
      null,
      BA,
    );
    expect(d.mode).toBe('weekly');
    expect(d.daysOfWeek).toEqual([5, 7]);
    expect(d.time).toBe('18:30');
    expect(describeSchedule('FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0')).toBe(
      'Todos los lunes, miércoles y viernes a las 18:00',
    );
  });
});

// ── occurrencesBetween — expansión mensual para el calendario ────────────────
describe('occurrencesBetween', () => {
  const novStart = Date.UTC(2026, 10, 1);
  const decStart = Date.UTC(2026, 11, 1);

  it('semanal Lu/Mi/Vi 18:00 expande a los 13 días de noviembre 2026', () => {
    const occ = occurrencesBetween(
      'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18;BYMINUTE=0',
      UTC,
      new Date('2026-11-04T18:00:00Z'),
      novStart,
      decStart,
    );
    expect(occ).toHaveLength(13);
    expect(occ[0].toISOString()).toBe('2026-11-02T18:00:00.000Z'); // lunes 2
    expect(occ[12].toISOString()).toBe('2026-11-30T18:00:00.000Z'); // lunes 30
  });

  it('puntual incluye starts_at sólo si cae dentro del rango', () => {
    const startsAt = new Date('2026-11-20T21:00:00Z');
    expect(
      occurrencesBetween('FREQ=DAILY;COUNT=1', BA, startsAt, novStart, decStart),
    ).toEqual([startsAt]);
    expect(
      occurrencesBetween('FREQ=DAILY;COUNT=1', BA, startsAt, decStart, Date.UTC(2027, 0, 1)),
    ).toEqual([]);
  });

  it('respeta UNTIL: no expande ocurrencias después del límite', () => {
    const occ = occurrencesBetween(
      'FREQ=DAILY;BYHOUR=18;BYMINUTE=0;UNTIL=20261110',
      UTC,
      new Date('2026-11-01T18:00:00Z'),
      novStart,
      decStart,
    );
    expect(occ).toHaveLength(10); // 1..10 de noviembre, inclusive
    expect(occ[9].toISOString()).toBe('2026-11-10T18:00:00.000Z');
  });
});
