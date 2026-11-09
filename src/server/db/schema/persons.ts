import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  integer,
  real,
  jsonb,
  index,
  uniqueIndex,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { users } from './users.js';
import { bytea } from './customTypes.js';
import { personRoleEnum, faceEnrollmentStatusEnum } from './enums.js';

/**
 * persons — biblioteca única de personas del canal.
 *
 * Reemplaza el modelo anterior (conductors + guests separados): una persona
 * existe una sola vez por tenant y se asocia a uno o más programas vía
 * `person_program`. `embedding_ref` apunta al embedding "canónico" que se usa
 * para reconocerla en el video (enrolled-only, con consentimiento explícito).
 */
export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    roleLabel: varchar('role_label', { length: 120 }),
    role: personRoleEnum('role').notNull().default('conductor'),
    bio: text('bio'),
    notes: text('notes'),
    /** Redes y contacto: { twitter, instagram, linkedin, x, web, email, ... } */
    socialLinks: jsonb('social_links').notNull().default({}),
    /** ID del embedding canónico en face_embeddings (se completa al enrolar). */
    embeddingRef: uuid('embedding_ref').references(
      (): AnyPgColumn => faceEmbeddings.id,
      { onDelete: 'set null' },
    ),
    faceStatus: faceEnrollmentStatusEnum('face_status').notNull().default('pending'),
    consentGiven: boolean('consent_given').notNull().default(false),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('persons_tenant_id_idx').on(t.tenantId),
    index('persons_embedding_ref_idx').on(t.embeddingRef),
    index('persons_tenant_active_idx').on(t.tenantId, t.isActive),
    index('persons_tenant_role_idx').on(t.tenantId, t.role),
    index('persons_tenant_name_idx').on(t.tenantId, t.name),
  ],
);

/**
 * person_photos — fotos de referencia de una persona (multi-foto).
 * `face_detected`/`face_count` los completa el pipeline de rostros.
 */
export const personPhotos = pgTable(
  'person_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    photoData: bytea('photo_data').notNull(),
    mimeType: varchar('mime_type', { length: 40 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    faceDetected: boolean('face_detected').notNull().default(false),
    faceCount: integer('face_count').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('person_photos_tenant_id_idx').on(t.tenantId),
    index('person_photos_person_id_idx').on(t.personId),
  ],
);

/**
 * face_embeddings — embeddings de rostro (InsightFace ArcFace, 512 dims).
 * La columna `embedding` es `vector(512)` (pgvector). La migración crea la
 * extensión y un índice HNSW para búsqueda por similitud coseno.
 */
export const faceEmbeddings = pgTable(
  'face_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    personPhotoId: uuid('person_photo_id')
      .notNull()
      .references(() => personPhotos.id, { onDelete: 'cascade' }),
    model: varchar('model', { length: 80 }).notNull().default('insightface-buffalo_l'),
    dimensions: integer('dimensions').notNull().default(512),
    embedding: vector('embedding', { dimensions: 512 }).notNull(),
    detScore: real('det_score'),
    quality: real('quality'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('face_embeddings_tenant_id_idx').on(t.tenantId),
    index('face_embeddings_person_id_idx').on(t.personId),
    index('face_embeddings_person_photo_id_idx').on(t.personPhotoId),
  ],
);

/** person_program — N:M persona↔programa (con rol en ese programa). */
export const personProgram = pgTable(
  'person_program',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    roleOnProgram: varchar('role_on_program', { length: 80 }),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('person_program_person_program_unique').on(t.personId, t.programId),
    index('person_program_tenant_id_idx').on(t.tenantId),
    index('person_program_program_id_idx').on(t.programId),
    index('person_program_created_by_user_id_idx').on(t.createdByUserId),
  ],
);
