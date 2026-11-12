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
export * from './transmissions.js';
export * from './recordings.js';
export * from './live.js';
export * from './renderJobs.js';
export * from './assets.js';
export * from './autoPublish.js';
export * from './socialConnections.js';
export * from './publishJobs.js';
export * from './jobQueue.js';
export * from './aiUsage.js';

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
import { transmissions, scheduledTransmissions } from './transmissions.js';
import { streamRecordings, recordingSegments } from './recordings.js';
import { transcriptSegments, transmissionMoments } from './live.js';
import { clipRenderJobs } from './renderJobs.js';
import { assets } from './assets.js';
import { autoPublishConfigs } from './autoPublish.js';
import { zernioProfiles, socialConnections } from './socialConnections.js';
import { publishJobs } from './publishJobs.js';
import { aiUsageEvents } from './aiUsage.js';

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
  transmissions: many(transmissions),
  scheduledTransmissions: many(scheduledTransmissions),
  streamRecordings: many(streamRecordings),
  recordingSegments: many(recordingSegments),
  transcriptSegments: many(transcriptSegments),
  transmissionMoments: many(transmissionMoments),
  clipRenderJobs: many(clipRenderJobs),
  assets: many(assets),
  autoPublishConfigs: many(autoPublishConfigs),
  zernioProfile: one(zernioProfiles, { fields: [tenants.id], references: [zernioProfiles.tenantId] }),
  socialConnections: many(socialConnections),
  aiUsageEvents: many(aiUsageEvents),
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
  transmissions: many(transmissions),
  scheduledTransmissions: many(scheduledTransmissions),
  autoPublishConfigs: many(autoPublishConfigs),
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
export const clipsRelations = relations(clips, ({ one, many }) => ({
  tenant: one(tenants, { fields: [clips.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, {
    fields: [clips.transmissionId],
    references: [transmissions.id],
  }),
  renderJobs: many(clipRenderJobs),
}));

// ── clip_render_jobs relations (PF-04) ─────────────────────────────────────
export const clipRenderJobsRelations = relations(clipRenderJobs, ({ one }) => ({
  tenant: one(tenants, { fields: [clipRenderJobs.tenantId], references: [tenants.id] }),
  clip: one(clips, { fields: [clipRenderJobs.clipId], references: [clips.id] }),
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

// ── transmissions relations ───────────────────────────────────────────────────
export const transmissionsRelations = relations(transmissions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [transmissions.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [transmissions.programId], references: [programs.id] }),
  scheduledTransmission: one(scheduledTransmissions, {
    fields: [transmissions.scheduledTransmissionId],
    references: [scheduledTransmissions.id],
    relationName: 'ScheduledTransmissionRuns',
  }),
  // 1-a-1: stream_recordings.transmission_id es UNIQUE.
  recording: one(streamRecordings),
  transcriptSegments: many(transcriptSegments),
  moments: many(transmissionMoments),
  clips: many(clips),
  assets: many(assets),
  aiUsageEvents: many(aiUsageEvents),
}));

export const scheduledTransmissionsRelations = relations(scheduledTransmissions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [scheduledTransmissions.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [scheduledTransmissions.programId], references: [programs.id] }),
  lastTransmission: one(transmissions, {
    fields: [scheduledTransmissions.lastTransmissionId],
    references: [transmissions.id],
    relationName: 'ScheduledTransmissionLastRun',
  }),
  transmissions: many(transmissions, { relationName: 'ScheduledTransmissionRuns' }),
}));

// ── recordings relations (PD-01: crudo de video) ──────────────────────────────
export const streamRecordingsRelations = relations(streamRecordings, ({ one, many }) => ({
  tenant: one(tenants, { fields: [streamRecordings.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, {
    fields: [streamRecordings.transmissionId],
    references: [transmissions.id],
  }),
  segments: many(recordingSegments),
}));

export const recordingSegmentsRelations = relations(recordingSegments, ({ one }) => ({
  tenant: one(tenants, { fields: [recordingSegments.tenantId], references: [tenants.id] }),
  recording: one(streamRecordings, {
    fields: [recordingSegments.recordingId],
    references: [streamRecordings.id],
  }),
}));

// ── live room relations (PD-05) ───────────────────────────────────────────────
export const transcriptSegmentsRelations = relations(transcriptSegments, ({ one }) => ({
  tenant: one(tenants, { fields: [transcriptSegments.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, {
    fields: [transcriptSegments.transmissionId],
    references: [transmissions.id],
  }),
  person: one(persons, {
    fields: [transcriptSegments.personId],
    references: [persons.id],
  }),
}));

export const transmissionMomentsRelations = relations(transmissionMoments, ({ one }) => ({
  tenant: one(tenants, { fields: [transmissionMoments.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, {
    fields: [transmissionMoments.transmissionId],
    references: [transmissions.id],
  }),
  clip: one(clips, {
    fields: [transmissionMoments.clipId],
    references: [clips.id],
  }),
}));

// ── assets relations (PF-10: ledger editorial unificado) ────────────────────
export const assetsRelations = relations(assets, ({ one, many }) => ({
  tenant: one(tenants, { fields: [assets.tenantId], references: [tenants.id] }),
  // Self-FK: flyer→nota, variant/post→padre. relationName obligatorio
  // porque las dos puntas de la relación son la misma tabla.
  parent: one(assets, {
    fields: [assets.parentAssetId],
    references: [assets.id],
    relationName: 'AssetChildren',
  }),
  children: many(assets, { relationName: 'AssetChildren' }),
  transmission: one(transmissions, {
    fields: [assets.transmissionId],
    references: [transmissions.id],
  }),
}));

// ── auto_publish_configs relations (PG-03) ──────────────────────────────────
export const autoPublishConfigsRelations = relations(autoPublishConfigs, ({ one }) => ({
  tenant: one(tenants, { fields: [autoPublishConfigs.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [autoPublishConfigs.programId], references: [programs.id] }),
}));

// ── zernio_profiles / social_connections relations (PG-04) ───────────────────
export const zernioProfilesRelations = relations(zernioProfiles, ({ one }) => ({
  tenant: one(tenants, { fields: [zernioProfiles.tenantId], references: [tenants.id] }),
}));

export const socialConnectionsRelations = relations(socialConnections, ({ one }) => ({
  tenant: one(tenants, { fields: [socialConnections.tenantId], references: [tenants.id] }),
}));

// ── ai_usage_events relations (PI-03) ───────────────────────────────────────
export const aiUsageEventsRelations = relations(aiUsageEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [aiUsageEvents.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, {
    fields: [aiUsageEvents.transmissionId],
    references: [transmissions.id],
  }),
}));

// ── publish_jobs relations (PG-05) ────────────────────────────────────────────
export const publishJobsRelations = relations(publishJobs, ({ one }) => ({
  tenant: one(tenants, { fields: [publishJobs.tenantId], references: [tenants.id] }),
  asset: one(assets, { fields: [publishJobs.assetId], references: [assets.id] }),
  publication: one(publications, {
    fields: [publishJobs.publicationId],
    references: [publications.id],
  }),
  connection: one(socialConnections, {
    fields: [publishJobs.connectionId],
    references: [socialConnections.id],
  }),
}));
