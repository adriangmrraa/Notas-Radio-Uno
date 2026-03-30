import type { Express, Request, Response } from "express";
import type { Server } from "socket.io";
import type { ChildProcess } from "child_process";

import { requireAuth } from "../middleware/auth.js";
import path from "path";
import fs from "fs";
import { exec } from "child_process";

import { createTranscription } from "../services/databaseService.js";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let pythonProcess: ChildProcess | null = null;
let isCapturing = false;

// ---------------------------------------------------------------------------
// Config passed from index.ts
// ---------------------------------------------------------------------------
interface CaptureConfig {
  transcriptionFile: string;
  projectRoot: string;
}

// ---------------------------------------------------------------------------
// save_transcription_to_json - persists to file + DB + emits socket events
// ---------------------------------------------------------------------------
function saveTranscriptionToJson(
  filePath: string,
  transcriptionText: string,
  transcriptionFile: string,
  io: Server,
): void {
  const timestamp = new Date().toISOString();
  const audioFilename = path.basename(filePath);

  // Ensure the transcription file exists
  if (!fs.existsSync(transcriptionFile)) {
    const initialData = { transcriptions: [] as unknown[] };
    fs.writeFileSync(
      transcriptionFile,
      JSON.stringify(initialData, null, 4),
      "utf-8",
    );
    console.log("Archivo JSON de transcripciones inicializado.");
  }

  // Read existing data
  const data = JSON.parse(
    fs.readFileSync(transcriptionFile, "utf-8"),
  ) as { transcriptions: unknown[] };

  // Add new transcription
  const newTranscription = {
    timestamp,
    audioFile: audioFilename,
    text: transcriptionText,
  };
  data.transcriptions.push(newTranscription);

  // Write updated file
  fs.writeFileSync(
    transcriptionFile,
    JSON.stringify(data, null, 4),
    "utf-8",
  );
  console.log("Transcripciones guardadas:", data);

  // Persist to database
  const dbTranscription = createTranscription({
    text: transcriptionText,
    audioFile: audioFilename,
    source: "manual",
  });

  // Emit socket events
  io.emit("receive-transcription-update", newTranscription);
  io.emit("history-new-transcription", dbTranscription);
  console.log("Emitiendo nueva transcripcion a los clientes:", newTranscription);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export function registerCaptureRoutes(
  app: Express,
  io: Server,
  config: CaptureConfig,
): void {
  const { transcriptionFile, projectRoot } = config;

  // ------------------------------------------------------------------
  // POST /api/start-capture
  // ------------------------------------------------------------------
  app.post("/api/start-capture", requireAuth, (_req: Request, res: Response) => {
    console.log("Solicitando iniciar captura de audio...");

    if (isCapturing) {
      res.status(400).json({
        success: false,
        message: "La captura ya esta en curso.",
      });
      return;
    }

    const scriptPath = path.join(projectRoot, "scripts", "audio_capture.py");

    pythonProcess = exec(
      `python "${scriptPath}"`,
      (error, stdout, _stderr) => {
        if (error) {
          console.error("Error al iniciar captura:", error.message);
          isCapturing = false;
          pythonProcess = null;
          io.emit("capture-error", {
            message: "Error en audio_capture.py: " + error.message,
          });
          return;
        }
        console.log("Captura iniciada:", stdout);
        isCapturing = false;
        pythonProcess = null;
      },
    );

    isCapturing = true;
    res.json({ success: true, message: "Captura iniciada." });
  });

  // ------------------------------------------------------------------
  // POST /api/stop-capture
  // ------------------------------------------------------------------
  app.post("/api/stop-capture", requireAuth, (_req: Request, res: Response) => {
    console.log("Deteniendo captura...");

    if (!isCapturing) {
      res.status(400).json({
        success: false,
        message: "La captura no esta en curso.",
      });
      return;
    }

    if (!pythonProcess) {
      console.log("No hay proceso de captura en ejecucion.");
      res.status(400).json({
        success: false,
        message: "No hay proceso de captura en ejecucion.",
      });
      return;
    }

    // Cross-platform process kill
    if (process.platform === "win32") {
      exec(`taskkill /pid ${pythonProcess.pid} /T /F`, () => {});
    } else {
      pythonProcess.kill("SIGTERM");
    }

    // Remove existing listeners to avoid conflicts
    pythonProcess.removeAllListeners("close");
    pythonProcess.removeAllListeners("error");

    let responseSent = false;

    pythonProcess.on("close", (code: number | null) => {
      console.log(`Proceso de captura finalizado con codigo: ${code}`);
      isCapturing = false;
      pythonProcess = null;

      if (responseSent) return;
      responseSent = true;

      if (code === 0 || code === null) {
        res.json({ success: true, message: "Captura detenida correctamente." });
      } else {
        res.status(500).json({
          success: false,
          message: "Error al detener la captura.",
        });
      }
    });

    pythonProcess.on("error", (err: Error) => {
      console.error("Error en el proceso hijo:", err);
      isCapturing = false;
      pythonProcess = null;

      if (responseSent) return;
      responseSent = true;

      res.status(500).json({
        success: false,
        message: "Error al detener la captura.",
      });
    });
  });

  // Expose saveTranscriptionToJson for pipeline or other modules
  app.set("saveTranscription", (filePath: string, text: string) => {
    saveTranscriptionToJson(filePath, text, transcriptionFile, io);
  });

  // Expose state for graceful shutdown
  app.set("captureProcess", () => pythonProcess);
}

export { saveTranscriptionToJson };
