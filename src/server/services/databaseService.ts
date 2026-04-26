/**
 * databaseService.ts — Drizzle/Neon rewrite
 *
 * Replaces the legacy better-sqlite3 implementation with async Drizzle queries.
 * All functions that previously returned synchronously now return Promises.
 *
 * tenantId: The legacy single-tenant pipeline passes SYSTEM_TENANT_ID from env.
 * Multi-tenant callers (routes, services) should pass req.auth.tenantId directly.
 */

import { db } from "../db/index.js";
import {
  credentials,
  settings,
  publications,
  transcriptions,
  businessAssets,
  customAgents,
  pipelineConfigs,
} from "../db/schema/index.js";
import { eq, and, desc, sql, like } from "drizzle-orm";
import { encrypt, decrypt } from "./encryptionService.js";
import type { Publication, Transcription, MetaAsset, EditHistoryEntry, ReviewPublication, ContentVariants } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Tenant helpers
// ---------------------------------------------------------------------------

/**
 * Returns the system-level tenant UUID used by legacy single-tenant pipeline
 * operations (capture, publish, etc.). Must be set in env as SYSTEM_TENANT_ID.
 */
function getSystemTenantId(): string {
  const id = process.env.SYSTEM_TENANT_ID;
  if (!id) {
    throw new Error(
      "[DB] SYSTEM_TENANT_ID is not set in environment. " +
      "Add it to .env to use single-tenant pipeline features.",
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type PublicationSource = "pipeline" | "manual" | "scheduled";

/** Normalizes legacy source strings to the enum values accepted by Drizzle. */
function normalizePublicationSource(source?: string | null): PublicationSource {
  if (source === "pipeline" || source === "scheduled") return source;
  return "manual";
}

// ---------------------------------------------------------------------------
// Row-to-domain mappers
// ---------------------------------------------------------------------------

/**
 * Maps a Drizzle publication row to the legacy Publication shape.
 * The legacy shape uses snake_case keys and numeric ids (kept as strings here).
 */
function mapPublication(row: typeof publications.$inferSelect): Publication {
  return {
    id: row.id as unknown as number, // callers treat id as opaque — keep string uuid under the hood
    title: row.title ?? "",
    content: row.content ?? null,
    image_path: row.imagePath ?? null,
    image_url: row.imageUrl ?? null,
    source: row.source,
    publish_results: row.publishResults ?? null,
    created_at: row.createdAt?.toISOString(),
  };
}

/**
 * Maps a Drizzle publication row to the ReviewPublication shape (full detail for the review UI).
 */
function mapReviewPublication(row: typeof publications.$inferSelect): ReviewPublication {
  return {
    id: row.id,
    tenantId: row.tenantId,
    title: row.title ?? null,
    content: row.content ?? null,
    imagePath: row.imagePath ?? null,
    imageUrl: row.imageUrl ?? null,
    status: (row.status ?? 'pending_review') as ReviewPublication['status'],
    editHistory: Array.isArray(row.editHistory) ? (row.editHistory as EditHistoryEntry[]) : [],
    quotes: Array.isArray(row.quotes) ? row.quotes : null,
    quoteFlyerPaths: Array.isArray(row.quoteFlyerPaths) ? (row.quoteFlyerPaths as string[]) : [],
    contentVariants: (row.contentVariants as ContentVariants | null) ?? null,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
  };
}

/**
 * Maps a Drizzle transcription row to the legacy Transcription shape.
 */
function mapTranscription(row: typeof transcriptions.$inferSelect): Transcription {
  return {
    id: row.id as unknown as number,
    text: row.text,
    audio_file: row.audioFile ?? null,
    source: row.source,
    duration_seconds: row.durationSeconds ?? null,
    created_at: row.createdAt?.toISOString(),
  };
}

/**
 * Maps a Drizzle businessAssets row to the legacy MetaAsset shape.
 */
function mapAsset(row: typeof businessAssets.$inferSelect): MetaAsset {
  return {
    id: row.id as unknown as number,
    asset_type: row.assetType,
    external_id: row.externalId,
    name: row.name ?? "",
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    is_active: row.isActive ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Obtiene un setting por clave.
 */
export async function getSetting(key: string, tenantId?: string): Promise<string | null> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.tenantId, tid), eq(settings.key, key)))
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Guarda o actualiza un setting.
 */
export async function setSetting(key: string, value: string, tenantId?: string): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .insert(settings)
    .values({ tenantId: tid, key, value })
    .onConflictDoUpdate({
      target: [settings.tenantId, settings.key],
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Obtiene todos los settings que coincidan con un prefijo.
 */
export async function getSettingsByPrefix(
  prefix: string,
  tenantId?: string,
): Promise<Array<{ key: string; value: string | null }>> {
  const tid = tenantId ?? getSystemTenantId();
  return db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(eq(settings.tenantId, tid), like(settings.key, `${prefix}%`)));
}

/**
 * Elimina un setting.
 */
export async function deleteSetting(key: string, tenantId?: string): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .delete(settings)
    .where(and(eq(settings.tenantId, tid), eq(settings.key, key)));
}

// ---------------------------------------------------------------------------
// Credentials (encrypted)
// ---------------------------------------------------------------------------

/**
 * Guarda o actualiza una credencial encriptada.
 */
export async function setCredential(
  name: string,
  value: string,
  category: string = "meta",
  tenantId?: string,
): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  const encryptedValue = encrypt(value);
  await db
    .insert(credentials)
    .values({ tenantId: tid, name, value: encryptedValue, category })
    .onConflictDoUpdate({
      target: [credentials.tenantId, credentials.name],
      set: {
        value: encryptedValue,
        category,
        isValid: true,
        updatedAt: new Date(),
      },
    });
}

/**
 * Obtiene una credencial desencriptada por nombre.
 */
export async function getCredential(name: string, tenantId?: string): Promise<string | null> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select({ value: credentials.value })
    .from(credentials)
    .where(
      and(
        eq(credentials.tenantId, tid),
        eq(credentials.name, name),
        eq(credentials.isValid, true),
      ),
    )
    .limit(1);

  if (!rows[0]) return null;

  try {
    return decrypt(rows[0].value);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[DB] Error desencriptando credencial ${name}:`, message);
    return null;
  }
}

/**
 * Invalida una credencial.
 */
export async function invalidateCredential(name: string, tenantId?: string): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .update(credentials)
    .set({ isValid: false, updatedAt: new Date() })
    .where(and(eq(credentials.tenantId, tid), eq(credentials.name, name)));
}

/**
 * Elimina todas las credenciales de una categoría.
 */
export async function deleteCredentialsByCategory(
  category: string,
  tenantId?: string,
): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .delete(credentials)
    .where(and(eq(credentials.tenantId, tid), eq(credentials.category, category)));
}

/**
 * Obtiene los nombres de credenciales de una categoría (sin valores).
 */
export async function getCredentialNames(
  category: string,
  tenantId?: string,
): Promise<Array<{ name: string; category: string; is_valid: boolean }>> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select({
      name: credentials.name,
      category: credentials.category,
      isValid: credentials.isValid,
    })
    .from(credentials)
    .where(and(eq(credentials.tenantId, tid), eq(credentials.category, category)));

  return rows.map((r) => ({
    name: r.name,
    category: r.category,
    is_valid: r.isValid,
  }));
}

// ---------------------------------------------------------------------------
// Business Assets (Facebook Pages, Instagram accounts)
// ---------------------------------------------------------------------------

/**
 * Guarda o actualiza un asset.
 */
export async function upsertAsset(
  assetType: string,
  externalId: string,
  name: string,
  metadata: Record<string, unknown> = {},
  tenantId?: string,
): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .insert(businessAssets)
    .values({ tenantId: tid, assetType, externalId, name, metadata, isActive: true })
    .onConflictDoUpdate({
      target: [businessAssets.tenantId, businessAssets.externalId],
      set: { name, metadata, isActive: true, updatedAt: new Date() },
    });
}

/**
 * Obtiene todos los assets activos de un tipo.
 */
export async function getAssetsByType(assetType: string, tenantId?: string): Promise<MetaAsset[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(businessAssets)
    .where(
      and(
        eq(businessAssets.tenantId, tid),
        eq(businessAssets.assetType, assetType),
        eq(businessAssets.isActive, true),
      ),
    );
  return rows.map(mapAsset);
}

/**
 * Obtiene todos los assets activos.
 */
export async function getAllActiveAssets(tenantId?: string): Promise<MetaAsset[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(businessAssets)
    .where(and(eq(businessAssets.tenantId, tid), eq(businessAssets.isActive, true)));
  return rows.map(mapAsset);
}

/**
 * Desactiva todos los assets (para reconexión).
 */
export async function deactivateAllAssets(tenantId?: string): Promise<void> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .update(businessAssets)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(businessAssets.tenantId, tid));
}

/**
 * Verifica si hay una conexión Meta válida.
 */
export async function isMetaConnected(tenantId?: string): Promise<boolean> {
  const token = await getCredential("META_USER_LONG_TOKEN", tenantId);
  if (!token) return false;
  const assets = await getAllActiveAssets(tenantId);
  return assets.length > 0;
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------

interface CreatePublicationInput {
  title: string;
  content?: string | null;
  imagePath?: string | null;
  imageUrl?: string | null;
  source?: string;
  publishResults?: unknown;
  quotes?: unknown | null;
  status?: string;
  editHistory?: EditHistoryEntry[];
  quoteFlyerPaths?: string[];
  contentVariants?: ContentVariants | null;
}

/**
 * Guarda una publicación en la base de datos.
 */
export async function createPublication(
  input: CreatePublicationInput,
  tenantId?: string,
): Promise<Publication | null> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .insert(publications)
    .values({
      tenantId: tid,
      title: input.title,
      content: input.content ?? null,
      imagePath: input.imagePath ?? null,
      imageUrl: input.imageUrl ?? null,
      source: normalizePublicationSource(input.source),
      publishResults: input.publishResults ?? {},
      quotes: input.quotes ?? null,
      status: input.status ?? 'pending_review',
      editHistory: input.editHistory ?? [],
      quoteFlyerPaths: input.quoteFlyerPaths ?? [],
      contentVariants: input.contentVariants ?? null,
    })
    .returning();

  return rows[0] ? mapPublication(rows[0]) : null;
}

/**
 * Obtiene una publicación por ID (UUID string).
 */
export async function getPublicationById(id: number | string): Promise<Publication | null> {
  const rows = await db
    .select()
    .from(publications)
    .where(eq(publications.id, String(id)))
    .limit(1);
  return rows[0] ? mapPublication(rows[0]) : null;
}

/**
 * Obtiene todas las publicaciones, más recientes primero.
 */
export async function getAllPublications(
  limit: number = 50,
  offset: number = 0,
  tenantId?: string,
): Promise<Publication[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(publications)
    .where(eq(publications.tenantId, tid))
    .orderBy(desc(publications.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(mapPublication);
}

/**
 * Elimina una publicación por ID.
 */
export async function deletePublication(id: number | string): Promise<boolean> {
  const result = await db
    .delete(publications)
    .where(eq(publications.id, String(id)))
    .returning({ id: publications.id });
  return result.length > 0;
}

/**
 * Obtiene publicaciones por estado (para la cola de revisión).
 */
export async function getPublicationsByStatus(
  tenantId: string,
  status: string,
  limit: number = 50,
  offset: number = 0,
): Promise<{ publications: ReviewPublication[]; total: number }> {
  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(publications)
      .where(and(eq(publications.tenantId, tenantId), eq(publications.status, status)))
      .orderBy(desc(publications.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(publications)
      .where(and(eq(publications.tenantId, tenantId), eq(publications.status, status))),
  ]);
  return {
    publications: rows.map(mapReviewPublication),
    total: countResult[0]?.count ?? 0,
  };
}

/**
 * Obtiene una publicación para revisión (con todos los campos del copiloto editorial).
 */
export async function getReviewPublicationById(
  id: string,
  tenantId: string,
): Promise<ReviewPublication | null> {
  const rows = await db
    .select()
    .from(publications)
    .where(and(eq(publications.id, id), eq(publications.tenantId, tenantId)))
    .limit(1);
  return rows[0] ? mapReviewPublication(rows[0]) : null;
}

/**
 * Actualiza el estado de una publicación.
 */
export async function updatePublicationStatus(
  id: string,
  tenantId: string,
  status: string,
): Promise<ReviewPublication | null> {
  const rows = await db
    .update(publications)
    .set({ status })
    .where(and(eq(publications.id, id), eq(publications.tenantId, tenantId)))
    .returning();
  return rows[0] ? mapReviewPublication(rows[0]) : null;
}

/**
 * Actualiza el contenido de una publicación (título, texto, imagen, variantes).
 */
export async function updatePublicationContent(
  id: string,
  tenantId: string,
  updates: { title?: string; content?: string; imagePath?: string; imageUrl?: string; contentVariants?: ContentVariants | null },
): Promise<ReviewPublication | null> {
  const updateData: Partial<typeof publications.$inferInsert> = {};
  if (updates.title !== undefined) updateData.title = updates.title;
  if (updates.content !== undefined) updateData.content = updates.content;
  if (updates.imagePath !== undefined) updateData.imagePath = updates.imagePath;
  if (updates.imageUrl !== undefined) updateData.imageUrl = updates.imageUrl;
  if (updates.contentVariants !== undefined) updateData.contentVariants = updates.contentVariants;

  if (Object.keys(updateData).length === 0) return getReviewPublicationById(id, tenantId);

  const rows = await db
    .update(publications)
    .set(updateData)
    .where(and(eq(publications.id, id), eq(publications.tenantId, tenantId)))
    .returning();
  return rows[0] ? mapReviewPublication(rows[0]) : null;
}

/**
 * Agrega una entrada al historial de ediciones de una publicación.
 * Usa SQL jsonb concatenation para hacer append sin sobreescribir.
 */
export async function addEditHistoryEntry(
  id: string,
  tenantId: string,
  entry: EditHistoryEntry,
): Promise<ReviewPublication | null> {
  const rows = await db
    .update(publications)
    .set({
      editHistory: sql`COALESCE(${publications.editHistory}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(and(eq(publications.id, id), eq(publications.tenantId, tenantId)))
    .returning();
  return rows[0] ? mapReviewPublication(rows[0]) : null;
}

/**
 * Obtiene publicaciones pendientes de aprobación (compat con history routes).
 */
export async function getPendingPublications(
  limit: number = 50,
  tenantId?: string,
): Promise<Publication[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(publications)
    .where(and(eq(publications.tenantId, tid), eq(publications.status, 'pending_review')))
    .orderBy(desc(publications.createdAt))
    .limit(limit);
  return rows.map(mapPublication);
}

/**
 * Aprueba una publicación (compat con history routes).
 */
export async function approvePublication(id: number | string): Promise<Publication | null> {
  const rows = await db
    .update(publications)
    .set({ status: 'approved' })
    .where(eq(publications.id, String(id)))
    .returning();
  return rows[0] ? mapPublication(rows[0]) : null;
}

/**
 * Actualiza una publicación.
 */
export async function updatePublication(
  id: number | string,
  data: {
    title?: string;
    content?: string;
    imagePath?: string;
    imageUrl?: string;
    status?: string;
  },
): Promise<Publication | null> {
  const updateData: Partial<typeof publications.$inferInsert> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.content !== undefined) updateData.content = data.content;
  if (data.imagePath !== undefined) updateData.imagePath = data.imagePath;
  if (data.imageUrl !== undefined) updateData.imageUrl = data.imageUrl;
  if (data.status !== undefined) updateData.status = data.status;

  if (Object.keys(updateData).length === 0) return getPublicationById(id);

  const rows = await db
    .update(publications)
    .set(updateData)
    .where(eq(publications.id, String(id)))
    .returning();

  return rows[0] ? mapPublication(rows[0]) : null;
}

/**
 * Cuenta publicaciones totales.
 */
export async function countPublications(tenantId?: string): Promise<number> {
  const tid = tenantId ?? getSystemTenantId();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(publications)
    .where(eq(publications.tenantId, tid));
  return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Transcriptions
// ---------------------------------------------------------------------------

interface CreateTranscriptionInput {
  text: string;
  audioFile?: string | null;
  source?: string;
  durationSeconds?: number | null;
  diarized?: boolean;
  speakerCount?: number;
  provider?: string;
}

/**
 * Guarda una transcripción en la base de datos.
 */
export async function createTranscription(
  input: CreateTranscriptionInput,
  tenantId?: string,
): Promise<Transcription | undefined> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .insert(transcriptions)
    .values({
      tenantId: tid,
      text: input.text,
      audioFile: input.audioFile ?? null,
      source: normalizePublicationSource(input.source),
      durationSeconds: input.durationSeconds ?? null,
      diarized: input.diarized ?? false,
      speakerCount: input.speakerCount ?? null,
      provider: input.provider ?? null,
    })
    .returning();

  return rows[0] ? mapTranscription(rows[0]) : undefined;
}

/**
 * Obtiene una transcripción por ID.
 */
export async function getTranscriptionById(id: number | string): Promise<Transcription | undefined> {
  const rows = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.id, String(id)))
    .limit(1);
  return rows[0] ? mapTranscription(rows[0]) : undefined;
}

/**
 * Obtiene todas las transcripciones, más recientes primero.
 */
export async function getAllTranscriptions(
  limit: number = 50,
  offset: number = 0,
  tenantId?: string,
): Promise<Transcription[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(transcriptions)
    .where(eq(transcriptions.tenantId, tid))
    .orderBy(desc(transcriptions.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map(mapTranscription);
}

/**
 * Elimina una transcripción por ID.
 */
export async function deleteTranscription(id: number | string): Promise<boolean> {
  const result = await db
    .delete(transcriptions)
    .where(eq(transcriptions.id, String(id)))
    .returning({ id: transcriptions.id });
  return result.length > 0;
}

/**
 * Cuenta transcripciones totales.
 */
export async function countTranscriptions(tenantId?: string): Promise<number> {
  const tid = tenantId ?? getSystemTenantId();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transcriptions)
    .where(eq(transcriptions.tenantId, tid));
  return result[0]?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Custom Agents
// ---------------------------------------------------------------------------

export async function createAgent(
  agent: {
    id?: string;
    name: string;
    description?: string;
    system_prompt: string;
    position?: number;
    after_step: string;
    is_enabled?: boolean;
    ai_provider?: string;
    temperature?: number;
    max_tokens?: number;
    tools?: string[];
    template_id?: string | null;
  },
  tenantId?: string,
): Promise<unknown> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .insert(customAgents)
    .values({
      ...(agent.id ? { id: agent.id } : {}),
      tenantId: tid,
      name: agent.name,
      description: agent.description ?? "",
      systemPrompt: agent.system_prompt,
      position: agent.position ?? 0,
      afterStep: agent.after_step,
      isEnabled: agent.is_enabled !== false,
      aiProvider: agent.ai_provider ?? "auto",
      temperature: agent.temperature ?? 0.7,
      maxTokens: agent.max_tokens ?? 2000,
      tools: agent.tools ?? [],
      templateId: agent.template_id ?? null,
    })
    .returning();

  return rows[0] ? mapAgent(rows[0]) : null;
}

export async function getAgent(id: string, tenantId?: string): Promise<unknown> {
  const rows = await db
    .select()
    .from(customAgents)
    .where(eq(customAgents.id, id))
    .limit(1);
  return rows[0] ? mapAgent(rows[0]) : null;
}

export async function getAllAgents(tenantId?: string): Promise<unknown[]> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(customAgents)
    .where(eq(customAgents.tenantId, tid))
    .orderBy(customAgents.afterStep, customAgents.position);
  return rows.map(mapAgent);
}

export async function updateAgent(id: string, data: Record<string, unknown>, tenantId?: string): Promise<unknown> {
  const updateData: Partial<typeof customAgents.$inferInsert> = {};

  if (data.name !== undefined) updateData.name = data.name as string;
  if (data.description !== undefined) updateData.description = data.description as string;
  if (data.system_prompt !== undefined) updateData.systemPrompt = data.system_prompt as string;
  if (data.position !== undefined) updateData.position = data.position as number;
  if (data.after_step !== undefined) updateData.afterStep = data.after_step as string;
  if (data.is_enabled !== undefined) updateData.isEnabled = Boolean(data.is_enabled);
  if (data.ai_provider !== undefined) updateData.aiProvider = data.ai_provider as string;
  if (data.temperature !== undefined) updateData.temperature = data.temperature as number;
  if (data.max_tokens !== undefined) updateData.maxTokens = data.max_tokens as number;
  if (data.tools !== undefined) updateData.tools = data.tools as string[];
  if (data.template_id !== undefined) updateData.templateId = data.template_id as string | null;

  if (Object.keys(updateData).length === 0) return getAgent(id, tenantId);

  updateData.updatedAt = new Date();

  const rows = await db
    .update(customAgents)
    .set(updateData)
    .where(eq(customAgents.id, id))
    .returning();

  return rows[0] ? mapAgent(rows[0]) : null;
}

export async function deleteAgent(id: string): Promise<boolean> {
  const result = await db
    .delete(customAgents)
    .where(eq(customAgents.id, id))
    .returning({ id: customAgents.id });
  return result.length > 0;
}

function mapAgent(row: typeof customAgents.$inferSelect): unknown {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    system_prompt: row.systemPrompt,
    position: row.position,
    after_step: row.afterStep,
    is_enabled: row.isEnabled,
    ai_provider: row.aiProvider,
    temperature: row.temperature,
    max_tokens: row.maxTokens,
    tools: Array.isArray(row.tools) ? row.tools : [],
    template_id: row.templateId ?? null,
    created_at: row.createdAt?.toISOString(),
    updated_at: row.updatedAt?.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pipeline Config
// ---------------------------------------------------------------------------

export async function getActivePipelineConfig(tenantId?: string): Promise<unknown> {
  const tid = tenantId ?? getSystemTenantId();
  const rows = await db
    .select()
    .from(pipelineConfigs)
    .where(and(eq(pipelineConfigs.tenantId, tid), eq(pipelineConfigs.isActive, true)))
    .limit(1);
  return rows[0] ? mapPipelineConfig(rows[0]) : null;
}

export async function savePipelineConfig(
  config: { id?: string; name?: string; node_order: string[] },
  tenantId?: string,
): Promise<unknown> {
  const tid = tenantId ?? getSystemTenantId();
  const name = config.name ?? "Default Pipeline";

  await db
    .insert(pipelineConfigs)
    .values({
      ...(config.id ? { id: config.id } : {}),
      tenantId: tid,
      name,
      nodeOrder: config.node_order,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [pipelineConfigs.id],
      set: { name, nodeOrder: config.node_order, updatedAt: new Date() },
    });

  return getActivePipelineConfig(tenantId);
}

export async function resetPipelineConfig(tenantId?: string): Promise<null> {
  const tid = tenantId ?? getSystemTenantId();
  await db
    .delete(pipelineConfigs)
    .where(and(eq(pipelineConfigs.tenantId, tid), eq(pipelineConfigs.name, "default")));
  return null;
}

function mapPipelineConfig(row: typeof pipelineConfigs.$inferSelect): unknown {
  return {
    id: row.id,
    name: row.name,
    node_order: Array.isArray(row.nodeOrder) ? row.nodeOrder : [],
    is_active: row.isActive,
    created_at: row.createdAt?.toISOString(),
    updated_at: row.updatedAt?.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deduplication helper (replaces legacy getDb() raw query in deduplicationService)
// ---------------------------------------------------------------------------

interface RecentPublicationRow {
  id: string;
  title: string;
  content: string | null;
  created_at: string;
}

export async function findRecentPublications(
  hoursBack: number = 24,
  tenantId?: string,
): Promise<RecentPublicationRow[]> {
  const tid = tenantId ?? getSystemTenantId();
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: publications.id,
      title: publications.title,
      content: publications.content,
      createdAt: publications.createdAt,
    })
    .from(publications)
    .where(
      and(
        eq(publications.tenantId, tid),
        sql`${publications.createdAt} > ${cutoff.toISOString()}`,
      ),
    )
    .orderBy(desc(publications.createdAt));

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    content: r.content ?? null,
    created_at: r.createdAt?.toISOString() ?? "",
  }));
}
