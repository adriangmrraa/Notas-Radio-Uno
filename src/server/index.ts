import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

dotenv.config();

import { runMigrations } from "./db/migrate.js";
import { registerPipelineRoutes } from "./routes/pipeline.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerGenerateRoutes } from "./routes/generate.js";
import { registerCaptureRoutes } from "./routes/capture.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerPipelineConfigRoutes } from "./routes/pipelineConfig.js";
import { registerBrandingRoutes } from "./routes/branding.js";
import { registerProgramRoutes } from "./routes/programs.js";
import { registerConductorRoutes } from "./routes/conductors.js";
import { registerGuestRoutes } from "./routes/guests.js";
import { registerReviewRoutes } from "./routes/review.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerClipRoutes } from "./routes/clips.js";
import { initDossierScheduler } from "./services/dossierService.js";
import { authRouter } from "./routes/auth.js";
import { billingRouter } from "./routes/billing.js";
import { connectionsRouter } from "./routes/connections.js";
import { jobsRouter } from "./routes/jobs.js";
import { imageEditRouter } from "./routes/imageEdit.js";
import { initJobScheduler } from "./services/jobSchedulerService.js";
import { initNotificationService } from "./services/notificationService.js";
import { disconnectDb } from "./db/index.js";
import { registerAllFonts } from "./services/fontService.js";

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
// Express + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || true,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Socket.IO auth middleware — join tenant room
import jwt from "jsonwebtoken";
const SOCKET_JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) {
    // Allow unauthenticated sockets for backward compatibility (dev mode)
    socket.data.tenantId = "default";
    return next();
  }
  try {
    const payload = jwt.verify(token, SOCKET_JWT_SECRET) as { tenantId: string };
    socket.data.tenantId = payload.tenantId;
    next();
  } catch {
    next(new Error("Socket auth failed"));
  }
});

io.on("connection", (socket) => {
  const tenantId = socket.data.tenantId || "default";
  socket.join(`tenant:${tenantId}`);
  console.log(`[Socket.IO] Client connected to tenant:${tenantId}`);
});

const upload = multer({ dest: path.join(PROJECT_ROOT, "uploads") });
const PORT = parseInt(process.env.PORT || "3001", 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const CORS_ORIGIN = process.env.FRONTEND_URL || true;
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Static files: production client bundle
app.use(express.static(path.join(PROJECT_ROOT, "dist", "client")));

// Static files: public assets (logo, etc.)
app.use(express.static(path.join(PROJECT_ROOT, "public")));

// Serve /output for generated images
app.use("/output", express.static(OUTPUT_DIR));

// Serve /fonts for font files
app.use("/fonts", express.static(path.join(PROJECT_ROOT, "fonts")));

// ---------------------------------------------------------------------------
// Health check endpoint
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

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
// Auth routes
// ---------------------------------------------------------------------------
app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/images", imageEditRouter);

// Initialize background services
initNotificationService(io);
initJobScheduler(io);
initDossierScheduler();

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
registerBrandingRoutes(app);
registerProgramRoutes(app);
registerConductorRoutes(app);
registerGuestRoutes(app);
registerReviewRoutes(app);
registerAlertRoutes(app);
registerClipRoutes(app);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function gracefulShutdown(): Promise<void> {
  console.log("\n[Server] Cerrando servidor...");

  await disconnectDb();

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
// Start listening (after running DB migrations)
// ---------------------------------------------------------------------------
(async () => {
  try {
    await runMigrations();
  } catch (err) {
    console.error("[Server] Error running migrations:", err);
    process.exit(1);
  }

  // Register all fonts from /fonts directory
  registerAllFonts(PROJECT_ROOT);

  // Diarization provider status
  if (process.env.ASSEMBLYAI_API_KEY) {
    console.log('[Diarization] AssemblyAI configured — speaker diarization enabled');
  } else {
    console.log('[Diarization] AssemblyAI not configured — using Whisper (no diarization)');
  }

  httpServer.listen(PORT, () => {
    console.log(`[Server] Servidor corriendo en http://localhost:${PORT}`);
  });
})();

export { app, io, httpServer, TRANSCRIPTION_FILE, OUTPUT_DIR, PROJECT_ROOT };
