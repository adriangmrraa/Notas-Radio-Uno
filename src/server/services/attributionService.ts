import { db } from '../db/index.js';
import {
    personAppearances,
    transmissionSegments,
    transmissions,
    persons,
} from '../db/schema/index.js';
import { eq, and, inArray, isNotNull, gte, lt, asc } from 'drizzle-orm';
import { emitToTenant } from './notificationService.js';
import { audit } from './auditService.js';
import type { Utterance } from '../../shared/types.js';

// ---------------------------------------------------------------------------
// attributionService — fusión speaker↔rostro por wall-clock (T-26)
//
//   utterances (diarización, wall-clock) × person_appearances(face)
//     → persona dominante por ventana → person_appearances(source='fusion',
//       speakerLabel, personId?, confidence). Ambiguo → personId null + baja
//       confianza — NUNCA inventa una atribución.
//
//   Mapa speakerLabel→personId por transmisión:
//     - manual (source='manual' en appearances) = ground truth, gana siempre.
//     - fusion = voto ponderado por confidence acumulada por label.
//   Corrección manual (POST /live/:tx/correct): re-etiqueta TODAS las
//   appearances emitidas del label (backward) y el mapa guía la fusión de
//   las siguientes (forward).
//
//   Entradas de utterances:
//     - vivo: AutoPipeline emite por chunk vía setUtteranceSink → engine.
//     - post-stream: poststreamAnalysisService re-ingesta todo el timeline.
//   Idempotente: al ingerir, se borran las appearances 'fusion' solapadas —
//   re-runs (job retry) no duplican filas.
// ---------------------------------------------------------------------------

type AppearanceRow = typeof personAppearances.$inferSelect;

/** Peso mínimo de solapamiento cara↔utterance para proponer una persona. */
const MIN_DOMINANT_OVERLAP_MS = Number(process.env.ATTRIB_MIN_OVERLAP_MS ?? 800);
/** Dominancia mínima del top candidato (share del peso total) para atribuir. */
const MIN_DOMINANT_SHARE = Number(process.env.ATTRIB_MIN_SHARE ?? 0.55);
/** Cobertura de una appearance 'manual' que decide directo (ground truth). */
const MANUAL_OVERRIDE_COVERAGE = 0.3;

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
async function listAppearancesIn(txId: string, startMs: number, endMs: number): Promise<AppearanceRow[]> {
    return db.select().from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, txId),
            lt(personAppearances.startMs, endMs),
            gte(personAppearances.endMs, startMs),
        ))
        .orderBy(asc(personAppearances.startMs));
}

async function getManualSpeakerMap(txId: string): Promise<Map<string, string | null>> {
    const rows = await db.select({
        speakerLabel: personAppearances.speakerLabel,
        personId: personAppearances.personId,
        createdAt: personAppearances.createdAt,
    }).from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, txId),
            eq(personAppearances.source, 'manual'),
            isNotNull(personAppearances.speakerLabel),
        ))
        .orderBy(asc(personAppearances.createdAt));

    // Última corrección gana por label.
    const map = new Map<string, string | null>();
    for (const r of rows) if (r.speakerLabel) map.set(r.speakerLabel, r.personId);
    return map;
}

export interface SpeakerAttribution {
    personId: string | null;
    personName: string | null;
    confidence: number;
    source: 'manual' | 'fusion';
}

/**
 * Mapa speakerLabel→persona para una transmisión:
 * manual (correcciones del editor) ∪ consenso de fusion (voto ponderado).
 */
export async function getSpeakerMap(txId: string): Promise<Map<string, SpeakerAttribution>> {
    const [manual, fusionRows] = await Promise.all([
        getManualSpeakerMap(txId),
        db.select({
            speakerLabel: personAppearances.speakerLabel,
            personId: personAppearances.personId,
            confidence: personAppearances.confidence,
        }).from(personAppearances)
            .where(and(
                eq(personAppearances.transmissionId, txId),
                eq(personAppearances.source, 'fusion'),
                isNotNull(personAppearances.speakerLabel),
                isNotNull(personAppearances.personId),
            )),
    ]);

    // Consenso fusion: voto ponderado por confidence por (label, person).
    const votes = new Map<string, Map<string, number>>();
    for (const r of fusionRows) {
        if (!r.speakerLabel || !r.personId) continue;
        const perPerson = votes.get(r.speakerLabel) ?? new Map<string, number>();
        perPerson.set(r.personId, (perPerson.get(r.personId) ?? 0) + num(r.confidence));
        votes.set(r.speakerLabel, perPerson);
    }

    const personIds = new Set<string>();
    const out = new Map<string, SpeakerAttribution>();
    for (const [label, perPerson] of votes) {
        let bestId: string | null = null;
        let bestW = 0;
        let total = 0;
        for (const [pid, w] of perPerson) {
            total += w;
            if (w > bestW) { bestW = w; bestId = pid; }
        }
        if (bestId) {
            out.set(label, { personId: bestId, personName: null, confidence: total > 0 ? bestW / total : 0, source: 'fusion' });
            personIds.add(bestId);
        }
    }
    for (const [label, pid] of manual) {
        out.set(label, { personId: pid, personName: null, confidence: 1, source: 'manual' });
        if (pid) personIds.add(pid);
    }

    // Resolver nombres en una query.
    if (personIds.size > 0) {
        const names = await db.select({ id: persons.id, name: persons.name })
            .from(persons).where(inArray(persons.id, Array.from(personIds)));
        const nameById = new Map(names.map((n) => [n.id, n.name]));
        for (const v of out.values()) {
            if (v.personId) v.personName = nameById.get(v.personId) ?? null;
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Núcleo de fusión — persona dominante en una ventana [startMs,endMs]
// ---------------------------------------------------------------------------
export interface WindowAttribution {
    personId: string | null;
    confidence: number;
    /** peso crudo del ganador (ms × confidence), para debugging */
    dominantWeight: number;
}

/**
 * Quién estaba en pantalla en [startMs,endMs]:
 *   - 'manual' que cubre ≥30% de la ventana → ground truth directo.
 *   - 'face': peso por persona = Σ solapamiento(ms) × confidence. Rostros
 *     desconocidos (personId null) diluyen — bajan la confianza del ganador.
 *   - Dominancia < MIN_DOMINANT_SHARE o peso < MIN_DOMINANT_OVERLAP_MS →
 *     personId null (ambiguo — nunca inventa).
 */
export function dominantPersonInWindow(
    appearances: Pick<AppearanceRow, 'personId' | 'source' | 'startMs' | 'endMs' | 'confidence'>[],
    startMs: number,
    endMs: number,
): WindowAttribution {
    const windowMs = Math.max(1, endMs - startMs);

    // 1. Ground truth manual
    for (const a of appearances) {
        if (a.source !== 'manual' || !a.personId) continue;
        const overlap = Math.min(a.endMs, endMs) - Math.max(a.startMs, startMs);
        if (overlap / windowMs >= MANUAL_OVERRIDE_COVERAGE) {
            return { personId: a.personId, confidence: 1, dominantWeight: overlap };
        }
    }

    // 2. Evidencia facial ponderada
    const weights = new Map<string, number>();
    let totalWeight = 0;
    for (const a of appearances) {
        if (a.source !== 'face' && a.source !== 'fusion') continue;
        const overlap = Math.max(0, Math.min(a.endMs, endMs) - Math.max(a.startMs, startMs));
        if (overlap <= 0) continue;
        const conf = Math.max(0.05, num(a.confidence));
        const w = overlap * conf;
        totalWeight += w;
        if (a.personId) weights.set(a.personId, (weights.get(a.personId) ?? 0) + w);
    }

    let bestId: string | null = null;
    let bestW = 0;
    for (const [pid, w] of weights) {
        if (w > bestW) { bestW = w; bestId = pid; }
    }

    const share = totalWeight > 0 ? bestW / totalWeight : 0;
    if (!bestId || bestW < MIN_DOMINANT_OVERLAP_MS || share < MIN_DOMINANT_SHARE) {
        return { personId: null, confidence: Number(share.toFixed(3)), dominantWeight: bestW };
    }
    return { personId: bestId, confidence: Number(share.toFixed(3)), dominantWeight: bestW };
}

/** Atribución de una ventana contra la DB (helper para clipCutter). */
export async function attributeWindow(txId: string, startMs: number, endMs: number): Promise<WindowAttribution & { personName: string | null }> {
    const appearances = await listAppearancesIn(txId, startMs, endMs);
    const attr = dominantPersonInWindow(appearances, startMs, endMs);
    if (!attr.personId) return { ...attr, personName: null };
    const [p] = await db.select({ name: persons.name }).from(persons)
        .where(eq(persons.id, attr.personId)).limit(1);
    return { ...attr, personName: p?.name ?? null };
}

/** Personas distintas atribuidas en la ventana (para asset_persons). */
export async function personIdsInWindow(txId: string, startMs: number, endMs: number): Promise<string[]> {
    const rows = await db.select({ personId: personAppearances.personId })
        .from(personAppearances)
        .where(and(
            eq(personAppearances.transmissionId, txId),
            isNotNull(personAppearances.personId),
            lt(personAppearances.startMs, endMs),
            gte(personAppearances.endMs, startMs),
        ));
    return Array.from(new Set(rows.map((r) => r.personId).filter((x): x is string => !!x)));
}

// ---------------------------------------------------------------------------
// Ingesta de utterances → appearances 'fusion'
// ---------------------------------------------------------------------------
export async function ingestUtterances(txId: string, utterances: Utterance[]): Promise<number> {
    const usable = utterances.filter((u) => u.speaker && u.end > u.start);
    if (usable.length === 0) return 0;

    const [txRow] = await db.select({ tenantId: transmissions.tenantId })
        .from(transmissions).where(eq(transmissions.id, txId)).limit(1);
    const tenantId = txRow?.tenantId ?? null;
    if (!tenantId) {
        console.warn(`[Attribution] ingestUtterances: tx=${txId} no existe — skip`);
        return 0;
    }

    const minStart = Math.min(...usable.map((u) => u.start));
    const maxEnd = Math.max(...usable.map((u) => u.end));

    const [appearances, speakerMap] = await Promise.all([
        listAppearancesIn(txId, minStart, maxEnd),
        getSpeakerMap(txId),
    ]);

    // Idempotencia: borrar appearances 'fusion' que ya cubren este rango
    // (las 'manual' jamás se tocan — son ground truth del editor).
    await db.delete(personAppearances).where(and(
        eq(personAppearances.transmissionId, txId),
        eq(personAppearances.source, 'fusion'),
        lt(personAppearances.startMs, maxEnd),
        gte(personAppearances.endMs, minStart),
    ));

    let inserted = 0;
    for (const u of usable) {
        const manual = speakerMap.get(u.speaker);
        let personId: string | null;
        let confidence: number;
        if (manual && manual.source === 'manual') {
            // Corrección del editor aplica FORWARD: el label quedó fijado.
            personId = manual.personId;
            confidence = manual.personId ? 0.99 : 0;
        } else {
            const attr = dominantPersonInWindow(appearances, u.start, u.end);
            personId = attr.personId;
            confidence = attr.confidence;
        }

        await db.insert(personAppearances).values({
            transmissionId: txId,
            tenantId,
            personId,
            speakerLabel: u.speaker,
            source: 'fusion',
            startMs: Math.round(u.start),
            endMs: Math.round(u.end),
            confidence: confidence.toFixed(3),
        });
        inserted++;
    }
    return inserted;
}

// ---------------------------------------------------------------------------
// Corrección manual — forward + backward (spec face-attribution)
// ---------------------------------------------------------------------------
export async function correctSpeaker(input: {
    txId: string;
    speakerLabel: string;
    /** personId o null para "desasignar" el label. */
    personId: string | null;
    actorUserId?: string | null;
}): Promise<{ updated: number }> {
    const { txId, speakerLabel, personId } = input;

    const [txRow] = await db.select({ tenantId: transmissions.tenantId })
        .from(transmissions).where(eq(transmissions.id, txId)).limit(1);
    if (!txRow) throw new Error('Transmission not found');
    const tenantId = txRow.tenantId;

    if (personId) {
        const [p] = await db.select({ id: persons.id }).from(persons)
            .where(and(eq(persons.id, personId), eq(persons.tenantId, tenantId))).limit(1);
        if (!p) throw new Error('personId no existe en este tenant');
    }

    // Backward: re-etiquetar TODAS las appearances emitidas con ese label
    // (fusion + manuales previas). Las 'face' NO se tocan — son evidencia
    // visual independiente, no atribución de speaker.
    const updated = await db.update(personAppearances)
        .set({ personId, source: 'manual' })
        .where(and(
            eq(personAppearances.transmissionId, txId),
            eq(personAppearances.speakerLabel, speakerLabel),
            inArray(personAppearances.source, ['fusion', 'manual']),
        ))
        .returning({ id: personAppearances.id });

    emitToTenant(tenantId, 'transmission:update', {
        transmissionId: txId,
        speakerCorrected: speakerLabel,
        personId,
        updatedAppearances: updated.length,
    });
    void audit({
        actorUserId: input.actorUserId ?? null,
        tenantId,
        action: 'live.speaker_corrected',
        metadata: { transmissionId: txId, speakerLabel, personId, updated: updated.length },
    });
    return { updated: updated.length };
}

// ---------------------------------------------------------------------------
// Re-fusión por ventanas (kind='auto' en /live/:tx/correct)
// Re-corre la fusión sobre las ventanas speaker de transmission_segments —
// útil tras enrolar personas tarde o corregir embeddings.
// ---------------------------------------------------------------------------
export async function fuseTransmission(txId: string): Promise<{ fused: number }> {
    const segments = await db.select().from(transmissionSegments)
        .where(and(
            eq(transmissionSegments.transmissionId, txId),
            isNotNull(transmissionSegments.startMs),
            isNotNull(transmissionSegments.endMs),
        ))
        .orderBy(asc(transmissionSegments.startMs));

    const pseudoUtterances: Utterance[] = [];
    for (const seg of segments) {
        if (seg.startMs == null || seg.endMs == null || seg.endMs <= seg.startMs) continue;
        const labels = Array.isArray(seg.speakers) ? (seg.speakers as string[]) : [];
        for (const label of labels) {
            if (!label) continue;
            pseudoUtterances.push({ speaker: label, text: '', start: seg.startMs, end: seg.endMs });
        }
    }
    const fused = await ingestUtterances(txId, pseudoUtterances);
    return { fused };
}
