import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import * as dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

dotenv.config();

import { initDatabase } from "./services/databaseService.js";
import { registerPipelineRoutes } from "./routes/pipeline.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerGenerateRoutes } from "./routes/generate.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerPipelineConfigRoutes } from "./routes/pipelineConfig.js";

// ---------------------------------------------------------------------------
// __dirname / __filename (ESM compat)
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve project root (two levels up from src/server/)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Transcription file setup
// ---------------------------------------------------------------------------
const OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const TRANSCRIPTION_FILE = path.join(OUTPUT_DIR, "transcripciones.json");

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Clean up .mp3 files from output on startup
try {
  const files = fs.readdirSync(OUTPUT_DIR);
  for (const file of files) {
    if (path.extname(file) === ".mp3") {
      const filePath = path.join(OUTPUT_DIR, file);
      fs.unlinkSync(filePath);
      console.log("Archivo eliminado:", filePath);
    }
  }
} catch (err) {
  console.error("Error al leer el directorio de output:", err);
}

// Reset transcription file
if (fs.existsSync(TRANSCRIPTION_FILE)) {
  fs.unlinkSync(TRANSCRIPTION_FILE);
  console.log("Archivo de transcripciones eliminado.");
}

const initialData = { transcriptions: [] as unknown[] };
fs.writeFileSync(TRANSCRIPTION_FILE, JSON.stringify(initialData, null, 4), "utf-8");
console.log("Archivo JSON de transcripciones inicializado.");

// ---------------------------------------------------------------------------
// Initialize database
// ---------------------------------------------------------------------------
initDatabase();

// ---------------------------------------------------------------------------
// Express + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const upload = multer({ dest: path.join(PROJECT_ROOT, "uploads") });
const PORT = 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.json());

// Static files: production client bundle
app.use(express.static(path.join(PROJECT_ROOT, "dist", "client")));

// Static files: public assets (logo, etc.)
app.use(express.static(path.join(PROJECT_ROOT, "public")));

// Serve /output for generated images
app.use("/output", express.static(OUTPUT_DIR));

// ---------------------------------------------------------------------------
// API route to get transcription file content
// ---------------------------------------------------------------------------
app.get("/api/get-transcriptions", (_req, res) => {
  try {
    const transcriptionData = fs.readFileSync(TRANSCRIPTION_FILE, "utf-8");
    res.json(JSON.parse(transcriptionData));
  } catch (error) {
    console.error("Error al leer el archivo de transcripciones:", error);
    res.status(500).json({ transcriptions: [] });
  }
});

// ---------------------------------------------------------------------------
// Register route modules
// ---------------------------------------------------------------------------
registerPipelineRoutes(app, io);
registerMetaRoutes(app);
registerHistoryRoutes(app, io);
registerSettingsRoutes(app);
registerGenerateRoutes(app, io, upload);
registerCaptureRoutes(app, io, {
  transcriptionFile: TRANSCRIPTION_FILE,
  projectRoot: PROJECT_ROOT,
});
registerAgentRoutes(app);
registerPipelineConfigRoutes(app);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function gracefulShutdown(): void {
  console.log("\n[Server] Cerrando servidor...");

  httpServer.close(() => {
    console.log("[Server] Servidor cerrado.");
    process.exit(0);
  });

  // Force close after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ---------------------------------------------------------------------------
// SPA catch-all for client-side routing
// ---------------------------------------------------------------------------
app.get("*", (_req, res) => {
  const indexPath = path.join(PROJECT_ROOT, "dist", "client", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    // In dev mode, Vite handles this
    res.status(404).send("Not found");
  }
});

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`[Server] Servidor corriendo en http://localhost:${PORT}`);
});

export { app, io, httpServer, TRANSCRIPTION_FILE, OUTPUT_DIR, PROJECT_ROOT };
