import type { Express, Request, Response } from "express";
import { eq, and, desc } from "drizzle-orm";

import { db } from "../db/index.js";
import { programs, programUrls } from "../db/schema/programs.js";
import { conductors, conductorPhotos } from "../db/schema/conductors.js";
import { publications } from "../db/schema/publications.js";
import { tenants } from "../db/schema/tenants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  return `${proto}://${host}`;
}

const URL_TYPE_ICONS: Record<string, string> = {
  youtube: "▶",
  facebook: "f",
  kick: "⚡",
  twitch: "⬡",
  radio_stream: "📻",
  website: "🌐",
  other: "🔗",
};

const URL_TYPE_LABELS: Record<string, string> = {
  youtube: "YouTube",
  facebook: "Facebook",
  kick: "Kick",
  twitch: "Twitch",
  radio_stream: "Radio Stream",
  website: "Sitio Web",
  other: "Enlace",
};

const ROLE_LABELS: Record<string, string> = {
  conductor: "Conductor",
  columnista: "Columnista",
  productor: "Productor",
  invitado: "Invitado",
  other: "Colaborador",
};

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("es-AR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// HTML Template
// ---------------------------------------------------------------------------

interface ProgramPageData {
  program: {
    name: string;
    description: string | null;
    schedule: string | null;
    slug: string | null;
    urls: { type: string; url: string; label: string | null }[];
    conductors: {
      id: string;
      name: string;
      role: string | null;
      bio: string | null;
      primaryPhotoId: string | null;
    }[];
  };
  tenant: {
    platformName: string;
    logoUrl: string | null;
  };
  publications: {
    id: string;
    title: string | null;
    preview: string | null;
    imageUrl: string | null;
    createdAt: Date;
  }[];
  baseUrl: string;
  rssUrl: string;
  slugPath: string;
}

function renderProgramPage(data: ProgramPageData): string {
  const { program, tenant, publications: pubs, baseUrl, rssUrl, slugPath } = data;

  const ogImage = pubs.find((p) => p.imageUrl)?.imageUrl
    || tenant.logoUrl
    || "";

  const conductorCards = program.conductors.map((c) => {
    const photoUrl = c.primaryPhotoId
      ? `${baseUrl}/api/public/conductors/${c.id}/photos/${c.primaryPhotoId}`
      : null;
    const roleLabel = ROLE_LABELS[c.role ?? ""] ?? c.role ?? "Colaborador";
    const initials = c.name
      .split(" ")
      .map((w: string) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    return `
      <div class="conductor-card">
        <div class="conductor-photo">
          ${photoUrl
            ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(c.name)}" loading="lazy" />`
            : `<div class="conductor-initials">${escapeHtml(initials)}</div>`
          }
        </div>
        <div class="conductor-info">
          <div class="conductor-name">${escapeHtml(c.name)}</div>
          <div class="conductor-role">${escapeHtml(roleLabel)}</div>
          ${c.bio ? `<div class="conductor-bio">${escapeHtml(c.bio)}</div>` : ""}
        </div>
      </div>`;
  }).join("");

  const urlLinks = program.urls.map((u) => {
    const icon = URL_TYPE_ICONS[u.type] ?? "🔗";
    const label = u.label || URL_TYPE_LABELS[u.type] || u.type;
    return `
      <a href="${escapeHtml(u.url)}" target="_blank" rel="noopener noreferrer" class="url-chip">
        <span class="url-icon">${icon}</span>
        <span>${escapeHtml(label)}</span>
      </a>`;
  }).join("");

  const pubCards = pubs.map((p) => `
    <a href="${escapeHtml(baseUrl)}/p/${escapeHtml(slugPath)}/nota/${escapeHtml(p.id)}" class="pub-card">
      ${p.imageUrl
        ? `<div class="pub-img"><img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.title ?? "")}" loading="lazy" /></div>`
        : `<div class="pub-img pub-img--placeholder"><span>📰</span></div>`
      }
      <div class="pub-body">
        <div class="pub-title">${escapeHtml(p.title ?? "Sin título")}</div>
        ${p.preview ? `<div class="pub-preview">${escapeHtml(p.preview)}</div>` : ""}
        <div class="pub-date">${formatDate(p.createdAt)}</div>
      </div>
    </a>`).join("");

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(program.name)} — ${escapeHtml(tenant.platformName)}</title>
  <meta name="description" content="${escapeHtml(program.description ?? `Escuchá ${program.name} en ${tenant.platformName}`)}">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(program.name)}">
  <meta property="og:description" content="${escapeHtml(program.description ?? `Escuchá ${program.name} en ${tenant.platformName}`)}">
  <meta property="og:url" content="${escapeHtml(baseUrl)}/p/${escapeHtml(slugPath)}">
  ${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ""}
  <meta property="og:site_name" content="${escapeHtml(tenant.platformName)}">
  <meta property="og:locale" content="es_AR">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(program.name)}">
  <meta name="twitter:description" content="${escapeHtml(program.description ?? "")}">
  ${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}">` : ""}

  <!-- RSS autodiscovery -->
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(program.name)} RSS" href="${escapeHtml(rssUrl)}">

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #080c12;
      --bg-card: #0d1219;
      --bg-card-hover: #131b26;
      --border: rgba(255,255,255,0.07);
      --border-hover: rgba(255,255,255,0.14);
      --text-primary: rgba(255,255,255,0.88);
      --text-secondary: rgba(255,255,255,0.55);
      --text-muted: rgba(255,255,255,0.3);
      --accent: #22d3ee;
      --accent-dim: rgba(34,211,238,0.12);
      --accent-border: rgba(34,211,238,0.25);
      --purple: #a78bfa;
      --purple-dim: rgba(167,139,250,0.1);
    }

    html { scroll-behavior: smooth; }

    body {
      font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }

    /* ── Layout ── */
    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 0 24px;
    }

    /* ── Hero ── */
    .hero {
      position: relative;
      overflow: hidden;
      padding: 64px 0 48px;
      background: linear-gradient(135deg, rgba(34,211,238,0.04) 0%, transparent 60%);
      border-bottom: 1px solid var(--border);
    }

    .hero::before {
      content: '';
      position: absolute;
      top: -100px;
      left: -100px;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(34,211,238,0.06) 0%, transparent 70%);
      pointer-events: none;
    }

    .hero-inner {
      position: relative;
      z-index: 1;
    }

    .platform-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 100px;
      background: var(--accent-dim);
      border: 1px solid var(--accent-border);
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 24px;
    }

    .hero-title {
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.15;
      letter-spacing: -0.02em;
      margin-bottom: 16px;
    }

    .hero-description {
      font-size: 1.1rem;
      color: var(--text-secondary);
      max-width: 600px;
      line-height: 1.7;
      margin-bottom: 20px;
    }

    .hero-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .meta-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 8px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      font-size: 13px;
      color: var(--text-secondary);
    }

    .rss-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 8px;
      background: rgba(251,146,60,0.08);
      border: 1px solid rgba(251,146,60,0.2);
      font-size: 13px;
      color: rgba(251,146,60,0.8);
      text-decoration: none;
      transition: background 0.2s;
    }

    .rss-link:hover { background: rgba(251,146,60,0.14); }

    /* ── Sections ── */
    .section {
      padding: 56px 0;
      border-bottom: 1px solid var(--border);
    }

    .section:last-of-type { border-bottom: none; }

    .section-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .section-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 32px;
    }

    /* ── URL chips ── */
    .urls-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .url-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      border-radius: 12px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      text-decoration: none;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
    }

    .url-chip:hover {
      background: rgba(255,255,255,0.07);
      border-color: var(--border-hover);
      color: var(--text-primary);
      transform: translateY(-1px);
    }

    .url-icon {
      font-size: 16px;
      width: 20px;
      text-align: center;
    }

    /* ── Conductors ── */
    .conductors-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 16px;
    }

    .conductor-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding: 28px 20px 24px;
      border-radius: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }

    .conductor-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-hover);
      transform: translateY(-2px);
    }

    .conductor-photo {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      overflow: hidden;
      background: rgba(255,255,255,0.05);
      border: 2px solid var(--border);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .conductor-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .conductor-initials {
      font-size: 1.4rem;
      font-weight: 700;
      color: rgba(255,255,255,0.25);
    }

    .conductor-name {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .conductor-role {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 100px;
      background: var(--purple-dim);
      border: 1px solid rgba(167,139,250,0.2);
      font-size: 11px;
      font-weight: 600;
      color: var(--purple);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .conductor-bio {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-top: 6px;
    }

    /* ── Publications grid ── */
    .pubs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }

    .pub-card {
      display: flex;
      flex-direction: column;
      border-radius: 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      overflow: hidden;
      text-decoration: none;
      transition: all 0.2s;
    }

    .pub-card:hover {
      background: var(--bg-card-hover);
      border-color: var(--border-hover);
      transform: translateY(-2px);
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
    }

    .pub-img {
      aspect-ratio: 16/9;
      overflow: hidden;
      background: rgba(255,255,255,0.03);
      flex-shrink: 0;
    }

    .pub-img img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.3s;
    }

    .pub-card:hover .pub-img img { transform: scale(1.03); }

    .pub-img--placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2rem;
      opacity: 0.3;
    }

    .pub-body {
      padding: 16px;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .pub-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .pub-preview {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      flex: 1;
    }

    .pub-date {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-top: auto;
      padding-top: 8px;
    }

    /* ── Empty state ── */
    .empty-state {
      padding: 48px 24px;
      text-align: center;
      border-radius: 16px;
      background: rgba(255,255,255,0.02);
      border: 1px dashed var(--border);
      color: var(--text-muted);
      font-size: 14px;
    }

    /* ── Footer ── */
    .footer {
      padding: 32px 0;
      text-align: center;
      border-top: 1px solid var(--border);
    }

    .footer-text {
      font-size: 13px;
      color: var(--text-muted);
    }

    .footer-brand {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
    }

    .footer-brand:hover { opacity: 0.8; }

    /* ── Responsive ── */
    @media (max-width: 640px) {
      .hero { padding: 40px 0 32px; }
      .section { padding: 40px 0; }
      .conductors-grid { grid-template-columns: repeat(2, 1fr); }
      .pubs-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <!-- ── Hero ── -->
  <header class="hero">
    <div class="container hero-inner">
      <div class="platform-badge">
        ${tenant.logoUrl
          ? `<img src="${escapeHtml(tenant.logoUrl)}" alt="" style="height:16px;width:auto;border-radius:3px;">`
          : ""}
        ${escapeHtml(tenant.platformName)}
      </div>
      <h1 class="hero-title">${escapeHtml(program.name)}</h1>
      ${program.description ? `<p class="hero-description">${escapeHtml(program.description)}</p>` : ""}
      <div class="hero-meta">
        ${program.schedule ? `<span class="meta-chip">🕐 ${escapeHtml(program.schedule)}</span>` : ""}
        <a href="${escapeHtml(rssUrl)}" class="rss-link" target="_blank" rel="noopener noreferrer">
          <span>◎</span> Podcast RSS
        </a>
      </div>
    </div>
  </header>

  <main>
    ${program.urls.length > 0 ? `
    <!-- ── Links ── -->
    <section class="section">
      <div class="container">
        <div class="section-label">Seguinos en</div>
        <div class="urls-grid">
          ${urlLinks}
        </div>
      </div>
    </section>` : ""}

    ${program.conductors.length > 0 ? `
    <!-- ── Team ── -->
    <section class="section">
      <div class="container">
        <div class="section-label">Equipo</div>
        <h2 class="section-title">El equipo del programa</h2>
        <div class="conductors-grid">
          ${conductorCards}
        </div>
      </div>
    </section>` : ""}

    <!-- ── Recent content ── -->
    <section class="section">
      <div class="container">
        <div class="section-label">Contenido reciente</div>
        <h2 class="section-title">Últimas notas</h2>
        ${pubs.length > 0
          ? `<div class="pubs-grid">${pubCards}</div>`
          : `<div class="empty-state">Todavía no hay contenido publicado.</div>`
        }
      </div>
    </section>
  </main>

  <!-- ── Footer ── -->
  <footer class="footer">
    <div class="container">
      <p class="footer-text">
        Powered by <a href="https://periodistapp.com" class="footer-brand" target="_blank" rel="noopener noreferrer">PeriodistApp</a>
      </p>
    </div>
  </footer>

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPublicPageRoutes(app: Express): void {

  // ------------------------------------------------------------------
  // GET /p/:slug — Public program landing page (server-rendered HTML)
  // ------------------------------------------------------------------
  app.get("/p/:slug", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const [program] = await db
        .select()
        .from(programs)
        .where(and(
          eq(programs.slug, slug),
          eq(programs.isPublic, true),
          eq(programs.isActive, true),
        ))
        .limit(1);

      if (!program) {
        res.status(404).send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Programa no encontrado</title><style>body{font-family:sans-serif;background:#080c12;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}</style></head><body><h1>Programa no encontrado</h1><p style="color:#888;margin-top:8px">Este programa no existe o no tiene página pública habilitada.</p></body></html>`);
        return;
      }

      const baseUrl = getBaseUrl(req);
      const rssUrl = `${baseUrl}/api/public/programs/${slug}/rss`;

      const [tenant] = await db
        .select({ platformName: tenants.platformName, logoUrl: tenants.logoUrl })
        .from(tenants)
        .where(eq(tenants.id, program.tenantId))
        .limit(1);

      const [urls, conductorRows, pubRows] = await Promise.all([
        db.select().from(programUrls).where(eq(programUrls.programId, program.id)),
        db
          .select({
            id: conductors.id,
            name: conductors.name,
            role: conductors.role,
            bio: conductors.bio,
          })
          .from(conductors)
          .where(and(eq(conductors.programId, program.id), eq(conductors.isActive, true))),
        db
          .select({
            id: publications.id,
            title: publications.title,
            content: publications.content,
            imageUrl: publications.imageUrl,
            imagePath: publications.imagePath,
            createdAt: publications.createdAt,
          })
          .from(publications)
          .where(and(
            eq(publications.tenantId, program.tenantId),
            eq(publications.status, "published"),
          ))
          .orderBy(desc(publications.createdAt))
          .limit(10),
      ]);

      // Fetch primary photo IDs for conductors
      const conductorsWithPhotos = await Promise.all(
        conductorRows.map(async (c) => {
          const [photo] = await db
            .select({ id: conductorPhotos.id })
            .from(conductorPhotos)
            .where(and(
              eq(conductorPhotos.conductorId, c.id),
              eq(conductorPhotos.isPrimary, true),
            ))
            .limit(1);
          return { ...c, primaryPhotoId: photo?.id ?? null };
        }),
      );

      // Map publications to feed-friendly shape
      const mappedPubs = pubRows.map((p) => {
        const preview = p.content
          ? p.content.slice(0, 200) + (p.content.length > 200 ? "..." : "")
          : null;
        const resolvedImageUrl = p.imageUrl
          || (p.imagePath ? `${baseUrl}/output/${p.imagePath.replace(/^.*[\\/]/, "")}` : null);
        return {
          id: p.id,
          title: p.title,
          preview,
          imageUrl: resolvedImageUrl,
          createdAt: p.createdAt,
        };
      });

      const html = renderProgramPage({
        program: {
          name: program.name,
          description: program.description,
          schedule: program.schedule,
          slug: program.slug,
          urls,
          conductors: conductorsWithPhotos,
        },
        tenant: {
          platformName: tenant?.platformName ?? "PeriodistApp",
          logoUrl: tenant?.logoUrl ?? null,
        },
        publications: mappedPubs,
        baseUrl,
        rssUrl,
        slugPath: slug,
      });

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.send(html);
    } catch (error) {
      console.error("[PublicPages] Error al renderizar página del programa:", error);
      res.status(500).send("Error interno del servidor");
    }
  });

  // ------------------------------------------------------------------
  // GET /p/:slug/nota/:pubId — Single publication public page
  // ------------------------------------------------------------------
  app.get("/p/:slug/nota/:pubId", async (req: Request, res: Response) => {
    try {
      const { slug, pubId } = req.params;

      const [program] = await db
        .select()
        .from(programs)
        .where(and(
          eq(programs.slug, slug),
          eq(programs.isPublic, true),
          eq(programs.isActive, true),
        ))
        .limit(1);

      if (!program) {
        res.status(404).send("Programa no encontrado");
        return;
      }

      const [pub] = await db
        .select()
        .from(publications)
        .where(and(
          eq(publications.id, pubId),
          eq(publications.tenantId, program.tenantId),
          eq(publications.status, "published"),
        ))
        .limit(1);

      if (!pub) {
        res.status(404).send("Publicación no encontrada");
        return;
      }

      const baseUrl = getBaseUrl(req);

      const [tenant] = await db
        .select({ platformName: tenants.platformName, logoUrl: tenants.logoUrl })
        .from(tenants)
        .where(eq(tenants.id, program.tenantId))
        .limit(1);

      const platformName = tenant?.platformName ?? "PeriodistApp";
      const resolvedImageUrl = pub.imageUrl
        || (pub.imagePath ? `${baseUrl}/output/${pub.imagePath.replace(/^.*[\\/]/, "")}` : null);
      const title = pub.title ?? "Sin título";
      const content = pub.content ?? "";

      const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — ${escapeHtml(program.name)}</title>
  <meta name="description" content="${escapeHtml(content.slice(0, 160))}">

  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(content.slice(0, 200))}">
  <meta property="og:url" content="${escapeHtml(baseUrl)}/p/${escapeHtml(slug)}/nota/${escapeHtml(pub.id)}">
  ${resolvedImageUrl ? `<meta property="og:image" content="${escapeHtml(resolvedImageUrl)}">` : ""}
  <meta property="og:site_name" content="${escapeHtml(platformName)}">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(content.slice(0, 200))}">
  ${resolvedImageUrl ? `<meta name="twitter:image" content="${escapeHtml(resolvedImageUrl)}">` : ""}

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap" rel="stylesheet">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #080c12; --bg-card: #0d1219; --border: rgba(255,255,255,0.07);
      --text-primary: rgba(255,255,255,0.88); --text-secondary: rgba(255,255,255,0.55);
      --text-muted: rgba(255,255,255,0.3); --accent: #22d3ee;
      --accent-dim: rgba(34,211,238,0.1); --accent-border: rgba(34,211,238,0.2);
    }
    body { font-family: 'Space Grotesk', sans-serif; background: var(--bg); color: var(--text-primary); min-height: 100vh; }
    .container { max-width: 720px; margin: 0 auto; padding: 0 24px; }
    .nav { padding: 20px 0; border-bottom: 1px solid var(--border); margin-bottom: 48px; }
    .nav a { color: var(--accent); text-decoration: none; font-size: 14px; font-weight: 500; }
    .nav a:hover { opacity: 0.8; }
    .article-img { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 16px; margin-bottom: 32px; }
    h1 { font-size: clamp(1.6rem, 4vw, 2.4rem); font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin-bottom: 16px; }
    .meta { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 32px; }
    .content { font-size: 1.05rem; line-height: 1.85; color: var(--text-secondary); white-space: pre-wrap; }
    .footer { padding: 48px 0 32px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="container">
      <a href="${escapeHtml(baseUrl)}/p/${escapeHtml(slug)}">← ${escapeHtml(program.name)}</a>
    </div>
  </nav>
  <main>
    <div class="container">
      ${resolvedImageUrl ? `<img src="${escapeHtml(resolvedImageUrl)}" alt="${escapeHtml(title)}" class="article-img">` : ""}
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">${formatDate(pub.createdAt)} · ${escapeHtml(program.name)}</p>
      <div class="content">${escapeHtml(content)}</div>
    </div>
  </main>
  <footer class="footer">
    <div class="container">
      Powered by <a href="https://periodistapp.com" target="_blank" rel="noopener noreferrer">PeriodistApp</a>
    </div>
  </footer>
</body>
</html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60");
      res.send(html);
    } catch (error) {
      console.error("[PublicPages] Error al renderizar nota:", error);
      res.status(500).send("Error interno del servidor");
    }
  });
}
