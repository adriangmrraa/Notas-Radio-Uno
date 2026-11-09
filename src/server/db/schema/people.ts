import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { programs } from './programs.js';
import { bytea } from './customTypes.js';

// ── persons — biblioteca unificada de personas (conductors + guests legacy) ───
export const personRoleValues = ['conductor', 'columnista', 'invitado', 'produccion'] as const;
export type PersonRole = (typeof personRoleValues)[number];

export const personEnrollmentStatusValues = ['none', 'partial', 'ready'] as const;
export type PersonEnrollmentStatus = (typeof personEnrollmentStatusValues)[number];

export const persons = pgTable(
  'persons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    role: varchar('role', { length: 50 }).$type<PersonRole>(),
    bio: text('bio'),
    socials: jsonb('socials').notNull().default({}),
    notes: text('notes'),
    enrollmentStatus: varchar('enrollment_status', { length: 20 })
      .notNull()
      .default('none')
      .$type<PersonEnrollmentStatus>(),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('persons_tenant_id_idx').on(t.tenantId),
  ],
);

// ── person_photos — fotos para enrolamiento facial ────────────────────────────
export const photoEnrollmentStatusValues = ['pending', 'enrolled', 'no_face', 'multi_face', 'error'] as const;
export type PhotoEnrollmentStatus = (typeof photoEnrollmentStatusValues)[number];

export const personPhotos = pgTable(
  'person_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    photoData: bytea('photo_data').notNull(),
    mimeType: varchar('mime_type', { length: 20 }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    enrollmentStatus: varchar('enrollment_status', { length: 20 })
      .notNull()
      .default('pending')
      .$type<PhotoEnrollmentStatus>(),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('person_photos_person_id_idx').on(t.personId),
  ],
);

// ── face_embeddings — embeddings faciales por persona ─────────────────────────
// GATE-1 fallback: embedding como jsonb float[512] + cosine en app (ver
// sdd/live-creator-platform/design/gate1-pgvector.md). Si pgvector se confirma
// en staging, migración futura convierte a vector(512) + hnsw.
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
    photoId: uuid('photo_id').references(() => personPhotos.id, { onDelete: 'cascade' }),
    embedding: jsonb('embedding').notNull().$type<number[]>(),
    model: varchar('model', { length: 50 }).notNull().default('buffalo_l'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('face_embeddings_tenant_id_idx').on(t.tenantId),
    index('face_embeddings_person_id_idx').on(t.personId),
  ],
);

// ── person_program — M2M persona↔programa ─────────────────────────────────────
export const personProgram = pgTable(
  'person_program',
  {
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.programId] }),
    index('person_program_program_id_idx').on(t.programId),
  ],
);
