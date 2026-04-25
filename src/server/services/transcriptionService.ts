import { exec, execSync, spawn } from "child_process";
import path from "path";
import fs from "fs";
import fsAsync from "fs/promises";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import type { DiarizedTranscription, Utterance } from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve output dir relative to project root (works with both tsx and compiled)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..");
const outputDir = path.join(PROJECT_ROOT, "output");

// Ensure output dir exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Resolve binary paths: check tools dir, then PATH
const TOOLS_DIR = process.env.TOOLS_DIR || path.join(process.env.HOME || process.env.USERPROFILE || "", "tools");

function findBinary(name: string): string {
  // Check project root first (Render installs binaries here during build)
  const projectRoot = path.resolve(__dirname, "..", "..", "..");
  const projectPath = path.join(projectRoot, name);
  if (fs.existsSync(projectPath)) return projectPath;
  // Check tools dir
  const toolsPath = path.join(TOOLS_DIR, process.platform === "win32" ? `${name}.exe` : name);
  if (fs.existsSync(toolsPath)) return toolsPath;
  return name; // fallback to PATH
}

function findPython(): string {
  // Windows: try 'py' launcher first, then 'python'
  if (process.platform === "win32") {
    try {
      execSync("py --version", { stdio: "ignore" });
      return "py";
    } catch (_) { /* py not found */ }
  }
  return "python";
}

const FFMPEG = findBinary("ffmpeg");
const YTDLP = findBinary("yt-dlp");
const PYTHON = findPython();

type SourceType = "youtube" | "radio" | "generic";

interface CaptureResult {
  filePath: string;
  sourceType: SourceType;
}

interface TranscriptionResult {
  text: string;
  filePath: string;
  sourceType: SourceType;
  timestamp: string;
}

/**
 * Detecta el tipo de fuente de streaming.
 * Retorna: "youtube", "radio", o "generic"
 */
function detectSourceType(url: string): SourceType {
  // Plataformas que necesitan yt-dlp para extraer el stream
  if (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    url.includes("twitch.tv") ||
    url.includes("kick.com") ||
    url.includes("facebook.com/live") ||
    url.includes("dailymotion.com") ||
    url.includes("vimeo.com")
  ) {
    return "youtube"; // "youtube" = usa yt-dlp (soporta todas estas plataformas)
  }
  // Streams directos de radio/audio (URLs que ffmpeg puede abrir directo)
  if (
    url.includes("streamingraddios") ||
    url.endsWith("/stream") ||
    url.endsWith(".m3u8") ||
    url.endsWith(".mp3") ||
    url.endsWith(".aac") ||
    url.includes("/radio") ||
    url.includes("shoutcast") ||
    url.includes("icecast")
  ) {
    return "radio";
  }
  return "generic";
}

/**
 * Extrae el video ID de una URL de YouTube.
 */
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Obtiene la URL directa de audio de YouTube via Piped/Invidious APIs.
 * Estas APIs actúan como proxy y no tienen el problema de IP de datacenter.
 */
async function getYouTubeAudioUrl(videoId: string): Promise<string> {
  // Public API instances (tested and working as of Apr 2026)
  // These act as proxies — they fetch from YouTube with their own IPs
  const pipedInstances = [
    "https://api.piped.private.coffee",
    "https://pipedapi.kavin.rocks",
  ];

  // Invidious instances (most are down in 2026, kept as fallback)
  const invidiousInstances: string[] = [];

  // Try Piped first (returns audioStreams directly)
  for (const instance of pipedInstances) {
    try {
      console.log(`[Transcription] Intentando Piped: ${instance}...`);
      const res = await axios.get(`${instance}/streams/${videoId}`, { timeout: 10000 });
      const audioStreams = res.data?.audioStreams;
      if (audioStreams?.length > 0) {
        // Pick best quality audio stream
        const best = audioStreams.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
        if (best?.url) {
          console.log(`[Transcription] Piped OK — bitrate: ${best.bitrate}, codec: ${best.codec}`);
          return best.url;
        }
      }
    } catch (err: any) {
      console.log(`[Transcription] Piped ${instance} falló: ${err.message}`);
    }
  }

  // Try Invidious (returns adaptiveFormats)
  for (const instance of invidiousInstances) {
    try {
      console.log(`[Transcription] Intentando Invidious: ${instance}...`);
      const res = await axios.get(`${instance}/api/v1/videos/${videoId}`, { timeout: 10000 });
      const formats = res.data?.adaptiveFormats;
      if (formats?.length > 0) {
        const audioFormats = formats.filter((f: any) => f.type?.startsWith("audio/"));
        if (audioFormats.length > 0) {
          const best = audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
          if (best?.url) {
            console.log(`[Transcription] Invidious OK — bitrate: ${best.bitrate}`);
            return best.url;
          }
        }
      }
    } catch (err: any) {
      console.log(`[Transcription] Invidious ${instance} falló: ${err.message}`);
    }
  }

  throw new Error("Ninguna instancia de Piped/Invidious pudo obtener el audio");
}

/**
 * Captura un segmento de audio de una fuente.
 * Para YouTube usa Piped/Invidious API + ffmpeg, para radio/generic usa ffmpeg directo.
 * Retorna la ruta del archivo de audio capturado.
 */
function captureAudioSegment(url: string, durationSeconds: number = 120): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const sourceType = detectSourceType(url);
    const outputFile = path.join(
      outputDir,
      `audio_${Date.now()}_${uuidv4().slice(0, 8)}.mp3`,
    );

    if (sourceType === "youtube") {
      // Extract video ID from URL
      const videoId = extractYouTubeId(url);
      if (!videoId) {
        reject(new Error(`No se pudo extraer el video ID de: ${url}`));
        return;
      }

      // Strategy chain: Piped API → Invidious API → yt-dlp → ffmpeg direct
      getYouTubeAudioUrl(videoId)
        .then((audioUrl) => {
          console.log(`[Transcription] URL de audio obtenida via API proxy, capturando con ffmpeg...`);
          captureWithFfmpeg(audioUrl, durationSeconds, outputFile, sourceType, resolve, reject);
        })
        .catch((apiError) => {
          console.log(`[Transcription] APIs proxy fallaron: ${apiError.message}. Intentando yt-dlp...`);
          // Fallback to yt-dlp (works on VPS/local, fails on datacenter)
          const ytdlpCmd = [
            `"${YTDLP}"`, `--js-runtimes`, `node`,
            `--extractor-args`, `"youtube:player_client=ios,mweb"`,
            `-f`, `"ba/b"`, `--no-part`,
            `--download-sections`, `"*0-${durationSeconds}"`,
            `-x`, `--audio-format`, `mp3`, `--audio-quality`, `4`,
            `-o`, `"${outputFile}"`, `"${url}"`,
          ].join(" ");

          exec(ytdlpCmd, { timeout: (durationSeconds + 60) * 1000 }, (error) => {
            if (!error || fs.existsSync(outputFile)) {
              resolve({ filePath: outputFile, sourceType });
              return;
            }
            reject(new Error(`Todas las estrategias de captura fallaron para: ${url}`));
          });
        });

      return;
    }

    if (sourceType === "generic") {
      // Generic URLs: try yt-dlp first (handles many platforms), fallback to ffmpeg
      const ytdlpGeneric = [
        `"${YTDLP}"`,
        `--js-runtimes`, `node`,
        `-f`, `"ba/b"`,
        `--no-part`,
        `--download-sections`, `"*0-${durationSeconds}"`,
        `-x`,
        `--audio-format`, `mp3`,
        `--audio-quality`, `4`,
        `-o`, `"${outputFile}"`,
        `"${url}"`,
      ].join(" ");

      exec(ytdlpGeneric, { timeout: (durationSeconds + 60) * 1000 }, (ytError) => {
        if (!ytError || fs.existsSync(outputFile)) {
          resolve({ filePath: outputFile, sourceType });
          return;
        }
        // yt-dlp failed, try ffmpeg direct
        console.log(`[Transcription] yt-dlp falló para URL genérica, intentando ffmpeg directo...`);
        captureWithFfmpeg(url, durationSeconds, outputFile, sourceType, resolve, reject);
      });
      return;
    }

    // Radio streams: ffmpeg direct
    captureWithFfmpeg(url, durationSeconds, outputFile, sourceType, resolve, reject);
  });
}

function captureWithFfmpeg(
  url: string, durationSeconds: number, outputFile: string,
  sourceType: SourceType,
  resolve: (value: CaptureResult) => void,
  reject: (reason: Error) => void,
): void {
    const args = [
      "-i", url,
      "-t", String(durationSeconds),
      "-c:a", "libmp3lame",
      "-q:a", "4",
      "-y",
      outputFile,
    ];

    const ffmpegProcess = spawn(FFMPEG, args);

    let stderr = "";
    ffmpegProcess.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", (code: number | null) => {
      if (code !== 0 && !fs.existsSync(outputFile)) {
        reject(new Error(`FFmpeg terminó con código ${code}: ${stderr.slice(-200)}`));
        return;
      }
      resolve({ filePath: outputFile, sourceType });
    });

    ffmpegProcess.on("error", (err: Error) => {
      reject(new Error(`Error ejecutando FFmpeg: ${err.message}`));
    });
}

function formatDiarizedText(utterances: Utterance[]): string {
  if (!utterances.length) return '';

  const merged: { speaker: string; text: string }[] = [];
  for (const u of utterances) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === u.speaker) {
      last.text += ' ' + u.text;
    } else {
      merged.push({ speaker: u.speaker, text: u.text });
    }
  }

  return merged.map(m => `[${m.speaker}]: ${m.text}`).join('\n');
}

async function transcribeWithAssemblyAI(filePath: string): Promise<DiarizedTranscription> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) throw new Error('ASSEMBLYAI_API_KEY not configured');

  const baseUrl = 'https://api.assemblyai.com/v2';
  const headers = { authorization: apiKey };

  // 1. Upload the audio file
  const audioData = await fsAsync.readFile(filePath);
  const uploadRes = await axios.post(`${baseUrl}/upload`, audioData, {
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const uploadUrl = uploadRes.data.upload_url;

  // 2. Create transcript with diarization
  const transcriptRes = await axios.post(`${baseUrl}/transcript`, {
    audio_url: uploadUrl,
    speaker_labels: true,
    language_code: 'es',
  }, { headers });
  const transcriptId = transcriptRes.data.id;

  // 3. Poll until complete (max 120s)
  let result: any;
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await axios.get(`${baseUrl}/transcript/${transcriptId}`, { headers });
    result = pollRes.data;
    if (result.status === 'completed') break;
    if (result.status === 'error') throw new Error(`AssemblyAI error: ${result.error}`);
  }

  if (!result || result.status !== 'completed') {
    throw new Error('AssemblyAI transcription timed out');
  }

  // 4. Parse utterances
  const utterances: Utterance[] = (result.utterances || []).map((u: any) => ({
    speaker: u.speaker,
    text: u.text,
    start: u.start,
    end: u.end,
  }));

  // 5. Format diarized text (merge consecutive same-speaker)
  const diarizedText = formatDiarizedText(utterances);
  const speakerCount = new Set(utterances.map(u => u.speaker)).size;

  return {
    text: result.text || '',
    diarizedText,
    speakerCount,
    utterances,
    provider: 'assemblyai',
  };
}

/**
 * Transcribe un archivo de audio.
 * Provider dispatch: AssemblyAI (diarization, si ASSEMBLYAI_API_KEY configurada) → Whisper (fallback).
 * Retorna DiarizedTranscription con texto, diarización y metadatos del proveedor.
 */
async function transcribeAudio(filePath: string): Promise<DiarizedTranscription> {
  // Provider dispatch: AssemblyAI (if configured) → Whisper (fallback)
  if (process.env.ASSEMBLYAI_API_KEY) {
    try {
      console.log('[Transcription] Using AssemblyAI (diarization enabled)');
      return await transcribeWithAssemblyAI(filePath);
    } catch (err) {
      console.warn('[Transcription] AssemblyAI failed, falling back to Whisper:', err instanceof Error ? err.message : err);
    }
  }

  console.log('[Transcription] Using Whisper');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada. Necesaria para transcripción.');
  }

  const FormData = (await import('form-data')).default;

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  form.append('response_format', 'json');

  const response = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    },
  );

  const text: string = response.data.text;
  return {
    text,
    diarizedText: '', // No diarization with Whisper
    speakerCount: 0,
    utterances: [],
    provider: 'whisper',
  };
}

/**
 * Captura y transcribe un segmento de audio.
 * Retorna { text, filePath, sourceType, timestamp }
 */
async function captureAndTranscribe(url: string, durationSeconds: number = 120): Promise<TranscriptionResult> {
  const { filePath, sourceType } = await captureAudioSegment(url, durationSeconds);
  const diarized = await transcribeAudio(filePath);

  // Clean up audio file after transcription
  try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }

  return {
    text: diarized.text,
    filePath,
    sourceType,
    timestamp: new Date().toISOString(),
  };
}

export {
  detectSourceType,
  captureAudioSegment,
  transcribeAudio,
  transcribeWithAssemblyAI,
  formatDiarizedText,
  captureAndTranscribe,
};

export type { SourceType, CaptureResult, TranscriptionResult };
