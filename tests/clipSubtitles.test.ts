/**
 * Tests del slice PF-03: `clipSubtitleService.ts` (subtítulos quemados +
 * branding: logo, lower-third, barra de progreso) sobre
 * `memorySubtitleStore` + wiring del `clipRenderWorker` para
 * `kind: 'subtitles'`.
 *
 * Deterministas: sin DB real (store en memoria con los MISMOS filtros por
 * tenant que el drizzle), sin ffmpeg (el `ffmpegRunner` stub captura args y
 * "produce" el output), sin ffprobe (probe inyectado) y sin query de
 * branding (`loadBranding` inyectado con la config del tenant).
 *
 * Casos obligatorios del brief:
 *   - `buildAssFile`: shift relativo a window, clamp de bordes, escape de
 *     `{`,`}`,`\`, wrap ~42 chars con `\N`, estilo por templateId,
 *     lower-third por speaker con personName (y sin person → speakerLabel).
 *   - `resolveSubtitleStyle`: fontFamily → family del FONT_REGISTRY,
 *     paleta por template (caja en dark_gradient/solid_bar, outline en el
 *     resto).
 *   - `buildProgressFilter`: expresión `t/dur*iw`, color accent.
 *   - ffmpeg args: subtitles filter con path escapado (`C\:/…`),
 *     overlay del logo SOLO si hay logoBuffer, `-c:a copy`.
 *   - burnSubtitles completo: 'generating'→'pending_review',
 *     metadata.subtitles; ffmpeg fail → 'error'; temps limpios.
 *   - missing videoPath / missing window → errores tipados sin tocar ffmpeg.
 *   - sin utterances → render igual (cues=0), NO error.
 *   - tenant isolation.
 *   - worker dispatch kind 'subtitles'.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock parcial del módulo DB (importarlo crea un Pool Neon y pediría
// DATABASE_URL): se preserva el resto de exports y se reemplaza `db`.
vi.mock('../src/server/db/index.js', async (io) => ({
  ...(await io()),
  db: {},
}));

import {
  ClipSubtitlesError,
  buildAssFile,
  buildBurnArgs,
  buildProgressFilter,
  createClipSubtitleService,
  escapeAssText,
  escapeFilterPath,
  lowerThirdEvents,
  msToAssTime,
  resolveSubtitleStyle,
  toRelativeUtterances,
  wrapCueText,
  type BrandingConfig,
  type SubtitleUtterance,
  type SubtitleStyle,
} from '../src/server/services/clipSubtitleService';
import { createClipRenderWorker } from '../src/server/services/clipRenderWorker';
import { FONT_REGISTRY } from '../src/server/services/fontService';
import {
  createMemorySubtitleStore,
  type MemorySubtitleClip,
  type MemoryUtteranceRow,
} from './helpers/memorySubtitleStore';
import { createMemoryRenderJobsStore } from './helpers/memoryRenderJobsStore';

const TENANT_A = '00000000-0000-4000-8000-00000000000a';
const TENANT_B = '00000000-0000-4000-8000-00000000000b';
const CLIP_A = '33333333-3333-4333-8333-333333333333';
const TX_A = '44444444-4444-4444-8444-444444444444';
const PERSON_ANA = '55555555-5555-4555-8555-555555555555';
const T0 = new Date('2026-11-09T12:00:00.000Z');

/** Dims verticales 9:16 (post-reframe): el caso típico del slice. */
const VW = 1080;
const VH = 1920;
// Valores derivados de las constantes del servicio (1080×1920):
// fontSize = round(1080*0.06) = 65; marginV = round(1920*0.05) = 96;
// marginL = round(1080*0.05) = 54; lowerThirdY = round(1920*0.7) = 1344;
// lowerThirdFontSize = round(65*0.78) = 51; logoW = round(1080*0.13) = 140;
// logoMargin = round(1080*0.03) = 32; barH = max(5, round(1920*0.007)) = 13.
const FONT_SIZE = 65;
const MARGIN_V = 96;
const MARGIN_L = 54;
const LT_Y = 1344;
const LT_FONT = 51;
const LOGO_W = 140;
const LOGO_M = 32;
const BAR_H = 13;

let workDir: string;
let tempDir: string;
let outputDir: string;
let fontsDir: string;
let sourcePath: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pf03-test-'));
  tempDir = path.join(workDir, 'tmp');
  outputDir = path.join(workDir, 'output');
  fontsDir = path.join(workDir, 'fonts');
  sourcePath = path.join(workDir, 'src', 'clip.mp4');
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(fontsDir, { recursive: true });
  await fs.writeFile(sourcePath, Buffer.from('FAKE-SOURCE-MP4'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});

// ─── Fakes ──────────────────────────────────────────────────────────────────

/**
 * ffmpegRunner stub: registra args y escribe el output (último arg tras
 * `-y`). `failOnCalls` (1-based) tira en la llamada N.
 */
function makeFakeFfmpeg(opts: { failOnCalls?: number[] } = {}) {
  const calls: string[][] = [];
  const failOn = new Set(opts.failOnCalls ?? []);
  const run = async (args: string[]) => {
    calls.push([...args]);
    if (failOn.has(calls.length)) {
      throw new Error('boom: simulated ffmpeg exit 1');
    }
    const outputPath = args[args.length - 1];
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, Buffer.from('FAKE-MP4-SUB'));
  };
  return { run, calls };
}

function argAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function makeBranding(overrides: Partial<BrandingConfig> = {}): BrandingConfig {
  return {
    logoBuffer: Buffer.from('FAKE-PNG-LOGO'),
    platformName: 'Canal Test',
    fontFamily: 'oswald',
    templateId: 'solid_bar',
    ...overrides,
  };
}

/** Clip de TENANT_A post-reframe + seeds de utterances/persons. */
function seedFull(input: {
  clip?: Partial<Omit<MemorySubtitleClip, 'patches'>>;
  utterances?: MemoryUtteranceRow[];
  persons?: Array<{ id: string; tenantId: string; name: string }>;
}) {
  return createMemorySubtitleStore({
    clips: [
      {
        id: CLIP_A,
        tenantId: TENANT_A,
        transmissionId: TX_A,
        videoPath: sourcePath,
        duration: 18,
        status: 'pending_review',
        metadata: {
          transmissionId: TX_A,
          window: { startMs: 10_000, endMs: 28_000 },
          reframe: { layout: 'single' },
        },
        ...(input.clip ?? {}),
      },
    ],
    utterances: input.utterances ?? [],
    persons: input.persons ?? [],
  });
}

function utt(
  startMs: number,
  endMs: number,
  text: string,
  extra: Partial<MemoryUtteranceRow> = {},
): MemoryUtteranceRow {
  return {
    tenantId: TENANT_A,
    transmissionId: TX_A,
    startMs,
    endMs,
    speakerLabel: 'Speaker A',
    personId: null,
    text,
    ...extra,
  };
}

function makeService(
  store: ReturnType<typeof createMemorySubtitleStore>['store'],
  opts: {
    ffmpeg?: ReturnType<typeof makeFakeFfmpeg>;
    probe?: (filePath: string) => Promise<{ width: number; height: number; durationMs: number | null }>;
    branding?: BrandingConfig;
  } = {},
) {
  const ffmpeg = opts.ffmpeg ?? makeFakeFfmpeg();
  const service = createClipSubtitleService(store, {
    ffmpegRunner: ffmpeg.run,
    probe: opts.probe ?? (async () => ({ width: VW, height: VH, durationMs: 18_000 })),
    loadBranding: async () => opts.branding ?? makeBranding(),
    tempDir,
    outputDir,
    fontsDir,
    newId: () => 'fixeduid',
    now: () => T0,
  });
  return { service, ffmpeg };
}

function styleFor(overrides: Partial<SubtitleStyle> = {}): SubtitleStyle {
  return {
    ...resolveSubtitleStyle(
      { fontFamily: 'oswald', templateId: 'solid_bar' },
      { width: VW, height: VH },
    ),
    ...overrides,
  };
}

// ─── helpers puros de tiempo/texto ──────────────────────────────────────────

describe('msToAssTime / escapeAssText / wrapCueText', () => {
  it('ms → h:mm:ss.cc con centésimas (floor, nunca 100)', () => {
    expect(msToAssTime(0)).toBe('0:00:00.00');
    expect(msToAssTime(1_234)).toBe('0:00:01.23');
    expect(msToAssTime(1_299)).toBe('0:00:01.29'); // 9ms truncados, no redondeo
    expect(msToAssTime(3_661_500)).toBe('1:01:01.50');
  });

  it('escape: backslash primero, llaves después (override blocks)', () => {
    expect(escapeAssText('hola {an8} mundo')).toBe('hola \\{an8\\} mundo');
    expect(escapeAssText('barra \\ invertida')).toBe('barra \\\\ invertida');
    // Un \{ ya presente: el \ se duplica y la llave se escapa aparte.
    expect(escapeAssText('ya \\{ escapado')).toBe('ya \\\\\\{ escapado');
  });

  it('wrap a ~42 chars por línea con \\N, sin cortar palabras', () => {
    const text =
      'esta es una frase bastante larga que tiene que cortarse en varias lineas';
    const wrapped = wrapCueText(text, 42);
    const lines = wrapped.split('\\N');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(42);
    expect(lines.join(' ')).toBe(text);
  });

  it('palabra más larga que maxChars queda entera en su línea', () => {
    const wrapped = wrapCueText('supercalifragilisticoespialidoso fin', 10);
    expect(wrapped).toBe('supercalifragilisticoespialidoso\\Nfin');
  });
});

// ─── cues relativos + lower-thirds (puros) ──────────────────────────────────

describe('toRelativeUtterances / lowerThirdEvents', () => {
  const W_START = 10_000;
  const DUR = 18_000; // window 10s→28s

  it('shift relativo a window + clamp a [0, duration]', () => {
    const rel = toRelativeUtterances(
      [
        { startMs: 9_500, endMs: 11_000, speakerLabel: null, personId: null, text: 'a' }, // pisa borde izq
        { startMs: 27_000, endMs: 29_000, speakerLabel: null, personId: null, text: 'b' }, // pisa borde der
      ],
      W_START,
      DUR,
    );
    expect(rel).toEqual([
      expect.objectContaining({ relStartMs: 0, relEndMs: 1_000 }),
      expect.objectContaining({ relStartMs: 17_000, relEndMs: 18_000 }),
    ]);
  });

  it('descarta utterances totalmente fuera de la ventana', () => {
    const rel = toRelativeUtterances(
      [
        { startMs: 8_000, endMs: 9_000, speakerLabel: null, personId: null, text: 'antes' },
        { startMs: 30_000, endMs: 31_000, speakerLabel: null, personId: null, text: 'después' },
      ],
      W_START,
      DUR,
    );
    expect(rel).toEqual([]);
  });

  it('lower-third por cambio de speaker: personName resuelto, ~3.5s de turno', () => {
    const rel = toRelativeUtterances(
      [
        utt(11_000, 13_000, 'hola', { personId: PERSON_ANA }),
        utt(12_500, 15_000, 'sigo', { personId: PERSON_ANA }), // mismo turno → rel [1,5]
        utt(15_000, 17_000, 'otro', { speakerLabel: 'Speaker B' }), // rel [5,7]
        utt(17_000, 18_000, 'vuelvo', { personId: PERSON_ANA, speakerLabel: 'Speaker A' }), // rel [7,8]
      ],
      W_START,
      DUR,
    );
    const names = new Map([[PERSON_ANA, 'Ana Gomez']]);
    const events = lowerThirdEvents(rel, names, DUR);
    expect(events).toEqual([
      // Turno Ana [1s,5s]: 4s ≥ 3.5s → los 3.5s completos de visibilidad.
      { relStartMs: 1_000, relEndMs: 4_500, label: 'ANA GOMEZ' },
      // Turno B [5s,7s]: 2s < 3.5s → clamp al fin del turno.
      { relStartMs: 5_000, relEndMs: 7_000, label: 'SPEAKER B' },
      // Turno final de Ana [7s,8s]: 1s → clamp al fin del turno.
      { relStartMs: 7_000, relEndMs: 8_000, label: 'ANA GOMEZ' },
    ]);
  });

  it('personId sin nombre resuelto → fallback a speakerLabel', () => {
    const rel = toRelativeUtterances(
      [utt(11_000, 12_000, 'hola', { personId: 'p-borrada', speakerLabel: 'Speaker C' })],
      W_START,
      DUR,
    );
    const events = lowerThirdEvents(rel, new Map(), DUR);
    expect(events).toEqual([
      { relStartMs: 1_000, relEndMs: 2_000, label: 'SPEAKER C' },
    ]);
  });

  it('utterance sin person ni label → sin lower-third', () => {
    const rel = toRelativeUtterances(
      [utt(11_000, 12_000, 'hola', { speakerLabel: null, personId: null })],
      W_START,
      DUR,
    );
    expect(lowerThirdEvents(rel, new Map(), DUR)).toEqual([]);
  });
});

// ─── resolveSubtitleStyle (pura) ────────────────────────────────────────────

describe('resolveSubtitleStyle', () => {
  it('fontFamily → family real del FONT_REGISTRY', () => {
    for (const [id, { family }] of Object.entries(FONT_REGISTRY)) {
      const style = resolveSubtitleStyle(
        { fontFamily: id as keyof typeof FONT_REGISTRY, templateId: 'minimal' },
        { width: VW, height: VH },
      );
      expect(style.fontName).toBe(family);
    }
  });

  it('dark_gradient → caja BorderStyle=3 con alpha del template (0x4C ≈ 1−0.7)', () => {
    const s = resolveSubtitleStyle(
      { fontFamily: 'bebas_kai', templateId: 'dark_gradient' },
      { width: VW, height: VH },
    );
    expect(s.borderStyle).toBe(3);
    expect(s.boxAlpha).toBe(0x4c);
    expect(s.primary).toBe('&H00FFFFFF'); // texto blanco del template
  });

  it('solid_bar → caja más densa (alpha 0x26 ≈ 1−0.85)', () => {
    const s = resolveSubtitleStyle(
      { fontFamily: 'oswald', templateId: 'solid_bar' },
      { width: VW, height: VH },
    );
    expect(s.borderStyle).toBe(3);
    expect(s.boxAlpha).toBe(0x26);
  });

  it('minimal/split/vignette → sin caja (BorderStyle=1), sombra varía', () => {
    const dims = { width: VW, height: VH };
    expect(
      resolveSubtitleStyle({ fontFamily: 'lato', templateId: 'minimal' }, dims)
        .borderStyle,
    ).toBe(1);
    expect(
      resolveSubtitleStyle({ fontFamily: 'lato', templateId: 'split' }, dims)
        .borderStyle,
    ).toBe(1);
    // vignette: sombra 0.9 blur del template → Shadow mayor.
    expect(
      resolveSubtitleStyle({ fontFamily: 'lato', templateId: 'vignette' }, dims)
        .shadow,
    ).toBe(3);
  });

  it('acento = blanco en todos los templates (barra/lower-third)', () => {
    for (const templateId of [
      'dark_gradient',
      'solid_bar',
      'minimal',
      'split',
      'vignette',
    ] as const) {
      const s = resolveSubtitleStyle(
        { fontFamily: 'montserrat', templateId },
        { width: VW, height: VH },
      );
      expect(s.accentAss).toBe('&H00FFFFFF');
      expect(s.accentDrawbox).toBe('white');
    }
  });
});

// ─── buildAssFile (pura, el corazón) ───────────────────────────────────────

describe('buildAssFile', () => {
  const style = styleFor();

  it('header ASS + estilo Default (Alignment=2) con fuente/paleta del tenant', () => {
    const { content } = buildAssFile({
      utterances: [],
      windowStartMs: 10_000,
      durationMs: 18_000,
      style,
      personNames: new Map(),
      playResX: VW,
      playResY: VH,
    });
    expect(content).toContain('[Script Info]');
    expect(content).toContain('ScriptType: v4.00+');
    expect(content).toContain(`PlayResX: ${VW}`);
    expect(content).toContain(`PlayResY: ${VH}`);
    // solid_bar → BorderStyle=3 + BackColour &H26 (alpha de la barra 0.85).
    expect(content).toContain(
      `Style: Default,Oswald,${FONT_SIZE},&H00FFFFFF,&H000000FF,&H00000000,&H26000000,-1,0,0,0,100,100,0,0,3,1.5,0.5,2,${MARGIN_L},${MARGIN_L},${MARGIN_V},1`,
    );
    expect(content).toContain('Style: LowerThird,');
  });

  it('cues Dialogue con tiempos RELATIVOS a window (h:mm:ss.cc)', () => {
    const utterances: SubtitleUtterance[] = [
      utt(11_000, 13_000, 'primero'),
      utt(14_500, 16_250, 'segundo'),
    ];
    const { content, cues } = buildAssFile({
      utterances,
      windowStartMs: 10_000,
      durationMs: 18_000,
      style,
      personNames: new Map(),
    });
    expect(cues).toBe(2);
    expect(content).toContain(
      'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,primero',
    );
    expect(content).toContain(
      'Dialogue: 0,0:00:04.50,0:00:06.25,Default,,0,0,0,,segundo',
    );
  });

  it('cue fuera de ventana no aparece; cue parcial queda clampeado', () => {
    const { content, cues } = buildAssFile({
      utterances: [
        utt(5_000, 9_000, 'antes'),
        utt(9_000, 11_000, 'parcial'), // 9s→10s fuera; queda 0→1s
        utt(30_000, 31_000, 'después'),
      ],
      windowStartMs: 10_000,
      durationMs: 18_000,
      style,
      personNames: new Map(),
    });
    expect(cues).toBe(1);
    expect(content).not.toContain('antes');
    expect(content).not.toContain('después');
    expect(content).toContain('0:00:00.00,0:00:01.00');
  });

  it('texto con llaves/backslash escapado y wrap \\N dentro del Dialogue', () => {
    const { content } = buildAssFile({
      utterances: [
        utt(
          11_000,
          13_000,
          'el {diputado} dijo \\ algo muy largo para que esto se parta en dos lineas',
        ),
      ],
      windowStartMs: 10_000,
      durationMs: 18_000,
      style,
      personNames: new Map(),
    });
    const dialogue = content
      .split(/\r?\n/)
      .find((l) => l.startsWith('Dialogue: 0,0:00:01.00'))!;
    expect(dialogue).toContain('\\{diputado\\}');
    expect(dialogue).toContain('\\\\'); // backslash duplicado
    expect(dialogue).toContain('\\N'); // wrap manual
    expect(dialogue).not.toContain('}{');
  });

  it('lower-third Dialogue LowerThird con \\pos sobre la zona de subs', () => {
    const { content, lowerThirds } = buildAssFile({
      utterances: [utt(11_000, 13_000, 'hola', { personId: PERSON_ANA })],
      windowStartMs: 10_000,
      durationMs: 18_000,
      style,
      personNames: new Map([[PERSON_ANA, 'Ana Gomez']]),
    });
    expect(lowerThirds).toBe(1);
    // Turno de 2s (< 3.5s) → el lower-third vive lo que dura el turno.
    expect(content).toContain(
      `Dialogue: 0,0:00:01.00,0:00:03.00,LowerThird,,0,0,0,,{\\pos(${MARGIN_L},${LT_Y})}ANA GOMEZ`,
    );
    // Estilo LowerThird: caja con alpha 0x3A + fuente menor + Alignment=1.
    expect(content).toContain(
      `Style: LowerThird,Oswald,${LT_FONT},&H00FFFFFF,&H000000FF,&H00000000,&H3A000000,-1,0,0,0,100,100,0,0,3,2,0,1,${MARGIN_L},${MARGIN_L},0,1`,
    );
  });

  it('template minimal → estilo sin caja (BorderStyle=1 + outline grueso)', () => {
    const { content } = buildAssFile({
      utterances: [utt(11_000, 12_000, 'x')],
      windowStartMs: 10_000,
      durationMs: 18_000,
      style: resolveSubtitleStyle(
        { fontFamily: 'lato', templateId: 'minimal' },
        { width: VW, height: VH },
      ),
      personNames: new Map(),
    });
    expect(content).toContain('Style: Default,Lato,');
    expect(content).toContain(',1,3,1,2,'); // BorderStyle=1, Outline=3, Shadow=1, Align=2
  });
});

// ─── filter graph (puros) ───────────────────────────────────────────────────

describe('escapeFilterPath / buildProgressFilter / buildBurnArgs', () => {
  it('escapeFilterPath: forward slashes + \\: en el drive + comillas', () => {
    expect(escapeFilterPath('C:\\dir\\sub file.ass')).toBe('C\\:/dir/sub file.ass');
    expect(escapeFilterPath("C:\\it's\\x.ass")).toBe("C\\:/it\\'s/x.ass");
    expect(escapeFilterPath('/unix/dir/f.ass')).toBe('/unix/dir/f.ass');
  });

  it('buildProgressFilter: drawbox w=t/dur*iw, barra fina, accent@0.9', () => {
    const f = buildProgressFilter(18, { width: VW, height: VH }, 'white');
    expect(f).toBe(
      `drawbox=x=0:y=0:w='t/18.000*iw':h=${BAR_H}:color=white@0.9:t=fill`,
    );
  });

  it('sin logo: filter_complex subtitles → drawbox, sin overlay ni 2do input', () => {
    const args = buildBurnArgs({
      inputPath: 'C:\\in\\clip.mp4',
      outputPath: 'C:\\out\\clip_sub.mp4',
      assPath: 'C:\\tmp\\subs.ass',
      fontsDir: 'C:\\app\\fonts',
      logoPath: null,
      durationSec: 18,
      dims: { width: VW, height: VH },
      accent: 'white',
    });
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    const fc = argAfter(args, '-filter_complex')!;
    expect(fc).toBe(
      `[0:v]subtitles='C\\:/tmp/subs.ass':fontsdir='C\\:/app/fonts'[s0];` +
        `[s0]drawbox=x=0:y=0:w='t/18.000*iw':h=${BAR_H}:color=white@0.9:t=fill`,
    );
    expect(argAfter(args, '-c:a')).toBe('copy');
    expect(argAfter(args, '-i')).toBe('C:\\in\\clip.mp4');
    expect(args[args.length - 1]).toBe('C:\\out\\clip_sub.mp4');
  });

  it('con logo: segundo -i + scale + overlay W-w-m:m en la cadena', () => {
    const args = buildBurnArgs({
      inputPath: 'in.mp4',
      outputPath: 'out.mp4',
      assPath: 'subs.ass',
      fontsDir: 'fonts',
      logoPath: 'logo.png',
      durationSec: 18,
      dims: { width: VW, height: VH },
      accent: 'white',
    });
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    const fc = argAfter(args, '-filter_complex')!;
    expect(fc).toContain(`[1:v]scale=${LOGO_W}:-1[lg]`);
    expect(fc).toContain(`overlay=W-w-${LOGO_M}:${LOGO_M}[s1]`);
    // Orden: subtitles → overlay → drawbox.
    expect(fc.indexOf('subtitles')).toBeLessThan(fc.indexOf('overlay'));
    expect(fc.indexOf('overlay')).toBeLessThan(fc.indexOf('drawbox'));
  });
});

// ─── burnSubtitles (integración con fakes) ──────────────────────────────────

describe('burnSubtitles', () => {
  const TWO_SPEAKERS: MemoryUtteranceRow[] = [
    utt(11_000, 13_000, 'primera frase del clip', { personId: PERSON_ANA }),
    utt(14_000, 16_000, 'respuesta del otro', { speakerLabel: 'Speaker B' }),
  ];

  it('clip completo: generating→pending_review, ASS+logo+progreso en UNA pasada', async () => {
    const { store, state } = seedFull({
      utterances: TWO_SPEAKERS,
      persons: [{ id: PERSON_ANA, tenantId: TENANT_A, name: 'Ana Gomez' }],
    });
    const { service, ffmpeg } = makeService(store, {
      branding: makeBranding({ fontFamily: 'oswald', templateId: 'solid_bar' }),
    });

    const res = await service.burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A });

    expect(res.videoPath).toBe(path.join(outputDir, `${CLIP_A}_sub.mp4`));
    expect(existsSync(res.videoPath)).toBe(true);
    expect(res.cues).toBe(2);
    expect(res.lowerThirds).toBe(2);
    expect(res.logo).toBe(true);
    expect(res.progressBar).toBe(true);

    // UNA invocación ffmpeg: dos inputs (video + logo png).
    expect(ffmpeg.calls).toHaveLength(1);
    const args = ffmpeg.calls[0];
    expect(args.filter((a) => a === '-i')).toHaveLength(2);
    expect(argAfter(args, '-i')).toBe(sourcePath);
    const fc = argAfter(args, '-filter_complex')!;
    // subtitles con path del .ass temp escapado (forward slashes + \:).
    const escapedAss = escapeFilterPath(
      path.join(tempDir, 'pf03-subs-fixeduid.ass'),
    );
    expect(fc).toContain(`subtitles='${escapedAss}'`);
    expect(fc).toContain(`fontsdir='${escapeFilterPath(fontsDir)}'`);
    expect(fc).toContain(`scale=${LOGO_W}:-1`);
    expect(fc).toContain(`overlay=W-w-${LOGO_M}:${LOGO_M}`);
    expect(fc).toContain(`w='t/18.000*iw'`);
    expect(argAfter(args, '-c:a')).toBe('copy');
    expect(args[args.length - 1]).toBe(res.videoPath);

    // Fila: 'generating' → 'pending_review' con videoPath nuevo.
    const clip = state.clips[0];
    expect(clip.patches.map((p) => p.status)).toEqual([
      'generating',
      'pending_review',
    ]);
    expect(clip.videoPath).toBe(res.videoPath);
    expect(clip.metadata).toMatchObject({
      transmissionId: TX_A,
      window: { startMs: 10_000, endMs: 28_000 },
      sourceVideoPath: sourcePath,
      subtitles: {
        cues: 2,
        lowerThirds: 2,
        styled: true,
        logo: true,
        progressBar: true,
        renderedAt: T0.toISOString(),
      },
    });

    // Temps (.ass + logo.png) limpios en el finally.
    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('sin logoBuffer → sin segundo input ni overlay, logo=false', async () => {
    const { store, state } = seedFull({ utterances: TWO_SPEAKERS });
    const { service, ffmpeg } = makeService(store, {
      branding: makeBranding({ logoBuffer: null }),
    });

    const res = await service.burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A });

    expect(res.logo).toBe(false);
    const args = ffmpeg.calls[0];
    expect(args.filter((a) => a === '-i')).toHaveLength(1);
    const fc = argAfter(args, '-filter_complex')!;
    expect(fc).not.toContain('overlay');
    expect(fc).not.toContain('[1:v]');
    expect(state.clips[0].metadata?.subtitles).toMatchObject({ logo: false });
  });

  it('sin utterances → render igual con cues=0, NO error', async () => {
    const { store, state } = seedFull({ utterances: [] });
    const { service, ffmpeg } = makeService(store);

    const res = await service.burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A });

    expect(res.cues).toBe(0);
    expect(res.lowerThirds).toBe(0);
    expect(ffmpeg.calls).toHaveLength(1); // el clip se renderiza igual
    expect(state.clips[0].status).toBe('pending_review');
    expect(state.clips[0].metadata?.subtitles).toMatchObject({
      cues: 0,
      lowerThirds: 0,
    });
  });

  it('clip sin transmissionId → cues=0 (degradado, no error)', async () => {
    const { store, state } = seedFull({
      clip: { transmissionId: null },
      utterances: TWO_SPEAKERS, // existen pero el clip no apunta a la tx
    });
    const { service } = makeService(store);

    const res = await service.burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A });
    expect(res.cues).toBe(0);
    expect(state.clips[0].status).toBe('pending_review');
  });

  it('ffmpeg que falla → ffmpeg_failed, fila error + metadata.error, videoPath intacto', async () => {
    const { store, state } = seedFull({ utterances: TWO_SPEAKERS });
    const ffmpeg = makeFakeFfmpeg({ failOnCalls: [1] });
    const { service } = makeService(store, { ffmpeg });

    const err = await service
      .burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipSubtitlesError);
    expect(err.reason).toBe('ffmpeg_failed');
    expect(err.message).toContain('simulated ffmpeg exit 1');

    const clip = state.clips[0];
    expect(clip.status).toBe('error');
    expect(clip.videoPath).toBe(sourcePath); // nunca se pisó
    expect(clip.patches.map((p) => p.status)).toEqual(['generating', 'error']);
    expect(clip.metadata?.error).toContain('simulated ffmpeg exit 1');
    expect(clip.metadata?.transmissionId).toBe(TX_A);

    const leftovers = await fs.readdir(tempDir).catch(() => []);
    expect(leftovers).toEqual([]);
  });

  it('probe que falla → probe_failed y la fila queda error', async () => {
    const { store, state } = seedFull({ utterances: TWO_SPEAKERS });
    const { service, ffmpeg } = makeService(store, {
      probe: async () => {
        throw new Error('ffprobe no está');
      },
    });

    const err = await service
      .burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipSubtitlesError);
    expect(err.reason).toBe('probe_failed');
    expect(state.clips[0].status).toBe('error');
    expect(ffmpeg.calls).toHaveLength(0);
  });

  it('clip sin videoPath → missing_source_video sin tocar ffmpeg ni la fila', async () => {
    const { store, state } = seedFull({ clip: { videoPath: null } });
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipSubtitlesError);
    expect(err.reason).toBe('missing_source_video');
    expect(ffmpeg.calls).toHaveLength(0);
    expect(state.clips[0].status).toBe('pending_review');
    expect(state.clips[0].patches).toEqual([]);
  });

  it('clip sin metadata.window → missing_window sin tocar ffmpeg ni la fila', async () => {
    const { store, state } = seedFull({
      clip: { metadata: { transmissionId: TX_A } }, // clip viejo: sin window
    });
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipSubtitlesError);
    expect(err.reason).toBe('missing_window');
    expect(ffmpeg.calls).toHaveLength(0);
    expect(state.clips[0].patches).toEqual([]);
  });

  it('clip de otro tenant → clip_not_found (aislamiento por tenant)', async () => {
    const { store, state } = seedFull({ utterances: TWO_SPEAKERS });
    const { service, ffmpeg } = makeService(store);

    const err = await service
      .burnSubtitles({ tenantId: TENANT_B, clipId: CLIP_A })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ClipSubtitlesError);
    expect(err.reason).toBe('clip_not_found');
    expect(ffmpeg.calls).toHaveLength(0);
    expect(state.clips[0].patches).toEqual([]);
  });

  it('utterances de OTRO tenant/transmission no se listan', async () => {
    const { store } = seedFull({
      utterances: [
        // Misma ventana pero tenant/transmission ajenos → excluidas por el WHERE.
        {
          ...utt(11_000, 12_000, 'ajena tenant'),
          tenantId: TENANT_B,
        },
        {
          ...utt(12_000, 13_000, 'ajena tx'),
          transmissionId: 'tx-otra',
        },
      ],
    });
    const { service } = makeService(store);
    const res = await service.burnSubtitles({ tenantId: TENANT_A, clipId: CLIP_A });
    expect(res.cues).toBe(0);
  });
});

// ─── Worker dispatch (kind 'subtitles') ─────────────────────────────────────

describe('clipRenderWorker dispatch subtitles', () => {
  it('kind subtitles → burnSubtitles con el clipId del payload → markDone + emit', async () => {
    const { store, state } = createMemoryRenderJobsStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'subtitles',
          clipId: CLIP_A,
          payload: { clipId: CLIP_A },
          maxAttempts: 3,
        },
      ],
      now: () => T0,
    });
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const io = {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ room, event, payload });
          return true;
        },
      }),
    };
    const burnCalls: Array<{ tenantId: string; clipId: string }> = [];
    const worker = createClipRenderWorker(
      {
        store,
        now: () => T0,
        burnSubtitles: async (input) => {
          burnCalls.push(input);
          return {
            clipId: input.clipId,
            videoPath: '/out/x_sub.mp4',
            cues: 7,
            lowerThirds: 2,
            logo: true,
            progressBar: true,
          };
        },
        cutRawWindow: async () => {
          throw new Error('no debería llamarse');
        },
        reframeClip: async () => {
          throw new Error('no debería llamarse');
        },
      },
      io,
    );

    await worker.tick();

    expect(burnCalls).toEqual([{ tenantId: TENANT_A, clipId: CLIP_A }]);
    expect(state.jobs[0].status).toBe('done');
    expect(state.jobs[0].clipId).toBe(CLIP_A);
    expect(emitted).toEqual([
      {
        room: `tenant:${TENANT_A}`,
        event: 'clip:render:done',
        payload: expect.objectContaining({
          clipId: CLIP_A,
          kind: 'subtitles',
          videoPath: '/out/x_sub.mp4',
          cues: 7,
        }),
      },
    ]);
  });

  it('burnSubtitles que tira → markFailed con backoff (mismo contrato)', async () => {
    const { store, state } = createMemoryRenderJobsStore({
      jobs: [
        {
          tenantId: TENANT_A,
          kind: 'subtitles',
          payload: { clipId: CLIP_A },
          maxAttempts: 3,
        },
      ],
      now: () => T0,
    });
    const worker = createClipRenderWorker({
      store,
      now: () => T0,
      burnSubtitles: async () => {
        throw new ClipSubtitlesError('missing_window', 'sin ventana');
      },
    });

    await worker.tick();

    const job = state.jobs[0];
    expect(job.status).toBe('pending'); // attempts=1 → retry en 1min
    expect(job.lastError).toContain('sin ventana');
    expect(job.runAt.getTime()).toBe(T0.getTime() + 60_000);
  });
});
