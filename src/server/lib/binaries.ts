/**
 * binaries — resolución compartida de binarios externos (ffmpeg, yt-dlp,
 * ffprobe, whisper…).
 *
 * Extraído del patrón que ya usaban `transcriptionService.ts`,
 * `clipService.ts` y `liveDetectorService.ts` (copias locales de `findBinary`
 * en cada servicio). Los servicios nuevos (ingesta de video, PD-02+) importan
 * de acá; los servicios existentes conservan su copia para no tocarlos en un
 * slice ajeno.
 *
 * Orden de búsqueda:
 *   1. `<repo>/<name>`         — Render instala binarios en la raíz en build.
 *   2. `$TOOLS_DIR/<name>`     — default `~/tools` (`%USERPROFILE%\tools` en Windows).
 *   3. `<name>`                — fallback a PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const TOOLS_DIR =
  process.env.TOOLS_DIR ||
  path.join(process.env.HOME || process.env.USERPROFILE || '', 'tools');

export function findBinary(name: string): string {
  const projectPath = path.join(PROJECT_ROOT, name);
  if (fs.existsSync(projectPath)) return projectPath;
  const toolsPath = path.join(
    TOOLS_DIR,
    process.platform === 'win32' ? `${name}.exe` : name,
  );
  if (fs.existsSync(toolsPath)) return toolsPath;
  return name; // fallback a PATH
}
