import { pgTable, uuid, varchar, text, boolean, integer, real, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const customAgents = pgTable(
  'custom_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    systemPrompt: text('system_prompt').notNull(),
    position: integer('position').notNull().default(0),
    afterStep: varchar('after_step', { length: 50 }),
    isEnabled: boolean('is_enabled').notNull().default(true),
    aiProvider: varchar('ai_provider', { length: 50 }).notNull().default('auto'),
    temperature: real('temperature').notNull().default(0.7),
    maxTokens: integer('max_tokens').notNull().default(2000),
    tools: jsonb('tools').notNull().default([]),
    templateId: varchar('template_id', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [index('custom_agents_tenant_id_idx').on(t.tenantId)],
);

export const pipelineConfigs = pgTable(
  'pipeline_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull().default('default'),
    nodeOrder: jsonb('node_order').notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdateFn(() => new Date()),
  },
  (t) => [index('pipeline_configs_tenant_id_idx').on(t.tenantId)],
);
