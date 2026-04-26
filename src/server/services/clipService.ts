/**
 * clipService.ts — Auto-Clips Verticales con Subtítulos
 *
 * Detecta momentos virales en transcripciones y genera clips verticales
 * (1080x1920, 9:16) listos para TikTok, Reels y Shorts.
 *
 * Flujo:
 *   1. detectHighlights() — Gemini analiza la transcripción y detecta 1-3 momentos
 *   2. generateClipVideo() — ffmpeg compone el video vertical con subtítulos quemados
 *   3. createClip() — persiste el clip en la DB
 *   4. getClipsByTenant() — lista clips por tenant/status
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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

// Resolve ffmpeg binary (same logic as transcriptionService)
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');
function findBinary(name: string): string {
  const projectPath = path.join(PROJECT_ROOT, name);
  if (fs.existsSync(projectPath)) return projectPath;
  const toolsPath = path.join(TOOLS_DIR, process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(toolsPath)) return toolsPath;
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

// ─── Background Frame Generation ─────────────────────────────────────────────

/**
 * Genera un frame PNG 1080x1920 con gradiente oscuro, logo y nombre de plataforma.
 * Devuelve la ruta al archivo PNG generado.
 */
async function generateBackgroundFrame(branding: BrandingConfig): Promise<string> {
  const canvas = createCanvas(1080, 1920);
  const ctx = canvas.getContext('2d');

  // Dark gradient background (vertical)
  const gradient = ctx.createLinearGradient(0, 0, 0, 1920);
  gradient.addColorStop(0, '#0a0a12');
  gradient.addColorStop(0.4, '#0d0d1a');
  gradient.addColorStop(0.7, '#0a0f1e');
  gradient.addColorStop(1, '#060610');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1920);

  // Subtle diagonal accent lines
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.06)';
  ctx.lineWidth = 1;
  for (let i = -1920; i < 2160; i += 80) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 1920, 1920);
    ctx.stroke();
  }

  // Top gradient overlay (for logo area)
  const topGrad = ctx.createLinearGradient(0, 0, 0, 300);
  topGrad.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
  topGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, 1080, 300);

  // Bottom gradient overlay (for subtitles area)
  const bottomGrad = ctx.createLinearGradient(0, 1520, 0, 1920);
  bottomGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  bottomGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
  ctx.fillStyle = bottomGrad;
  ctx.fillRect(0, 1520, 1080, 400);

  // Logo
  const logoPath = path.join(PROJECT_ROOT, 'public', 'logo.png');
  if (branding.logoBuffer || fs.existsSync(logoPath)) {
    try {
      const logoImg = branding.logoBuffer
        ? await loadImage(branding.logoBuffer)
        : await loadImage(logoPath);
      const logoW = 160;
      const logoH = (logoImg.height / logoImg.width) * logoW;
      const logoX = (1080 - logoW) / 2;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(logoImg, logoX, 60, logoW, logoH);
      ctx.globalAlpha = 1;
    } catch (_) {
      // Non-fatal: logo not found
    }
  }

  // Platform name (top center, below logo)
  const platformName = branding.platformName || 'PeriodistApp';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(platformName, 540, 240);

  // Thin accent line below platform name
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(340, 295);
  ctx.lineTo(740, 295);
  ctx.stroke();

  const bgPath = path.join(outputDir, `clip_bg_${uuidv4()}.png`);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(bgPath, buffer);
  return bgPath;
}

// ─── SRT Subtitle Generation ──────────────────────────────────────────────────

/**
 * Filtra utterances dentro del rango del clip y genera un archivo .srt.
 * Devuelve la ruta al archivo .srt generado.
 */
function generateSrtFile(
  utterances: Utterance[],
  startMs: number,
  endMs: number,
): string {
  const clipped = utterances.filter(u => u.end > startMs && u.start < endMs);

  const formatTime = (ms: number): string => {
    const totalMs = Math.max(0, ms - startMs);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms2 = totalMs % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms2).padStart(3, '0')}`;
  };

  let srt = '';
  clipped.forEach((u, i) => {
    const s = Math.max(startMs, u.start);
    const e = Math.min(endMs, u.end);
    srt += `${i + 1}\n`;
    srt += `${formatTime(s)} --> ${formatTime(e)}\n`;
    srt += `${u.text.trim()}\n\n`;
  });

  const srtPath = path.join(outputDir, `clip_subs_${uuidv4()}.srt`);
  fs.writeFileSync(srtPath, srt, 'utf-8');
  return srtPath;
}

// ─── Video Composition ────────────────────────────────────────────────────────

/**
 * Genera un clip vertical 1080x1920 usando ffmpeg.
 *
 * Pasos:
 *   1. Extraer segmento de audio del MP3 fuente
 *   2. Generar frame de fondo PNG con @napi-rs/canvas
 *   3. Generar subtítulos en formato SRT
 *   4. Componer video con ffmpeg (-loop 1 imagen + audio + subtítulos)
 *
 * Retorna la ruta al MP4 generado.
 */
export async function generateClipVideo(
  candidate: ClipCandidate,
  audioPath: string,
  utterances: Utterance[],
  branding: BrandingConfig,
): Promise<string> {
  const uid = uuidv4().slice(0, 8);
  const segmentPath = path.join(outputDir, `clip_audio_${uid}.mp3`);
  const bgPath = await generateBackgroundFrame(branding);
  const srtPath = generateSrtFile(utterances, candidate.startMs, candidate.endMs);
  const outputPath = path.join(outputDir, `clip_${uid}.mp4`);

  const startSec = candidate.startMs / 1000;
  const durationSec = (candidate.endMs - candidate.startMs) / 1000;

  try {
    // Step 1: Extract audio segment
    // Use -t (duration) instead of -to so it works regardless of audio format
    const audioCmd = `"${FFMPEG}" -i "${audioPath}" -ss ${startSec} -t ${durationSec} -c copy -y "${segmentPath}"`;
    await execAsync(audioCmd, { timeout: 60000 });

    // Step 2: Check the segment was actually created (some formats need re-encode)
    if (!fs.existsSync(segmentPath) || fs.statSync(segmentPath).size < 100) {
      const audioReencodeCmd = `"${FFMPEG}" -i "${audioPath}" -ss ${startSec} -t ${durationSec} -c:a libmp3lame -q:a 4 -y "${segmentPath}"`;
      await execAsync(audioReencodeCmd, { timeout: 60000 });
    }

    // Step 3: Compose video with burned-in subtitles
    // Use subtitles filter with Windows-safe path (forward slashes, escaped colons)
    const srtPathNorm = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    // FontSize=28: readable on mobile; MarginV=300: bottom area well above bottom edge
    const subtitleFilter = `subtitles='${srtPathNorm}':force_style='FontSize=28,FontName=Arial,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=1,Alignment=2,MarginV=300,MarginL=80,MarginR=80'`;

    const videoCmd = [
      `"${FFMPEG}"`,
      `-loop 1 -i "${bgPath}"`,
      `-i "${segmentPath}"`,
      `-vf "${subtitleFilter}"`,
      `-c:v libx264 -tune stillimage -preset fast -crf 23`,
      `-c:a aac -b:a 192k`,
      `-shortest`,
      `-pix_fmt yuv420p`,
      `-t ${durationSec}`,
      `-y "${outputPath}"`,
    ].join(' ');

    await execAsync(videoCmd, { timeout: 120000 });
    return outputPath;
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(bgPath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(srtPath); } catch (_) { /* ignore */ }
    try { if (fs.existsSync(segmentPath)) fs.unlinkSync(segmentPath); } catch (_) { /* ignore */ }
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
    try { fs.unlinkSync(clip.videoPath); } catch (_) { /* ignore */ }
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
