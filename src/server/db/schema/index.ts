import { relations } from 'drizzle-orm';

// ── Re-exports ────────────────────────────────────────────────────────────────
export * from './enums.js';
export * from './tenants.js';
export * from './users.js';
export * from './credentials.js';
export * from './publications.js';
export * from './agents.js';
export * from './billing.js';
export * from './jobs.js';
export * from './social.js';
export * from './misc.js';
export * from './customTypes.js';
export * from './programs.js';
export * from './conductors.js';

// ── Import tables for relations ───────────────────────────────────────────────
import { tenants } from './tenants.js';
import { users } from './users.js';
import { credentials } from './credentials.js';
import { publications, transcriptions } from './publications.js';
import { customAgents, pipelineConfigs } from './agents.js';
import { plans, subscriptions, usageRecords, invoices } from './billing.js';
import { scheduledJobs, jobExecutions } from './jobs.js';
import { socialPortfolios, businessAssets } from './social.js';
import { settings, notifications, auditLog, dailyMetrics, teamInvitations, refreshTokens } from './misc.js';
import { programs, programUrls } from './programs.js';
import { conductors, conductorPhotos } from './conductors.js';

// ── tenants relations ─────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  owner: one(users, { fields: [tenants.ownerId], references: [users.id], relationName: 'TenantOwner' }),
  users: many(users, { relationName: 'TenantUsers' }),
  credentials: many(credentials),
  businessAssets: many(businessAssets),
  socialPortfolios: many(socialPortfolios),
  publications: many(publications),
  transcriptions: many(transcriptions),
  settings: many(settings),
  customAgents: many(customAgents),
  pipelineConfigs: many(pipelineConfigs),
  subscription: one(subscriptions, { fields: [tenants.id], references: [subscriptions.tenantId] }),
  usageRecords: many(usageRecords),
  invoices: many(invoices),
  scheduledJobs: many(scheduledJobs),
  jobExecutions: many(jobExecutions),
  dailyMetrics: many(dailyMetrics),
  teamInvitations: many(teamInvitations),
  auditLogs: many(auditLog),
  refreshTokens: many(refreshTokens),
  notifications: many(notifications),
  programs: many(programs),
  conductors: many(conductors),
}));

// ── users relations ───────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id], relationName: 'TenantUsers' }),
  ownedTenants: many(tenants, { relationName: 'TenantOwner' }),
  refreshTokens: many(refreshTokens),
  auditLogs: many(auditLog),
  scheduledJobs: many(scheduledJobs, { relationName: 'JobCreator' }),
  invitationsSent: many(teamInvitations, { relationName: 'InvitedBy' }),
}));

// ── credentials relations ─────────────────────────────────────────────────────
export const credentialsRelations = relations(credentials, ({ one }) => ({
  tenant: one(tenants, { fields: [credentials.tenantId], references: [tenants.id] }),
}));

// ── publications relations ────────────────────────────────────────────────────
export const publicationsRelations = relations(publications, ({ one }) => ({
  tenant: one(tenants, { fields: [publications.tenantId], references: [tenants.id] }),
}));

export const transcriptionsRelations = relations(transcriptions, ({ one }) => ({
  tenant: one(tenants, { fields: [transcriptions.tenantId], references: [tenants.id] }),
}));

// ── agents relations ──────────────────────────────────────────────────────────
export const customAgentsRelations = relations(customAgents, ({ one }) => ({
  tenant: one(tenants, { fields: [customAgents.tenantId], references: [tenants.id] }),
}));

export const pipelineConfigsRelations = relations(pipelineConfigs, ({ one }) => ({
  tenant: one(tenants, { fields: [pipelineConfigs.tenantId], references: [tenants.id] }),
}));

// ── billing relations ─────────────────────────────────────────────────────────
export const plansRelations = relations(plans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [subscriptions.tenantId], references: [tenants.id] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
  invoices: many(invoices),
}));

export const usageRecordsRelations = relations(usageRecords, ({ one }) => ({
  tenant: one(tenants, { fields: [usageRecords.tenantId], references: [tenants.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  tenant: one(tenants, { fields: [invoices.tenantId], references: [tenants.id] }),
  subscription: one(subscriptions, { fields: [invoices.subscriptionId], references: [subscriptions.id] }),
}));

// ── jobs relations ────────────────────────────────────────────────────────────
export const scheduledJobsRelations = relations(scheduledJobs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [scheduledJobs.tenantId], references: [tenants.id] }),
  createdBy: one(users, { fields: [scheduledJobs.createdById], references: [users.id], relationName: 'JobCreator' }),
  executions: many(jobExecutions),
}));

export const jobExecutionsRelations = relations(jobExecutions, ({ one }) => ({
  job: one(scheduledJobs, { fields: [jobExecutions.jobId], references: [scheduledJobs.id] }),
  tenant: one(tenants, { fields: [jobExecutions.tenantId], references: [tenants.id] }),
}));

// ── social relations ──────────────────────────────────────────────────────────
export const socialPortfoliosRelations = relations(socialPortfolios, ({ one, many }) => ({
  tenant: one(tenants, { fields: [socialPortfolios.tenantId], references: [tenants.id] }),
  assets: many(businessAssets),
}));

export const businessAssetsRelations = relations(businessAssets, ({ one }) => ({
  tenant: one(tenants, { fields: [businessAssets.tenantId], references: [tenants.id] }),
  portfolio: one(socialPortfolios, { fields: [businessAssets.portfolioId], references: [socialPortfolios.id] }),
}));

// ── misc relations ────────────────────────────────────────────────────────────
export const settingsRelations = relations(settings, ({ one }) => ({
  tenant: one(tenants, { fields: [settings.tenantId], references: [tenants.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  tenant: one(tenants, { fields: [notifications.tenantId], references: [tenants.id] }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  tenant: one(tenants, { fields: [auditLog.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [auditLog.userId], references: [users.id] }),
}));

export const dailyMetricsRelations = relations(dailyMetrics, ({ one }) => ({
  tenant: one(tenants, { fields: [dailyMetrics.tenantId], references: [tenants.id] }),
}));

export const teamInvitationsRelations = relations(teamInvitations, ({ one }) => ({
  tenant: one(tenants, { fields: [teamInvitations.tenantId], references: [tenants.id] }),
  invitedBy: one(users, { fields: [teamInvitations.invitedById], references: [users.id], relationName: 'InvitedBy' }),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, { fields: [refreshTokens.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [refreshTokens.tenantId], references: [tenants.id] }),
}));

// ── programs relations ────────────────────────────────────────────────────────
export const programsRelations = relations(programs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [programs.tenantId], references: [tenants.id] }),
  urls: many(programUrls),
  conductors: many(conductors),
}));

export const programUrlsRelations = relations(programUrls, ({ one }) => ({
  program: one(programs, { fields: [programUrls.programId], references: [programs.id] }),
}));

// ── conductors relations ──────────────────────────────────────────────────────
export const conductorsRelations = relations(conductors, ({ one, many }) => ({
  tenant: one(tenants, { fields: [conductors.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [conductors.programId], references: [programs.id] }),
  photos: many(conductorPhotos),
}));

export const conductorPhotosRelations = relations(conductorPhotos, ({ one }) => ({
  conductor: one(conductors, { fields: [conductorPhotos.conductorId], references: [conductors.id] }),
}));
