import { exec, spawn } from "child_process";
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
  const toolsPath = path.join(TOOLS_DIR, process.platform === "win32" ? `${name}.exe` : name);
  if (fs.existsSync(toolsPath)) return toolsPath;
  return name; // fallback to PATH
}

function findPython(): string {
  // Windows: try 'py' launcher first, then 'python'
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
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
  if (
    url.includes("youtube.com") ||
    url.includes("youtu.be") ||
    url.includes("youtube.com/live")
  ) {
    return "youtube";
  }
  if (
    url.includes("streamingraddios") ||
    url.includes("radiouno") ||
    url.endsWith("/stream")
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
      // yt-dlp extracts audio from live stream with limited duration
      // Pipe: yt-dlp -> ffmpeg to limit duration
      const ytdlpCommand = `"${YTDLP}" -f "bestaudio" --no-part -o - "${url}" | "${FFMPEG}" -i pipe:0 -t ${durationSeconds} -c:a libmp3lame -q:a 4 "${outputFile}"`;

      exec(ytdlpCommand, { timeout: (durationSeconds + 30) * 1000 }, (error) => {
        if (error && !fs.existsSync(outputFile)) {
          reject(new Error(`Error capturando audio YouTube: ${error.message}`));
          return;
        }
        resolve({ filePath: outputFile, sourceType });
      });

      return;
    }

    // For radio and generic streams, use ffmpeg directly
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
  });
}

/**
 * Transcribe un archivo de audio usando Whisper (vía Python).
 * Retorna el texto transcrito.
 */
function transcribeAudio(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const pythonScript = `
import whisper
import json
import sys

model = whisper.load_model("base")
result = model.transcribe("${filePath.replace(/\\/g, "\\\\")}", fp16=False)
print(json.dumps({"text": result["text"]}))
`;
    const tempScript = path.join(outputDir, `transcribe_${Date.now()}.py`);
    fs.writeFileSync(tempScript, pythonScript);

    exec(`${PYTHON} "${tempScript}"`, { timeout: 120000 }, (error, stdout, _stderr) => {
      // Clean up temp script
      try { fs.unlinkSync(tempScript); } catch (_) { /* ignore */ }

      if (error) {
        reject(new Error(`Error en transcripción: ${error.message}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as { text: string };
        resolve(result.text);
      } catch (_parseError) {
        reject(new Error(`Error parseando resultado de Whisper: ${stdout}`));
      }
    });
  });
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
