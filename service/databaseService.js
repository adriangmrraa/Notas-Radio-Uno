import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { encrypt, decrypt } from "./encryptionService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = path.join(__dirname, "..", "data", "credentials.db");

let db = null;

/**
 * Inicializa la base de datos SQLite con las tablas necesarias.
 * Inspirado en el schema de credentials de Platform ROI.
 */
export function initDatabase() {
  // Crear directorio data/ si no existe
  const dataDir = path.join(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(DB_PATH);

  // Habilitar WAL mode para mejor performance
  db.pragma("journal_mode = WAL");

  // Tabla de credenciales encriptadas (inspirada en Platform ROI)
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

  console.log("[DB] Base de datos SQLite inicializada en", DB_PATH);
  return db;
}

/**
 * Obtiene la instancia de la base de datos.
 */
export function getDb() {
  if (!db) {
    initDatabase();
  }
  return db;
}

// ==========================================
// CRUD de Credenciales (encriptadas)
// ==========================================

/**
 * Guarda o actualiza una credencial encriptada.
 */
export function setCredential(name, value, category = "meta") {
  const db = getDb();
  const encryptedValue = encrypt(value);

  const stmt = db.prepare(`
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
export function getCredential(name) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM credentials WHERE name = ? AND is_valid = 1").get(name);
  if (!row) return null;

  try {
    return decrypt(row.value);
  } catch (error) {
    console.error(`[DB] Error desencriptando credencial ${name}:`, error.message);
    return null;
  }
}

/**
 * Invalida una credencial.
 */
export function invalidateCredential(name) {
  const db = getDb();
  db.prepare("UPDATE credentials SET is_valid = 0, updated_at = datetime('now') WHERE name = ?").run(name);
}

/**
 * Elimina todas las credenciales de una categoría.
 */
export function deleteCredentialsByCategory(category) {
  const db = getDb();
  db.prepare("DELETE FROM credentials WHERE category = ?").run(category);
}

/**
 * Obtiene todas las credenciales de una categoría (nombres y metadata, sin valores).
 */
export function getCredentialNames(category) {
  const db = getDb();
  return db
    .prepare("SELECT name, category, is_valid, created_at, updated_at FROM credentials WHERE category = ?")
    .all(category);
}

// ==========================================
// CRUD de Business Assets
// ==========================================

/**
 * Guarda o actualiza un asset (Facebook Page, Instagram account).
 */
export function upsertAsset(assetType, externalId, name, metadata = {}) {
  const db = getDb();
  const stmt = db.prepare(`
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
export function getAssetsByType(assetType) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM business_assets WHERE asset_type = ? AND is_active = 1")
    .all(assetType);

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }));
}

/**
 * Obtiene todos los assets activos.
 */
export function getAllActiveAssets() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM business_assets WHERE is_active = 1 ORDER BY asset_type")
    .all();

  return rows.map((row) => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }));
}

/**
 * Desactiva todos los assets (para reconexión).
 */
export function deactivateAllAssets() {
  const db = getDb();
  db.prepare("UPDATE business_assets SET is_active = 0, updated_at = datetime('now')").run();
}

/**
 * Verifica si hay una conexión Meta válida.
 */
export function isMetaConnected() {
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
 * @returns {object} La publicación creada con su id.
 */
export function createPublication({ title, content, imagePath, imageUrl, source, publishResults }) {
  const db = getDb();
  const stmt = db.prepare(`
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

  return getPublicationById(result.lastInsertRowid);
}

/**
 * Obtiene una publicación por ID.
 */
export function getPublicationById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM publications WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    publish_results: row.publish_results ? JSON.parse(row.publish_results) : null,
  };
}

/**
 * Obtiene todas las publicaciones, más recientes primero.
 */
export function getAllPublications(limit = 50, offset = 0) {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM publications ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset);

  return rows.map((row) => ({
    ...row,
    publish_results: row.publish_results ? JSON.parse(row.publish_results) : null,
  }));
}

/**
 * Elimina una publicación por ID. También borra la imagen del disco si existe.
 */
export function deletePublication(id) {
  const db = getDb();
  const row = db.prepare("SELECT image_path FROM publications WHERE id = ?").get(id);

  if (row && row.image_path) {
    try {
      if (fs.existsSync(row.image_path)) {
        fs.unlinkSync(row.image_path);
      }
    } catch (_) {}
  }

  const result = db.prepare("DELETE FROM publications WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Cuenta publicaciones totales.
 */
export function countPublications() {
  const db = getDb();
  return db.prepare("SELECT COUNT(*) as count FROM publications").get().count;
}

// ==========================================
// CRUD de Transcripciones
// ==========================================

/**
 * Guarda una transcripción en la base de datos.
 * @returns {object} La transcripción creada con su id.
 */
export function createTranscription({ text, audioFile, source, durationSeconds }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO transcriptions (text, audio_file, source, duration_seconds, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `);

  const result = stmt.run(
    text,
    audioFile || null,
    source || "manual",
    durationSeconds || null,
  );

  return getTranscriptionById(result.lastInsertRowid);
}

/**
 * Obtiene una transcripción por ID.
 */
export function getTranscriptionById(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM transcriptions WHERE id = ?").get(id);
}

/**
 * Obtiene todas las transcripciones, más recientes primero.
 */
export function getAllTranscriptions(limit = 50, offset = 0) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset);
}

/**
 * Elimina una transcripción por ID.
 */
export function deleteTranscription(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM transcriptions WHERE id = ?").run(id);
  return result.changes > 0;
}

/**
 * Cuenta transcripciones totales.
 */
export function countTranscriptions() {
  const db = getDb();
  return db.prepare("SELECT COUNT(*) as count FROM transcriptions").get().count;
}
