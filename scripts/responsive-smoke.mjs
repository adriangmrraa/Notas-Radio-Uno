#!/usr/bin/env node
/**
 * responsive-smoke — PH-07 tablet gate.
 *
 * Measures real horizontal overflow at 768×1024 (tablet portrait) for the
 * views in the PH-07 scope. Spawns the vite dev server, mocks `/api/*`
 * responses with `page.route` (no DB needed), and fails if any route reports
 * `document.documentElement.scrollWidth > clientWidth`.
 *
 * Usage: node scripts/responsive-smoke.mjs [--port N] [--headed]
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = Number(process.env.SMOKE_PORT || 5199);
const BASE = `http://localhost:${PORT}`;
const HEADED = process.argv.includes('--headed');

const now = Date.now();
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString();

const FAKE_TOKEN = 'smoke-token';

const me = {
  user: {
    id: 'u-smoke',
    email: 'smoke@example.com',
    fullName: 'Smoke Test',
    role: 'admin',
    tenantId: 't-smoke',
    isVerified: true,
    isPlatformAdmin: false,
  },
  tenant: { id: 't-smoke', name: 'Smoke Newsroom' },
  subscription: { status: 'active', planName: 'Pro', limits: {} },
};

const transmissions = {
  items: [
    {
      id: 'tx-1',
      status: 'live',
      source: 'rtmp',
      programName: 'Noticiero Central Mediodía',
      scheduledName: null,
      startedAt: iso(3600_000),
      createdAt: iso(4000_000),
    },
    {
      id: 'tx-2',
      status: 'ended',
      source: 'vod',
      programName: 'Móvil especial elecciones provinciales — cobertura completa',
      scheduledName: 'Elecciones 2025',
      startedAt: iso(86_400_000),
      createdAt: iso(90_000_000),
    },
    {
      id: 'tx-3',
      status: 'error',
      source: 'hls',
      programName: null,
      scheduledName: null,
      startedAt: null,
      createdAt: iso(172_800_000),
    },
  ],
};

const persons = {
  items: [
    {
      id: 'p-1',
      name: 'María Fernanda González de la Vega',
      role: 'conductor',
      roleLabel: 'Conductora principal',
      bio: null,
      notes: null,
      socialLinks: {},
      isActive: true,
      faceStatus: 'enrolled',
      consentGiven: true,
      consentAt: iso(1_000_000_000),
      embeddingRef: null,
      createdAt: iso(1_000_000_000),
      photos: [],
      programs: [],
    },
    {
      id: 'p-2',
      name: 'Juan Pérez',
      role: 'invitado',
      roleLabel: null,
      bio: 'Analista político',
      notes: null,
      socialLinks: {},
      isActive: true,
      faceStatus: 'pending',
      consentGiven: false,
      consentAt: null,
      embeddingRef: null,
      createdAt: iso(900_000_000),
      photos: [],
      programs: [],
    },
    {
      id: 'p-3',
      name: 'Rómulo Augusto Hernández-Suárez Martínez',
      role: 'productor',
      roleLabel: 'Producción ejecutiva',
      bio: null,
      notes: null,
      socialLinks: {},
      isActive: false,
      faceStatus: 'failed',
      consentGiven: true,
      consentAt: iso(800_000_000),
      embeddingRef: null,
      createdAt: iso(800_000_000),
      photos: [],
      programs: [],
    },
  ],
  total: 3,
};

const reviewPubs = {
  publications: [
    {
      id: 'pub-1',
      tenantId: 't-smoke',
      title: 'Resumen: declaraciones del ministro de economía sobre el presupuesto 2026',
      content: 'El ministro anunció...',
      imagePath: null,
      imageUrl: null,
      status: 'pending_review',
      editHistory: [],
      quotes: [],
      quoteFlyerPaths: [],
      createdAt: iso(7200_000),
    },
    {
      id: 'pub-2',
      tenantId: 't-smoke',
      title: 'Clip destacado: debate de candidatos a gobernador',
      content: null,
      imagePath: null,
      imageUrl: null,
      status: 'pending_review',
      editHistory: [],
      quotes: [],
      quoteFlyerPaths: [],
      createdAt: iso(14_400_000),
    },
  ],
  total: 2,
};

const assets = {
  items: [
    {
      id: 'a-1',
      transmissionId: 'tx-2',
      programId: 'prog-1',
      type: 'image',
      source: 'ai_generated',
      title: 'Flyer institucional jornada electoral — versión extendida para redes sociales',
      status: 'ready',
      storagePath: null,
      url: null,
      metadata: {},
      createdAt: iso(50_000_000),
    },
    {
      id: 'a-2',
      transmissionId: 'tx-2',
      programId: null,
      type: 'quote_card',
      source: 'ai_generated',
      title: 'Cita: "La provincia necesita un cambio profundo"',
      status: 'processing',
      storagePath: null,
      url: null,
      metadata: {},
      createdAt: iso(51_000_000),
    },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
};

const publishJobs = {
  jobs: [
    {
      id: 'job-1',
      publicationId: 'pub-1',
      target: 'instagram',
      status: 'scheduled',
      scheduledAt: iso(-3600_000),
      attempts: 0,
      lastError: null,
      createdAt: iso(20_000_000),
    },
    {
      id: 'job-2',
      publicationId: 'pub-2',
      target: 'youtube',
      status: 'failed',
      scheduledAt: iso(1000_000),
      attempts: 3,
      lastError: 'token expirado',
      createdAt: iso(40_000_000),
    },
  ],
  total: 2,
};

const liveRoom = {
  transmission: {
    id: 'tx-1',
    status: 'live',
    source: 'rtmp',
    streamUrl: null,
    crudoRef: null,
    startedAt: iso(3600_000),
    endedAt: null,
    durationMinutes: 60,
    errorMessage: null,
    programId: 'prog-1',
    programName: 'Noticiero Central Mediodía',
  },
  recording: { id: 'rec-1', status: 'recording', segmentCount: 12, totalBytes: 0, startedAt: iso(3600_000) },
  segments: [
    { sequence: 11, startMs: 3_300_000, endMs: 3_600_000, bytes: 0, status: 'finalized' },
    { sequence: 12, startMs: 3_600_000, endMs: null, bytes: 0, status: 'recording' },
  ],
  timeline: [
    {
      id: 'tl-1',
      startMs: 3_300_000,
      endMs: 3_360_000,
      speakerLabel: 'SPEAKER_00',
      personId: 'p-1',
      personName: 'María Fernanda González de la Vega',
      personPhotoUrl: null,
      text: 'Buen día, comenzamos el noticiero con las principales noticias de la jornada electoral.',
      confidence: 0.95,
    },
    {
      id: 'tl-2',
      startMs: 3_360_000,
      endMs: 3_420_000,
      speakerLabel: 'SPEAKER_01',
      personId: null,
      personName: null,
      personPhotoUrl: null,
      text: 'Gracias María, en el móvil estamos con los primeros resultados...',
      confidence: 0.88,
    },
  ],
  moments: [
    {
      id: 'm-1',
      kind: 'highlight',
      startMs: 3_400_000,
      endMs: 3_500_000,
      title: 'Anuncio de resultados preliminares',
      reason: 'keyword',
      score: 0.9,
      clipId: null,
    },
  ],
  clips: [
    { id: 'c-1', title: 'Apertura del noticiero', hookText: 'Arranca la cobertura', status: 'ready', duration: 45, videoUrl: null },
  ],
  people: [
    { personId: 'p-1', name: 'María Fernanda González de la Vega', photoUrl: null, confidence: 0.9, speakerLabel: 'SPEAKER_00' },
  ],
};

const scheduled = { items: [] };
const programs = { programs: [{ id: 'prog-1', tenantId: 't-smoke', name: 'Noticiero Central', description: null, schedule: null, isActive: true, urls: [], createdAt: iso(1_200_000_000) }] };
const connections = { connections: [] };
const quota = { used: 1, limit: 10, remaining: 9, planName: 'Pro', status: 'active' };
const branding = { tenantId: 't-smoke', platformName: null, primaryColor: null, secondaryColor: null, logoPath: null, defaultFont: null, defaultTemplate: null };

/** Ordered API stubs — first match wins. Extend per-route via `routeExtras`. */
const API_STUBS = [
  { match: /\/api\/auth\/me$/, body: me },
  { match: /\/api\/features$/, body: {} },
  { match: /\/api\/billing\/quota$/, body: quota },
  { match: /\/api\/notifications/, body: { items: [], unread: 0 } },
  { match: /\/api\/transmissions\/scheduled/, body: scheduled },
  { match: /\/api\/live\/transmissions\/[\w-]+$/, body: liveRoom },
  { match: /\/api\/live\/transmissions\/[\w-]+\/(mark|stop)$/, body: { moment: liveRoom.moments[0], clip: null }, method: 'POST' },
  { match: /\/api\/transmissions/, body: transmissions },
  { match: /\/api\/persons/, body: persons },
  { match: /\/api\/programs$/, body: programs },
  { match: /\/api\/assets/, body: assets },
  { match: /\/api\/publish-jobs/, body: publishJobs },
  { match: /\/api\/social-connections/, body: connections },
  { match: /\/api\/review/, body: reviewPubs },
  { match: /\/api\/settings\/webhooks$/, body: {} },
  { match: /\/api\/branding\/fonts$/, body: [] },
  { match: /\/api\/branding\/templates$/, body: [] },
  { match: /\/api\/branding\/logo/, status: 404, body: { error: 'not found' } },
  { match: /\/api\/branding$/, body: branding },
];

const ROUTES = [
  { path: '/en-vivo', name: 'live picker' },
  { path: '/en-vivo/tx-1', name: 'live room' },
  { path: '/dashboard', name: 'dashboard' },
  { path: '/assets', name: 'assets' },
  { path: '/publish', name: 'publish' },
  { path: '/agenda', name: 'agenda' },
  { path: '/persons', name: 'persons' },
  { path: '/review', name: 'review' },
  { path: '/settings', name: 'settings' },
  { path: '/login', name: 'login', unauthenticated: true },
];

function startServer() {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const proc = spawn(bin, ['vite', '--port', String(PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  return proc;
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE);
      if (res.ok || res.status === 404) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`vite dev server did not start on ${BASE}`);
}

async function stubApi(page, { unauthenticated = false } = {}) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (unauthenticated && /\/api\/auth\/me$/.test(url)) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'No autenticado' }) });
    }
    const stub = API_STUBS.find((s) => s.match.test(url) && (!s.method || s.method === method));
    if (stub) {
      return route.fulfill({
        status: stub.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(stub.body),
      });
    }
    if (method === 'GET') {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'smoke: unmocked GET', url }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // Socket.IO never connects without a backend — fail fast so tests don't hang.
  await page.route('**/socket.io/**', (route) => route.abort());
}

async function measure(page, { path, name, unauthenticated }) {
  await stubApi(page, { unauthenticated });
  if (!unauthenticated) {
    await page.addInitScript((token) => localStorage.setItem('accessToken', token), FAKE_TOKEN);
  }
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
  // Let async data settle + fonts/layout stabilize.
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [];
    if (doc.scrollWidth > doc.clientWidth) {
      const vw = doc.clientWidth;
      document.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 || r.left < -1) {
          const cls = typeof el.className === 'string' ? el.className.slice(0, 120) : '';
          offenders.push({ tag: el.tagName.toLowerCase(), cls, right: Math.round(r.right), left: Math.round(r.left) });
        }
      });
    }
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      bodyScrollWidth: document.body?.scrollWidth ?? 0,
      offenders: offenders.slice(0, 12),
      overflowXComputed: getComputedStyle(doc).overflowX,
    };
  });

  const overflow = result.scrollWidth - result.clientWidth;
  return { name, path, overflow, ...result };
}

async function main() {
  const server = startServer();
  let exitCode = 0;
  try {
    await waitForServer();
    const browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({
      viewport: { width: 768, height: 1024 },
      deviceScaleFactor: 1,
      isMobile: false,
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.error(`  [pageerror] ${err.message}`));

    const results = [];
    for (const route of ROUTES) {
      const r = await measure(page, route);
      results.push(r);
      const flag = r.overflow > 0 ? 'OVERFLOW' : 'ok';
      console.log(`${flag.padEnd(8)} ${route.name.padEnd(12)} ${route.path.padEnd(16)} scroll=${r.scrollWidth} client=${r.clientWidth} (+${r.overflow}px)`);
      if (r.overflow > 0) {
        for (const o of r.offenders.slice(0, 6)) {
          console.log(`         offender: <${o.tag}> right=${o.right} left=${o.left} .${o.cls.trim().split(/\s+/).slice(0, 4).join('.')}`);
        }
      }
    }

    const overflows = results.filter((r) => r.overflow > 0);
    console.log('');
    if (overflows.length) {
      console.log(`FAIL: ${overflows.length} route(s) overflow at 768x1024: ${overflows.map((r) => r.path).join(', ')}`);
      exitCode = 1;
    } else {
      console.log(`PASS: ${results.length} routes measured at 768x1024 — zero horizontal overflow`);
    }

    await browser.close();
  } catch (err) {
    console.error(`responsive-smoke failed: ${err.message}`);
    exitCode = 2;
  } finally {
    server.kill();
    // Windows: npx.cmd spawns a child shell — kill the tree.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(server.pid), '/f', '/t'], { stdio: 'ignore' });
    }
  }
  process.exit(exitCode);
}

main();
