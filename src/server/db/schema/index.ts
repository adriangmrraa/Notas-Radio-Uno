import { relations } from 'drizzle-orm';

// ── Re-exports ────────────────────────────────────────────────────────────────
export * from './enums.js';
export * from './tenants.js';
export * from './users.js';
export * from './userTenants.js';
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
export * from './guests.js';
export * from './dossiers.js';
export * from './clips.js';
export * from './features.js';
export * from './persons.js';
export * from './editorialProfiles.js';

// ── Import tables for relations ───────────────────────────────────────────────
import { tenants } from './tenants.js';
import { users } from './users.js';
import { userTenants } from './userTenants.js';
import { credentials } from './credentials.js';
import { publications, transcriptions } from './publications.js';
import { customAgents, pipelineConfigs } from './agents.js';
import {
  plans,
  subscriptions,
  usageRecords,
  invoices,
  usageCycles,
  quotaOperations,
  planAddons,
  addonPurchases,
  billingEvents,
} from './billing.js';
import { scheduledJobs, jobExecutions } from './jobs.js';
import { socialPortfolios, businessAssets } from './social.js';
import { settings, notifications, auditLog, dailyMetrics, teamInvitations, refreshTokens } from './misc.js';
import { programs, programUrls } from './programs.js';
import { conductors, conductorPhotos } from './conductors.js';
import { guests, guestPhotos } from './guests.js';
import { guestDossiers } from './dossiers.js';
import { clips } from './clips.js';
import { tenantFeatures, impersonationSessions } from './features.js';
import { persons, personPhotos, faceEmbeddings, personProgram } from './persons.js';
import { editorialProfiles } from './editorialProfiles.js';

// ── tenants relations ─────────────────────────────────────────────────────────
export const tenantsRelations = relations(tenants, ({ one, many }) => ({
  owner: one(users, { fields: [tenants.ownerId], references: [users.id], relationName: 'TenantOwner' }),
  users: many(users, { relationName: 'TenantUsers' }),
  memberships: many(userTenants),
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
  guests: many(guests),
  guestDossiers: many(guestDossiers),
  clips: many(clips),
  features: many(tenantFeatures),
  usageCycles: many(usageCycles),
  quotaOperations: many(quotaOperations),
  addonPurchases: many(addonPurchases),
  billingEvents: many(billingEvents),
  persons: many(persons),
  personPhotos: many(personPhotos),
  faceEmbeddings: many(faceEmbeddings),
  personPrograms: many(personProgram),
  editorialProfiles: many(editorialProfiles),
}));

// ── users relations ───────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id], relationName: 'TenantUsers' }),
  memberships: many(userTenants),
  ownedTenants: many(tenants, { relationName: 'TenantOwner' }),
  refreshTokens: many(refreshTokens),
  auditLogs: many(auditLog),
  scheduledJobs: many(scheduledJobs, { relationName: 'JobCreator' }),
  invitationsSent: many(teamInvitations, { relationName: 'InvitedBy' }),
}));

// ── user_tenants relations (membresías N:M) ───────────────────────────────────
export const userTenantsRelations = relations(userTenants, ({ one }) => ({
  user: one(users, { fields: [userTenants.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [userTenants.tenantId], references: [tenants.id] }),
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

export const usageCyclesRelations = relations(usageCycles, ({ one, many }) => ({
  tenant: one(tenants, { fields: [usageCycles.tenantId], references: [tenants.id] }),
  quotaOperations: many(quotaOperations),
  addonPurchases: many(addonPurchases),
}));

export const quotaOperationsRelations = relations(quotaOperations, ({ one }) => ({
  tenant: one(tenants, { fields: [quotaOperations.tenantId], references: [tenants.id] }),
  usageCycle: one(usageCycles, { fields: [quotaOperations.usageCycleId], references: [usageCycles.id] }),
}));

export const planAddonsRelations = relations(planAddons, ({ many }) => ({
  purchases: many(addonPurchases),
}));

export const addonPurchasesRelations = relations(addonPurchases, ({ one }) => ({
  tenant: one(tenants, { fields: [addonPurchases.tenantId], references: [tenants.id] }),
  usageCycle: one(usageCycles, { fields: [addonPurchases.usageCycleId], references: [usageCycles.id] }),
  addon: one(planAddons, { fields: [addonPurchases.addonId], references: [planAddons.id] }),
}));

export const billingEventsRelations = relations(billingEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [billingEvents.tenantId], references: [tenants.id] }),
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
  guests: many(guests),
  guestDossiers: many(guestDossiers),
  personPrograms: many(personProgram),
  editorialProfiles: many(editorialProfiles),
}));

export const programUrlsRelations = relations(programUrls, ({ one }) => ({
  program: one(programs, { fields: [programUrls.programId], references: [programs.id] }),
}));

// ── conductors relations ──────────────────────────────────────────────────────
export const conductorsRelations = relations(conductors, ({ one, many }) => ({
  tenant: one(tenants, { fields: [conductors.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [conductors.programId], references: [programs.id] }),
  person: one(persons, { fields: [conductors.personId], references: [persons.id] }),
  photos: many(conductorPhotos),
}));

export const conductorPhotosRelations = relations(conductorPhotos, ({ one }) => ({
  conductor: one(conductors, { fields: [conductorPhotos.conductorId], references: [conductors.id] }),
}));

// ── guests relations ──────────────────────────────────────────────────────────
export const guestsRelations = relations(guests, ({ one, many }) => ({
  tenant: one(tenants, { fields: [guests.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [guests.programId], references: [programs.id] }),
  person: one(persons, { fields: [guests.personId], references: [persons.id] }),
  photos: many(guestPhotos),
  dossiers: many(guestDossiers),
}));

export const guestPhotosRelations = relations(guestPhotos, ({ one }) => ({
  guest: one(guests, { fields: [guestPhotos.guestId], references: [guests.id] }),
}));

// ── dossiers relations ──────────────────────────────────────────────────────
export const guestDossiersRelations = relations(guestDossiers, ({ one }) => ({
  guest: one(guests, { fields: [guestDossiers.guestId], references: [guests.id] }),
  tenant: one(tenants, { fields: [guestDossiers.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [guestDossiers.programId], references: [programs.id] }),
}));

// ── clips relations ───────────────────────────────────────────────────────────
export const clipsRelations = relations(clips, ({ one }) => ({
  tenant: one(tenants, { fields: [clips.tenantId], references: [tenants.id] }),
}));

// ── features relations ────────────────────────────────────────────────────────
export const tenantFeaturesRelations = relations(tenantFeatures, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantFeatures.tenantId], references: [tenants.id] }),
  plan: one(plans, { fields: [tenantFeatures.planId], references: [plans.id] }),
  overriddenBy: one(users, { fields: [tenantFeatures.overriddenByUserId], references: [users.id] }),
}));

export const impersonationSessionsRelations = relations(impersonationSessions, ({ one }) => ({
  admin: one(users, {
    fields: [impersonationSessions.adminUserId],
    references: [users.id],
    relationName: 'ImpersonationAdmin',
  }),
  tenant: one(tenants, { fields: [impersonationSessions.tenantId], references: [tenants.id] }),
}));

// ── persons relations ─────────────────────────────────────────────────────────
export const personsRelations = relations(persons, ({ one, many }) => ({
  tenant: one(tenants, { fields: [persons.tenantId], references: [tenants.id] }),
  photos: many(personPhotos),
  embeddings: many(faceEmbeddings, { relationName: 'PersonEmbeddings' }),
  canonicalEmbedding: one(faceEmbeddings, {
    fields: [persons.embeddingRef],
    references: [faceEmbeddings.id],
    relationName: 'PersonCanonicalEmbedding',
  }),
  programs: many(personProgram),
}));

export const personPhotosRelations = relations(personPhotos, ({ one, many }) => ({
  tenant: one(tenants, { fields: [personPhotos.tenantId], references: [tenants.id] }),
  person: one(persons, { fields: [personPhotos.personId], references: [persons.id] }),
  embeddings: many(faceEmbeddings),
}));

export const faceEmbeddingsRelations = relations(faceEmbeddings, ({ one }) => ({
  tenant: one(tenants, { fields: [faceEmbeddings.tenantId], references: [tenants.id] }),
  person: one(persons, {
    fields: [faceEmbeddings.personId],
    references: [persons.id],
    relationName: 'PersonEmbeddings',
  }),
  photo: one(personPhotos, { fields: [faceEmbeddings.personPhotoId], references: [personPhotos.id] }),
}));

export const personProgramRelations = relations(personProgram, ({ one }) => ({
  tenant: one(tenants, { fields: [personProgram.tenantId], references: [tenants.id] }),
  person: one(persons, { fields: [personProgram.personId], references: [persons.id] }),
  program: one(programs, { fields: [personProgram.programId], references: [programs.id] }),
  createdBy: one(users, { fields: [personProgram.createdByUserId], references: [users.id] }),
}));

// ── editorial_profiles relations ──────────────────────────────────────────────
export const editorialProfilesRelations = relations(editorialProfiles, ({ one }) => ({
  tenant: one(tenants, { fields: [editorialProfiles.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [editorialProfiles.programId], references: [programs.id] }),
}));
