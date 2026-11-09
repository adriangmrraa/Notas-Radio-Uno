import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

import { db } from '../db/index.js';
import { transmissions } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
    ensureRecording,
    addRecordingSegment,
    completeRecording,
    getByIdAnyTenant,
} from './transmissionService.js';
import { enqueue } from './jobsQueueService.js';
import { audit } from './auditService.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// vodIngestService — handler del job 'vod_ingest' (T-35)
//
//   upload (route) → transmission(source='vod_upload', status='processing')
//                  → vod_ingest → stream_recording + recording_segment único
//                  → poststream_analysis (mismo pipeline que live)
//
//   El archivo ya está en MEDIA_ROOT/{tenant}/{tx}/upload.* (lo movió la ruta).
//   startedAt de la tx = ancla wall-clock → segmento va de 0 a durationMs.
// ---------------------------------------------------------------------------

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/data/media');
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');

function findBinary(name: string): string {
    const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(toolsPath)) return toolsPath;
    return name;
}
const FFPROBE = findBinary('ffprobe');
const FFMPEG = findBinary('ffmpeg');

export interface VodIngestPayload {
    transmissionId: string;
    tenantId: string;
    fileRef: string;
}

/** Duración del archivo en ms (ffprobe; fallback: ffmpeg -i stderr). */
async function probeDurationMs(filePath: string): Promise<number> {
    try {
        const { stdout } = await execFileAsync(FFPROBE, [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', filePath,
        ], { timeout: 30_000 });
        const sec = parseFloat(stdout.trim());
        if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    } catch {
        // fallback abajo
    }
    try {
        await execFileAsync(FFMPEG, ['-i', filePath], { timeout: 30_000 });
    } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
        if (m) {
            const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
            return Math.round(sec * 1000);
        }
    }
    return 0;
}

export async function handleVodIngest(payload: VodIngestPayload): Promise<void> {
    const { transmissionId, tenantId, fileRef } = payload;
    const tx = await getByIdAnyTenant(transmissionId);
    if (!tx) throw new Error(`Transmission ${transmissionId} no encontrada`);
    if (tx.tenantId !== tenantId) throw new Error('tenant mismatch en vod_ingest');
    if (tx.source !== 'vod_upload') throw new Error(`tx ${transmissionId} no es vod_upload (source=${tx.source})`);

    const filePath = path.isAbsolute(fileRef) ? fileRef : path.join(MEDIA_ROOT, fileRef);
    if (!fs.existsSync(filePath)) throw new Error(`Archivo VOD no existe: ${fileRef}`);

    const stat = fs.statSync(filePath);
    const durationMs = await probeDurationMs(filePath);
    if (durationMs <= 0) throw new Error(`No se pudo determinar duración de ${fileRef}`);

    // 1 recording + 1 segmento que cubre todo el archivo (ancla: startedAt=0)
    const storagePrefix = path.dirname(fileRef).replace(/\\/g, '/');
    const recording = await ensureRecording(transmissionId, storagePrefix);
    await addRecordingSegment({
        recordingId: recording.id,
        sequence: 1,
        startMs: 0,
        endMs: durationMs,
        fileRef,
        bytes: stat.size,
    });
    await completeRecording(recording.id, 'completed', stat.size);

    await db.update(transmissions)
        .set({ durationMinutes: Math.round(durationMs / 60000) })
        .where(eq(transmissions.id, transmissionId));

    // Mismo pipeline post-live: transcribe segmentos → topics/moments → clips
    await enqueue('poststream_analysis', {
        transmissionId,
        tenantId,
        capturedMs: durationMs,
    }, { tenantId, dedupKey: `poststream:${transmissionId}` });

    void audit({
        tenantId,
        action: 'transmission.vod_ingested',
        metadata: { transmissionId, fileRef, durationMs, bytes: stat.size },
    });
    console.log(`[VodIngest] tx=${transmissionId} ingestado (${Math.round(durationMs / 1000)}s) → poststream encolado`);
}
