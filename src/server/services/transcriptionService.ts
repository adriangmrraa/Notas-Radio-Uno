import { exec, execSync, spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { v4 as uuidv4 } from "uuid";

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
 * Captura un segmento de audio de una fuente.
 * Para YouTube usa yt-dlp + ffmpeg, para radio/generic usa ffmpeg directo.
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
      // yt-dlp needs a JS runtime for YouTube extraction.
      // Use Node.js (already installed) via --js-runtimes node
      // Download audio directly to file (no pipe) for better compatibility
      const ytdlpCommand = [
        `"${YTDLP}"`,
        `--js-runtimes`, `node`,
        `-f`, `"ba/b"`,          // best audio, fallback to best overall
        `--no-part`,
        `--download-sections`, `"*0-${durationSeconds}"`,
        `-x`,                    // extract audio
        `--audio-format`, `mp3`,
        `--audio-quality`, `4`,
        `-o`, `"${outputFile}"`,
        `"${url}"`,
      ].join(" ");

      exec(ytdlpCommand, { timeout: (durationSeconds + 60) * 1000 }, (error) => {
        if (error && !fs.existsSync(outputFile)) {
          reject(new Error(`Error capturando audio YouTube: ${error.message}`));
          return;
        }
        resolve({ filePath: outputFile, sourceType });
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

/**
 * Transcribe un archivo de audio usando OpenAI Whisper API.
 * Retorna el texto transcrito.
 */
async function transcribeAudio(filePath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY no configurada. Necesaria para transcripción.');
  }

  const FormData = (await import('form-data')).default;
  const { default: axios } = await import('axios');

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

  return response.data.text;
}

/**
 * Captura y transcribe un segmento de audio.
 * Retorna { text, filePath, sourceType, timestamp }
 */
async function captureAndTranscribe(url: string, durationSeconds: number = 120): Promise<TranscriptionResult> {
  const { filePath, sourceType } = await captureAudioSegment(url, durationSeconds);
  const text = await transcribeAudio(filePath);

  // Clean up audio file after transcription
  try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }

  return {
    text,
    filePath,
    sourceType,
    timestamp: new Date().toISOString(),
  };
}

export {
  detectSourceType,
  captureAudioSegment,
  transcribeAudio,
  captureAndTranscribe,
};

export type { SourceType, CaptureResult, TranscriptionResult };
