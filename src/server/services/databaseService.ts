import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { encrypt, decrypt } from "./encryptionService.js";
import type { Publication, Transcription, MetaAsset } from "../../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "data", "credentials.db");

interface CredentialRow {
  name: string;
  value: string;
  category: string;
  is_valid: number;
  created_at: string;
  updated_at: string;
}

interface SettingRow {
  key: string;
  value: string;
}

interface PublicationRow {
  id: number;
  title: string;
  content: string | null;
  image_path: string | null;
  image_url: string | null;
  source: string;
  publish_results: string | null;
  created_at: string;
}

interface TranscriptionRow {
  id: number;
  text: string;
  audio_file: string | null;
  source: string;
  duration_seconds: number | null;
  created_at: string;
}

interface AssetRow {
  id: number;
  asset_type: string;
  external_id: string;
  name: string;
  metadata: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface CountRow {
  count: number;
}

interface CreatePublicationInput {
  title: string;
  content?: string | null;
  imagePath?: string | null;
  imageUrl?: string | null;
  source?: string;
  publishResults?: any;
}

interface CreateTranscriptionInput {
  text: string;
  audioFile?: string | null;
  source?: string;
  durationSeconds?: number | null;
}

let db: Database.Database | null = null;

/**
 * Inicializa la base de datos SQLite con las tablas necesarias.
 */
export function initDatabase(): Database.Database {
  // Crear directorio data/ si no existe
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Habilitar WAL mode para mejor performance
  db.pragma("journal_mode = WAL");

  // Tabla de credenciales encriptadas
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'meta',
      is_valid INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabla de assets de negocio (Facebook Pages, Instagram accounts)
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_type TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT,
      metadata TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabla de publicaciones (notas periodísticas generadas)
  db.exec(`
    CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      image_path TEXT,
      image_url TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      publish_results TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabla de transcripciones de audio
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      audio_file TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      duration_seconds INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabla de settings configurables (webhooks, etc.)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  console.log("[DB] Base de datos SQLite inicializada en", DB_PATH);
  return db;
}

/**
 * Obtiene la instancia de la base de datos.
 */
export function getDb(): Database.Database {
  if (!db) {
    initDatabase();
  }
  return db!;
}

// ==========================================
// CRUD de Settings
// ==========================================

/**
 * Obtiene un setting por clave.
 */
export function getSetting(key: string): string | null {
  const database = getDb();
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as SettingRow | undefined;
  return row ? row.value : null;
}

/**
 * Guarda o actualiza un setting.
 */
export function setSetting(key: string, value: string): void {
  const database = getDb();
  database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, value);
}

/**
 * Obtiene todos los settings que coincidan con un prefijo.
 */
export function getSettingsByPrefix(prefix: string): SettingRow[] {
  const database = getDb();
  return database.prepare("SELECT key, value FROM settings WHERE key LIKE ?").all(`${prefix}%`) as SettingRow[];
}

/**
 * Elimina un setting.
 */
export function deleteSetting(key: string): void {
  const database = getDb();
  database.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

// ==========================================
// CRUD de Credenciales (encriptadas)
// ==========================================

/**
 * Guarda o actualiza una credencial encriptada.
 */
export function setCredential(name: string, value: string, category: string = "meta"): void {
  const database = getDb();
  const encryptedValue = encrypt(value);

  const stmt = database.prepare(`
    INSERT INTO credentials (name, value, category, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      value = excluded.value,
      category = excluded.category,
      is_valid = 1,
      updated_at = datetime('now')
  `);

  stmt.run(name, encryptedValue, category);
}

/**
 * Obtiene una credencial desencriptada por nombre.
 */
export function getCredential(name: string): string | null {
  const database = getDb();
  const row = database.prepare("SELECT value FROM credentials WHERE name = ? AND is_valid = 1").get(name) as CredentialRow | undefined;
  if (!row) return null;

  try {
    return decrypt(row.value);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[DB] Error desencriptando credencial ${name}:`, message);
    return null;
  }
}

/**
 * Invalida una credencial.
 */
export function invalidateCredential(name: string): void {
  const database = getDb();
  database.prepare("UPDATE credentials SET is_valid = 0, updated_at = datetime('now') WHERE name = ?").run(name);
}

/**
 * Elimina todas las credenciales de una categoría.
 */
export function deleteCredentialsByCategory(category: string): void {
  const database = getDb();
  database.prepare("DELETE FROM credentials WHERE category = ?").run(category);
}

/**
 * Obtiene todas las credenciales de una categoría (nombres y metadata, sin valores).
 */
export function getCredentialNames(category: string): Omit<CredentialRow, "value">[] {
  const database = getDb();
  return database
    .prepare("SELECT name, category, is_valid, created_at, updated_at FROM credentials WHERE category = ?")
    .all(category) as Omit<CredentialRow, "value">[];
}

// ==========================================
// CRUD de Business Assets
// ==========================================

/**
 * Guarda o actualiza un asset (Facebook Page, Instagram account).
 */
export function upsertAsset(assetType: string, externalId: string, name: string, metadata: Record<string, any> = {}): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO business_assets (asset_type, external_id, name, metadata, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(external_id) DO UPDATE SET
      name = excluded.name,
      metadata = excluded.metadata,
      is_active = 1,
      updated_at = datetime('now')
  `);

  stmt.run(assetType, externalId, name, JSON.stringify(metadata));
}

/**
 * Obtiene todos los assets activos de un tipo.
 */
export function getAssetsByType(assetType: string): MetaAsset[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM business_assets WHERE asset_type = ? AND is_active = 1")
    .all(assetType) as AssetRow[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }));
}

/**
 * Obtiene todos los assets activos.
 */
export function getAllActiveAssets(): MetaAsset[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM business_assets WHERE is_active = 1 ORDER BY asset_type")
    .all() as AssetRow[];

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }));
}

/**
 * Desactiva todos los assets (para reconexión).
 */
export function deactivateAllAssets(): void {
  const database = getDb();
  database.prepare("UPDATE business_assets SET is_active = 0, updated_at = datetime('now')").run();
}

/**
 * Verifica si hay una conexión Meta válida.
 */
export function isMetaConnected(): boolean {
  const token = getCredential("META_USER_LONG_TOKEN");
  if (!token) return false;

  const assets = getAllActiveAssets();
  return assets.length > 0;
}

// ==========================================
// CRUD de Publicaciones
// ==========================================

/**
 * Guarda una publicación en la base de datos.
 * @returns La publicación creada con su id.
 */
export function createPublication({ title, content, imagePath, imageUrl, source, publishResults }: CreatePublicationInput): Publication | null {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO publications (title, content, image_path, image_url, source, publish_results, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(
    title,
    content || null,
    imagePath || null,
    imageUrl || null,
    source || "manual",
    publishResults ? JSON.stringify(publishResults) : null,
  );

  return getPublicationById(result.lastInsertRowid as number);
}

/**
 * Obtiene una publicación por ID.
 */
export function getPublicationById(id: number): Publication | null {
  const database = getDb();
  const row = database.prepare("SELECT * FROM publications WHERE id = ?").get(id) as PublicationRow | undefined;
  if (!row) return null;
  return {
    ...row,
    publish_results: row.publish_results ? JSON.parse(row.publish_results) : null,
  };
}

/**
 * Obtiene todas las publicaciones, más recientes primero.
 */
export function getAllPublications(limit: number = 50, offset: number = 0): Publication[] {
  const database = getDb();
  const rows = database
    .prepare("SELECT * FROM publications ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as PublicationRow[];

  return rows.map((row) => ({
    ...row,
    publish_results: row.publish_results ? JSON.parse(row.publish_results) : null,
  }));
}

/**
 * Elimina una publicación por ID. También borra la imagen del disco si existe.
 */
export function deletePublication(id: number): boolean {
  const database = getDb();
  const row = database.prepare("SELECT image_path FROM publications WHERE id = ?").get(id) as PublicationRow | undefined;

  if (row && row.image_path) {
    try {
      if (fs.existsSync(row.image_path)) {
        fs.unlinkSync(row.image_path);
      }
    } catch (_: unknown) {
      // Silently ignore file deletion errors
    }
  }

  const result = database.prepare("DELETE FROM publications WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Cuenta publicaciones totales.
 */
export function countPublications(): number {
  const database = getDb();
  return (database.prepare("SELECT COUNT(*) as count FROM publications").get() as CountRow).count;
}

// ==========================================
// CRUD de Transcripciones
// ==========================================

/**
 * Guarda una transcripción en la base de datos.
 * @returns La transcripción creada con su id.
 */
export function createTranscription({ text, audioFile, source, durationSeconds }: CreateTranscriptionInput): Transcription | undefined {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO transcriptions (text, audio_file, source, duration_seconds, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(
    text,
    audioFile || null,
    source || "manual",
    durationSeconds || null,
  );

  return getTranscriptionById(result.lastInsertRowid as number);
}

/**
 * Obtiene una transcripción por ID.
 */
export function getTranscriptionById(id: number): Transcription | undefined {
  const database = getDb();
  return database.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id) as Transcription | undefined;
}

/**
 * Obtiene todas las transcripciones, más recientes primero.
 */
export function getAllTranscriptions(limit: number = 50, offset: number = 0): Transcription[] {
  const database = getDb();
  return database
    .prepare("SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as Transcription[];
}

/**
 * Elimina una transcripción por ID.
 */
export function deleteTranscription(id: number): boolean {
  const database = getDb();
  const result = database.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Cuenta transcripciones totales.
 */
export function countTranscriptions(): number {
  const database = getDb();
  return (database.prepare("SELECT COUNT(*) as count FROM transcriptions").get() as CountRow).count;
}
