/**
 * clipService.ts — Auto-Clips Verticales con Remotion
 *
 * Detecta momentos virales en transcripciones y genera clips verticales
 * (1080x1920, 9:16) listos para TikTok, Reels y Shorts.
 *
 * Flujo:
 *   1. detectHighlights() — Gemini analiza la transcripción y detecta 1-3 momentos
 *   2. generateClipVideo() — Remotion renderiza el video premium + ffmpeg mezcla audio
 *   3. createClip() — persiste el clip en la DB
 *   4. getClipsByTenant() — lista clips por tenant/status
 *
 * Render pipeline:
 *   a. npx remotion render <CompositionId> <tempVideo> --props='...'
 *   b. ffmpeg extrae segmento de audio del MP3 fuente
 *   c. ffmpeg fusiona video Remotion + audio segmentado → MP4 final
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { db } from '../db/index.js';
import { clips } from '../db/schema/clips.js';
import { eq, and, desc } from 'drizzle-orm';
import type { ClipCandidate, Clip, Utterance, BrandingConfig } from '../../shared/types.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const outputDir = path.join(PROJECT_ROOT, 'output');
const REMOTION_DIR = path.join(PROJECT_ROOT, 'remotion');

// Resolve ffmpeg binary (same logic as transcriptionService)
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');
function findBinary(name: string): string {
  const projectPath = path.join(PROJECT_ROOT, name);
  if (existsSync(projectPath)) return projectPath;
  const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
  if (existsSync(toolsPath)) return toolsPath;
  return name;
}
const FFMPEG = findBinary('ffmpeg');

// ─── Types ────────────────────────────────────────────────────────────────────

interface CreateClipInput {
  tenantId: string;
  publicationId?: string | null;
  programId?: string | null;
  title: string;
  hookText: string;
  audioPath?: string | null;
  videoPath?: string | null;
  subtitlesPath?: string | null;
  duration: number;
  status: Clip['status'];
  metadata?: Record<string, unknown> | null;
}

// ─── Highlight Detection ──────────────────────────────────────────────────────

/**
 * Usa Gemini para identificar 1-3 momentos "clip-worthy" en la transcripción.
 * Cada candidato tiene: startMs, endMs, hookText (frase gancho), reason.
 * Los clips deben durar entre 15 y 60 segundos.
 */
export async function detectHighlights(
  text: string,
  utterances: Utterance[],
): Promise<ClipCandidate[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  // Build utterance timeline for context
  const timeline = utterances.slice(0, 60).map(u =>
    `[${Math.round(u.start / 1000)}s - ${Math.round(u.end / 1000)}s] ${u.speaker}: ${u.text}`
  ).join('\n');

  const prompt = `Sos un productor de contenido viral experto en redes sociales.
Analizá esta transcripción de un programa de radio/TV y encontrá los 1-3 momentos más impactantes, virales o compartibles.

TRANSCRIPCIÓN:
${text.slice(0, 3000)}

LÍNEA DE TIEMPO (utterances con timestamps en ms):
${timeline}

Para cada momento identificá:
- startMs: tiempo de inicio en milisegundos
- endMs: tiempo de fin en milisegundos (el clip debe durar entre 15.000ms y 60.000ms)
- hookText: frase gancho corta y poderosa para usar como título del clip (máximo 80 caracteres)
- reason: por qué este momento es viral o impactante (1 oración)

IMPORTANTE: Los timestamps deben venir de la línea de tiempo de utterances proporcionada. Si no hay utterances, estimá basándote en el texto (promediá ~150 palabras por minuto).

Respondé SOLO con JSON válido en este formato:
{
  "clips": [
    { "startMs": 0, "endMs": 30000, "hookText": "...", "reason": "..." }
  ]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
  };

  const response = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini no devolvió respuesta de highlights');

  let parsed: { clips: ClipCandidate[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1].trim());
    } else {
      throw new Error(`No se pudo parsear la respuesta de Gemini: ${raw.slice(0, 200)}`);
    }
  }

  const candidates = (parsed.clips || []).filter((c: ClipCandidate) => {
    const duration = c.endMs - c.startMs;
    return duration >= 10000 && duration <= 90000;
  });

  return candidates.slice(0, 3);
}

// ─── Utterance excerpt helper ─────────────────────────────────────────────────

/**
 * Extrae un excerpt de texto de las utterances dentro del rango del clip.
 * Retorna las primeras ~200 caracteres del texto combinado.
 */
function getExcerptFromUtterances(
  utterances: Utterance[],
  startMs: number,
  endMs: number,
): string {
  const inRange = utterances
    .filter(u => u.end > startMs && u.start < endMs)
    .map(u => u.text.trim())
    .join(' ');
  return inRange.slice(0, 200);
}

// ─── Video Composition (Remotion) ────────────────────────────────────────────

/**
 * Genera un clip vertical 1080x1920 usando Remotion + ffmpeg.
 *
 * Pipeline:
 *   1. Remotion renderiza el video premium (QuoteClip o NewsClip) sin audio
 *   2. ffmpeg extrae el segmento de audio del MP3 fuente
 *   3. ffmpeg fusiona video Remotion + audio segmentado → MP4 final
 *
 * Retorna la ruta al MP4 final generado.
 */
export async function generateClipVideo(
  candidate: ClipCandidate,
  audioPath: string,
  utterances: Utterance[],
  branding: BrandingConfig,
  clipType: 'quote' | 'news' = 'news',
): Promise<string> {
  const uid = uuidv4().slice(0, 8);
  const outputPath = path.join(outputDir, `clip_${uid}.mp4`);
  const tempVideoPath = path.join(outputDir, `clip_temp_${uid}.mp4`);
  const audioSegmentPath = path.join(outputDir, `clip_audio_${uid}.mp3`);

  const durationMs = candidate.endMs - candidate.startMs;
  const durationInSeconds = Math.min(Math.max(Math.ceil(durationMs / 1000), 8), 30);
  const startSec = candidate.startMs / 1000;

  // Build Remotion props based on clip type
  const props =
    clipType === 'quote'
      ? {
          quoteText: candidate.hookText,
          speakerName: (candidate as any).speaker || 'Participante',
          speakerRole: (candidate as any).role || '',
          programName: branding.platformName,
          platformName: branding.platformName,
          durationInSeconds,
        }
      : {
          title: candidate.hookText,
          excerpt: getExcerptFromUtterances(utterances, candidate.startMs, candidate.endMs),
          hookText: candidate.hookText.split(' ').slice(0, 5).join(' ').toUpperCase(),
          programName: branding.platformName,
          platformName: branding.platformName,
          durationInSeconds,
        };

  const compositionId = clipType === 'quote' ? 'QuoteClip' : 'NewsClip';

  // Escape props JSON for shell (Windows: use double-quote escaping)
  const propsJson = JSON.stringify(props);

  try {
    // Step 1: Render with Remotion (video only, no audio)
    await execAsync(
      `cd "${REMOTION_DIR}" && npx remotion render ${compositionId} "${tempVideoPath}" --props='${propsJson.replace(/'/g, "'\\''")}'`,
      { timeout: 180000 },
    );

    // Step 2: Extract audio segment from source MP3
    const audioCmd = `"${FFMPEG}" -i "${audioPath}" -ss ${startSec} -t ${durationInSeconds} -c copy -y "${audioSegmentPath}"`;
    await execAsync(audioCmd, { timeout: 30000 });

    // Re-encode if copy produced an empty/broken segment
    const stats = await fs.stat(audioSegmentPath).catch(() => null);
    if (!stats || stats.size < 100) {
      const reencodeCmd = `"${FFMPEG}" -i "${audioPath}" -ss ${startSec} -t ${durationInSeconds} -c:a libmp3lame -q:a 4 -y "${audioSegmentPath}"`;
      await execAsync(reencodeCmd, { timeout: 30000 });
    }

    // Step 3: Merge Remotion video + audio segment
    const mergeCmd = [
      `"${FFMPEG}"`,
      `-i "${tempVideoPath}"`,
      `-i "${audioSegmentPath}"`,
      `-c:v copy`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      `-y "${outputPath}"`,
    ].join(' ');
    await execAsync(mergeCmd, { timeout: 60000 });

    return outputPath;
  } finally {
    // Cleanup temp files
    try { await fs.unlink(tempVideoPath); } catch (_) { /* ignore */ }
    try { await fs.unlink(audioSegmentPath); } catch (_) { /* ignore */ }
  }
}

// ─── Database Operations ──────────────────────────────────────────────────────

export async function createClip(input: CreateClipInput): Promise<Clip> {
  const [row] = await db.insert(clips).values({
    tenantId: input.tenantId,
    publicationId: input.publicationId ?? null,
    programId: input.programId ?? null,
    title: input.title,
    hookText: input.hookText,
    audioPath: input.audioPath ?? null,
    videoPath: input.videoPath ?? null,
    subtitlesPath: input.subtitlesPath ?? null,
    duration: input.duration,
    status: input.status,
    metadata: input.metadata ?? null,
  }).returning();

  return mapClip(row);
}

export async function getClipsByTenant(
  tenantId: string,
  status?: string,
  limit = 50,
  offset = 0,
): Promise<{ clips: Clip[]; total: number }> {
  const whereConditions = status
    ? and(eq(clips.tenantId, tenantId), eq(clips.status, status as Clip['status']))
    : eq(clips.tenantId, tenantId);

  const [rows, countResult] = await Promise.all([
    db.select().from(clips)
      .where(whereConditions)
      .orderBy(desc(clips.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: clips.id }).from(clips).where(whereConditions),
  ]);

  return {
    clips: rows.map(mapClip),
    total: countResult.length,
  };
}

export async function getClipById(id: string, tenantId: string): Promise<Clip | null> {
  const [row] = await db.select().from(clips)
    .where(and(eq(clips.id, id), eq(clips.tenantId, tenantId)))
    .limit(1);

  return row ? mapClip(row) : null;
}

export async function updateClipStatus(
  id: string,
  tenantId: string,
  status: Clip['status'],
): Promise<void> {
  await db.update(clips)
    .set({ status })
    .where(and(eq(clips.id, id), eq(clips.tenantId, tenantId)));
}

export async function updateClipVideoPath(
  id: string,
  tenantId: string,
  videoPath: string,
): Promise<void> {
  await db.update(clips)
    .set({ videoPath, status: 'pending_review' })
    .where(and(eq(clips.id, id), eq(clips.tenantId, tenantId)));
}

export async function deleteClip(id: string, tenantId: string): Promise<void> {
  // Get the clip first to clean up files
  const clip = await getClipById(id, tenantId);
  if (clip?.videoPath) {
    try { await fs.unlink(clip.videoPath); } catch (_) { /* ignore */ }
  }

  await db.delete(clips).where(and(eq(clips.id, id), eq(clips.tenantId, tenantId)));
}

function mapClip(row: typeof clips.$inferSelect): Clip {
  return {
    id: row.id,
    tenantId: row.tenantId,
    publicationId: row.publicationId ?? null,
    programId: row.programId ?? null,
    title: row.title,
    hookText: row.hookText,
    videoPath: row.videoPath ?? null,
    duration: row.duration,
    status: (row.status ?? 'generating') as Clip['status'],
    metadata: (row.metadata as Record<string, unknown>) ?? null,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}
