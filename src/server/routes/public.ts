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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001";
  return `${proto}://${host}`;
}

async function findPublicProgram(slug: string) {
  const [program] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.slug, slug), eq(programs.isPublic, true), eq(programs.isActive, true)))
    .limit(1);
  return program ?? null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerPublicRoutes(app: Express): void {

  // ------------------------------------------------------------------
  // GET /api/public/programs/:slug — Program info + conductors
  // ------------------------------------------------------------------
  app.get("/api/public/programs/:slug", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const program = await findPublicProgram(slug);
      if (!program) {
        res.status(404).json({ error: "Programa no encontrado o no es público" });
        return;
      }

      const [tenant] = await db
        .select({
          platformName: tenants.platformName,
          logoUrl: tenants.logoUrl,
        })
        .from(tenants)
        .where(eq(tenants.id, program.tenantId))
        .limit(1);

      const urls = await db
        .select()
        .from(programUrls)
        .where(eq(programUrls.programId, program.id));

      const conductorRows = await db
        .select({
          id: conductors.id,
          name: conductors.name,
          role: conductors.role,
          bio: conductors.bio,
        })
        .from(conductors)
        .where(and(eq(conductors.programId, program.id), eq(conductors.isActive, true)));

      // Fetch primary photo ID for each conductor
      const conductorsWithPhotos = await Promise.all(
        conductorRows.map(async (conductor) => {
          const [primaryPhoto] = await db
            .select({ id: conductorPhotos.id, mimeType: conductorPhotos.mimeType })
            .from(conductorPhotos)
            .where(and(
              eq(conductorPhotos.conductorId, conductor.id),
              eq(conductorPhotos.isPrimary, true),
            ))
            .limit(1);

          const baseUrl = getBaseUrl(req);
          const photoUrl = primaryPhoto
            ? `${baseUrl}/api/public/conductors/${conductor.id}/photos/${primaryPhoto.id}`
            : null;

          return { ...conductor, photoUrl };
        }),
      );

      res.json({
        program: {
          id: program.id,
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
      });
    } catch (error) {
      console.error("[Public] Error al obtener programa:", error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/public/programs/:slug/feed — Published content feed
  // ------------------------------------------------------------------
  app.get("/api/public/programs/:slug/feed", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const limit = Math.min(parseInt(req.query.limit as string || "20", 10), 50);
      const offset = parseInt(req.query.offset as string || "0", 10);

      const program = await findPublicProgram(slug);
      if (!program) {
        res.status(404).json({ error: "Programa no encontrado o no es público" });
        return;
      }

      const items = await db
        .select({
          id: publications.id,
          title: publications.title,
          content: publications.content,
          imageUrl: publications.imageUrl,
          imagePath: publications.imagePath,
          quotes: publications.quotes,
          createdAt: publications.createdAt,
        })
        .from(publications)
        .where(and(
          eq(publications.tenantId, program.tenantId),
          eq(publications.status, "published"),
        ))
        .orderBy(desc(publications.createdAt))
        .limit(limit)
        .offset(offset);

      const baseUrl = getBaseUrl(req);

      const feed = items.map((item) => {
        const preview = item.content ? item.content.slice(0, 200) + (item.content.length > 200 ? "..." : "") : null;
        // Resolve image URL: prefer imageUrl, fallback to imagePath served via /output
        const resolvedImageUrl = item.imageUrl
          || (item.imagePath ? `${baseUrl}/output/${item.imagePath.replace(/^.*[\\/]/, "")}` : null);
        const quotesArr = Array.isArray(item.quotes) ? item.quotes : [];
        return {
          id: item.id,
          title: item.title,
          preview,
          imageUrl: resolvedImageUrl,
          quotesCount: quotesArr.length,
          createdAt: item.createdAt,
        };
      });

      res.json({ feed, total: feed.length, limit, offset });
    } catch (error) {
      console.error("[Public] Error al obtener feed:", error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/public/programs/:slug/publications/:id — Full publication
  // ------------------------------------------------------------------
  app.get("/api/public/programs/:slug/publications/:id", async (req: Request, res: Response) => {
    try {
      const { slug, id } = req.params;

      const program = await findPublicProgram(slug);
      if (!program) {
        res.status(404).json({ error: "Programa no encontrado o no es público" });
        return;
      }

      const [pub] = await db
        .select()
        .from(publications)
        .where(and(
          eq(publications.id, id),
          eq(publications.tenantId, program.tenantId),
          eq(publications.status, "published"),
        ))
        .limit(1);

      if (!pub) {
        res.status(404).json({ error: "Publicación no encontrada" });
        return;
      }

      const baseUrl = getBaseUrl(req);
      const resolvedImageUrl = pub.imageUrl
        || (pub.imagePath ? `${baseUrl}/output/${pub.imagePath.replace(/^.*[\\/]/, "")}` : null);

      res.json({
        publication: {
          id: pub.id,
          title: pub.title,
          content: pub.content,
          imageUrl: resolvedImageUrl,
          quotes: pub.quotes,
          contentVariants: pub.contentVariants,
          createdAt: pub.createdAt,
        },
      });
    } catch (error) {
      console.error("[Public] Error al obtener publicación:", error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  });

  // ------------------------------------------------------------------
  // GET /api/public/programs/:slug/rss — RSS 2.0 feed
  // ------------------------------------------------------------------
  app.get("/api/public/programs/:slug/rss", async (req: Request, res: Response) => {
    try {
      const { slug } = req.params;

      const program = await findPublicProgram(slug);
      if (!program) {
        res.status(404).send("Programa no encontrado");
        return;
      }

      const [tenant] = await db
        .select({ platformName: tenants.platformName })
        .from(tenants)
        .where(eq(tenants.id, program.tenantId))
        .limit(1);

      const items = await db
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
        .limit(50);

      const baseUrl = getBaseUrl(req);
      const platformName = tenant?.platformName ?? "PeriodistApp";
      const programName = escapeXml(program.name);
      const description = escapeXml(program.description ?? `Contenido del programa ${program.name}`);

      const rssItems = items
        .map((item) => {
          const title = escapeXml(item.title ?? "Sin título");
          const pubDate = new Date(item.createdAt).toUTCString();
          const guid = `${baseUrl}/p/${slug}/nota/${item.id}`;
          const resolvedImageUrl = item.imageUrl
            || (item.imagePath ? `${baseUrl}/output/${item.imagePath.replace(/^.*[\\/]/, "")}` : null);

          return `
    <item>
      <title>${title}</title>
      <description><![CDATA[${item.content ?? ""}]]></description>
      <pubDate>${pubDate}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
      <link>${guid}</link>
      ${resolvedImageUrl ? `<enclosure url="${escapeXml(resolvedImageUrl)}" type="image/jpeg" length="0"/>` : ""}
    </item>`;
        })
        .join("");

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${programName}</title>
    <description>${description}</description>
    <link>${baseUrl}/p/${slug}</link>
    <language>es-AR</language>
    <copyright>${platformName}</copyright>
    <generator>PeriodistApp RSS</generator>
    <atom:link href="${baseUrl}/api/public/programs/${slug}/rss" rel="self" type="application/rss+xml"/>
    ${program.schedule ? `<ttl>60</ttl>` : ""}
${rssItems}
  </channel>
</rss>`;

      res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300");
      res.send(xml);
    } catch (error) {
      console.error("[Public] Error al generar RSS:", error);
      res.status(500).send("Error interno del servidor");
    }
  });

  // ------------------------------------------------------------------
  // GET /api/public/conductors/:id/photos/:photoId — Serve conductor photo (public)
  // NOTE: Only serves photos of conductors belonging to public programs
  // ------------------------------------------------------------------
  app.get(
    "/api/public/conductors/:id/photos/:photoId",
    async (req: Request, res: Response) => {
      try {
        const { id, photoId } = req.params;

        // Verify the conductor belongs to a public, active program
        const [conductor] = await db
          .select({ id: conductors.id, programId: conductors.programId })
          .from(conductors)
          .where(eq(conductors.id, id))
          .limit(1);

        if (!conductor?.programId) {
          res.status(404).json({ error: "Conductor no encontrado" });
          return;
        }

        const [publicProgram] = await db
          .select({ id: programs.id })
          .from(programs)
          .where(and(
            eq(programs.id, conductor.programId),
            eq(programs.isPublic, true),
            eq(programs.isActive, true),
          ))
          .limit(1);

        if (!publicProgram) {
          res.status(403).json({ error: "Acceso denegado" });
          return;
        }

        const [photo] = await db
          .select({ photoData: conductorPhotos.photoData, mimeType: conductorPhotos.mimeType })
          .from(conductorPhotos)
          .where(and(
            eq(conductorPhotos.id, photoId),
            eq(conductorPhotos.conductorId, id),
          ))
          .limit(1);

        if (!photo) {
          res.status(404).json({ error: "Foto no encontrada" });
          return;
        }

        res.setHeader("Content-Type", photo.mimeType);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.send(Buffer.from(photo.photoData));
      } catch (error) {
        console.error("[Public] Error al servir foto de conductor:", error);
        res.status(500).json({ error: "Error interno del servidor" });
      }
    },
  );
}
