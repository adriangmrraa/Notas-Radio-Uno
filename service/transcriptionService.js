import { exec, spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputDir = path.join(__dirname, "..", "output");

/**
 * Detecta el tipo de fuente de streaming.
 * Retorna: "youtube", "radio", o "generic"
 */
function detectSourceType(url) {
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
function captureAudioSegment(url, durationSeconds = 120) {
  return new Promise((resolve, reject) => {
    const sourceType = detectSourceType(url);
    const outputFile = path.join(
      outputDir,
      `audio_${Date.now()}_${uuidv4().slice(0, 8)}.mp3`,
    );

    let command;
    let args;

    if (sourceType === "youtube") {
      // yt-dlp extrae el audio del live stream con duración limitada
      // Usamos un pipe: yt-dlp -> ffmpeg para limitar duración
      const ytdlpCommand = `yt-dlp -f "bestaudio" --no-part -o - "${url}" | ffmpeg -i pipe:0 -t ${durationSeconds} -c:a libmp3lame -q:a 4 "${outputFile}"`;

      const process = exec(ytdlpCommand, { timeout: (durationSeconds + 30) * 1000 }, (error) => {
        if (error && !fs.existsSync(outputFile)) {
          reject(new Error(`Error capturando audio YouTube: ${error.message}`));
          return;
        }
        resolve({ filePath: outputFile, sourceType });
      });

      return;
    }

    // Para radio y streams genéricos, usar ffmpeg directo
    args = [
      "-i", url,
      "-t", String(durationSeconds),
      "-c:a", "libmp3lame",
      "-q:a", "4",
      "-y",
      outputFile,
    ];

    const ffmpegProcess = spawn("ffmpeg", args);

    let stderr = "";
    ffmpegProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpegProcess.on("close", (code) => {
      if (code !== 0 && !fs.existsSync(outputFile)) {
        reject(new Error(`FFmpeg terminó con código ${code}: ${stderr.slice(-200)}`));
        return;
      }
      resolve({ filePath: outputFile, sourceType });
    });

    ffmpegProcess.on("error", (err) => {
      reject(new Error(`Error ejecutando FFmpeg: ${err.message}`));
    });
  });
}

/**
 * Transcribe un archivo de audio usando Whisper (vía Python).
 * Retorna el texto transcrito.
 */
function transcribeAudio(filePath) {
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

    exec(`python "${tempScript}"`, { timeout: 120000 }, (error, stdout, stderr) => {
      // Limpiar script temporal
      try { fs.unlinkSync(tempScript); } catch (_) {}

      if (error) {
        reject(new Error(`Error en transcripción: ${error.message}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result.text);
      } catch (parseError) {
        reject(new Error(`Error parseando resultado de Whisper: ${stdout}`));
      }
    });
  });
}

/**
 * Captura y transcribe un segmento de audio.
 * Retorna { text, filePath, sourceType, timestamp }
 */
async function captureAndTranscribe(url, durationSeconds = 120) {
  const { filePath, sourceType } = await captureAudioSegment(url, durationSeconds);
  const text = await transcribeAudio(filePath);

  // Limpiar archivo de audio después de transcribir
  try { fs.unlinkSync(filePath); } catch (_) {}

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
