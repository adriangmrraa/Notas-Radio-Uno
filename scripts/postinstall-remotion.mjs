/**
 * postinstall-remotion.mjs — instala las deps del proyecto remotion/ solo
 * cuando el directorio existe (Épica J / PJ-01).
 *
 * Antes: "postinstall": "cd remotion && npm install" — rompía `npm ci` en
 * cualquier entorno sin remotion/ (p. ej. la imagen Docker de producción,
 * que no copia remotion/: el render Remotion es opt-in local).
 *
 * En dev local remotion/ existe → comportamiento idéntico al de antes.
 */
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const remotionDir = path.join(root, 'remotion');

if (!existsSync(path.join(remotionDir, 'package.json'))) {
  console.log(
    '[postinstall] remotion/ no presente — se omite su install ' +
      '(render Remotion es opt-in local, ver docs/EPICA-J.md)',
  );
  process.exit(0);
}

execSync('npm install', { cwd: remotionDir, stdio: 'inherit' });
