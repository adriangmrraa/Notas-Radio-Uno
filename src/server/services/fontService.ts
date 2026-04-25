import { GlobalFonts } from '@napi-rs/canvas';
import path from 'path';
import { existsSync } from 'fs';
import type { FontFamilyId } from '../../shared/types.js';

export const FONT_REGISTRY: Record<FontFamilyId, { filename: string; family: string }> = {
  bebas_kai:        { filename: 'BebasKai.ttf',              family: 'Bebas Kai' },
  oswald:           { filename: 'Oswald-Bold.ttf',           family: 'Oswald' },
  roboto_condensed: { filename: 'RobotoCondensed-Bold.ttf',  family: 'Roboto Condensed' },
  montserrat:       { filename: 'Montserrat-Bold.ttf',       family: 'Montserrat' },
  lato:             { filename: 'Lato-Bold.ttf',             family: 'Lato' },
  playfair:         { filename: 'PlayfairDisplay-Bold.ttf',  family: 'Playfair Display' },
};

const FALLBACK_FONT = '"Arial Black", "Impact", sans-serif';

export function registerAllFonts(projectRoot: string): void {
  const fontsDir = path.join(projectRoot, 'fonts');
  for (const [id, { filename, family }] of Object.entries(FONT_REGISTRY)) {
    const fp = path.join(fontsDir, filename);
    if (existsSync(fp)) {
      GlobalFonts.registerFromPath(fp, family);
      console.log(`[Fonts] Registered: ${family} (${id})`);
    } else {
      console.warn(`[Fonts] Missing: ${fp}`);
    }
  }
}

export function getFontFamily(fontId: FontFamilyId): string {
  const entry = FONT_REGISTRY[fontId];
  return entry ? `"${entry.family}"` : FALLBACK_FONT;
}
