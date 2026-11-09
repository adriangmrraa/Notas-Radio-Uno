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
export * from './guests.js';
export * from './dossiers.js';
export * from './clips.js';
export * from './people.js';
export * from './transmissions.js';
export * from './editorial.js';
export * from './saas.js';
export * from './assets.js';

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
import { guests, guestPhotos } from './guests.js';
import { guestDossiers } from './dossiers.js';
import { clips } from './clips.js';
import { persons, personPhotos, faceEmbeddings, personProgram } from './people.js';
import {
  transmissions,
  streamRecordings,
  recordingSegments,
  transmissionSegments,
  personAppearances,
  personTransmission,
} from './transmissions.js';
import { editorialProfiles, editorialProfileVersions } from './editorial.js';
import {
  userTenants,
  tenantQuotas,
  quotaOperations,
  billingEvents,
  tenantFeatures,
  jobsQueue,
  aiCostRecords,
  adminImpersonations,
} from './saas.js';
import { assets, assetPersons, socialConnections, publishJobs } from './assets.js';

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
  guests: many(guests),
  guestDossiers: many(guestDossiers),
  clips: many(clips),
  persons: many(persons),
  faceEmbeddings: many(faceEmbeddings),
  transmissions: many(transmissions),
  transmissionSegments: many(transmissionSegments),
  personAppearances: many(personAppearances),
  personTransmissions: many(personTransmission),
  editorialProfile: one(editorialProfiles, { fields: [tenants.id], references: [editorialProfiles.tenantId] }),
  memberships: many(userTenants),
  tenantQuotas: many(tenantQuotas),
  quotaOperations: many(quotaOperations),
  billingEvents: many(billingEvents),
  tenantFeatures: many(tenantFeatures),
  queueJobs: many(jobsQueue),
  aiCostRecords: many(aiCostRecords),
  adminImpersonations: many(adminImpersonations),
  assets: many(assets),
  socialConnections: many(socialConnections),
  publishJobs: many(publishJobs),
}));

// ── users relations ───────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id], relationName: 'TenantUsers' }),
  ownedTenants: many(tenants, { relationName: 'TenantOwner' }),
  refreshTokens: many(refreshTokens),
  auditLogs: many(auditLog),
  scheduledJobs: many(scheduledJobs, { relationName: 'JobCreator' }),
  invitationsSent: many(teamInvitations, { relationName: 'InvitedBy' }),
  memberships: many(userTenants),
  adminImpersonations: many(adminImpersonations),
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
  transmission: one(transmissions, { fields: [jobExecutions.transmissionId], references: [transmissions.id] }),
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

// ── guests relations ──────────────────────────────────────────────────────────
export const guestsRelations = relations(guests, ({ one, many }) => ({
  tenant: one(tenants, { fields: [guests.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [guests.programId], references: [programs.id] }),
  photos: many(guestPhotos),
  dossiers: many(guestDossiers),
}));

export const guestPhotosRelations = relations(guestPhotos, ({ one }) => ({
  guest: one(guests, { fields: [guestPhotos.guestId], references: [guests.id] }),
}));

// ── dossiers relations ──────────────────────────────────────────────────────
export const guestDossiersRelations = relations(guestDossiers, ({ one }) => ({
  guest: one(guests, { fields: [guestDossiers.guestId], references: [guests.id] }),
  person: one(persons, { fields: [guestDossiers.personId], references: [persons.id] }),
  tenant: one(tenants, { fields: [guestDossiers.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [guestDossiers.programId], references: [programs.id] }),
}));

// ── clips relations ───────────────────────────────────────────────────────────
export const clipsRelations = relations(clips, ({ one }) => ({
  tenant: one(tenants, { fields: [clips.tenantId], references: [tenants.id] }),
}));

// ── people relations ──────────────────────────────────────────────────────────
export const personsRelations = relations(persons, ({ one, many }) => ({
  tenant: one(tenants, { fields: [persons.tenantId], references: [tenants.id] }),
  photos: many(personPhotos),
  embeddings: many(faceEmbeddings),
  programs: many(personProgram),
  transmissionInvites: many(personTransmission),
  appearances: many(personAppearances),
}));

export const personPhotosRelations = relations(personPhotos, ({ one, many }) => ({
  person: one(persons, { fields: [personPhotos.personId], references: [persons.id] }),
  embeddings: many(faceEmbeddings),
}));

export const faceEmbeddingsRelations = relations(faceEmbeddings, ({ one }) => ({
  tenant: one(tenants, { fields: [faceEmbeddings.tenantId], references: [tenants.id] }),
  person: one(persons, { fields: [faceEmbeddings.personId], references: [persons.id] }),
  photo: one(personPhotos, { fields: [faceEmbeddings.photoId], references: [personPhotos.id] }),
}));

export const personProgramRelations = relations(personProgram, ({ one }) => ({
  person: one(persons, { fields: [personProgram.personId], references: [persons.id] }),
  program: one(programs, { fields: [personProgram.programId], references: [programs.id] }),
}));

export const personTransmissionRelations = relations(personTransmission, ({ one }) => ({
  tenant: one(tenants, { fields: [personTransmission.tenantId], references: [tenants.id] }),
  person: one(persons, { fields: [personTransmission.personId], references: [persons.id] }),
  transmission: one(transmissions, { fields: [personTransmission.transmissionId], references: [transmissions.id] }),
  program: one(programs, { fields: [personTransmission.programId], references: [programs.id] }),
}));

// ── transmissions relations ───────────────────────────────────────────────────
export const transmissionsRelations = relations(transmissions, ({ one, many }) => ({
  tenant: one(tenants, { fields: [transmissions.tenantId], references: [tenants.id] }),
  program: one(programs, { fields: [transmissions.programId], references: [programs.id] }),
  scheduledJob: one(scheduledJobs, { fields: [transmissions.scheduledJobId], references: [scheduledJobs.id] }),
  recording: one(streamRecordings, { fields: [transmissions.id], references: [streamRecordings.transmissionId] }),
  segments: many(transmissionSegments),
  appearances: many(personAppearances),
  guestInvites: many(personTransmission),
  jobExecutions: many(jobExecutions),
}));

export const streamRecordingsRelations = relations(streamRecordings, ({ one, many }) => ({
  transmission: one(transmissions, { fields: [streamRecordings.transmissionId], references: [transmissions.id] }),
  segments: many(recordingSegments),
}));

export const recordingSegmentsRelations = relations(recordingSegments, ({ one }) => ({
  recording: one(streamRecordings, { fields: [recordingSegments.recordingId], references: [streamRecordings.id] }),
}));

export const transmissionSegmentsRelations = relations(transmissionSegments, ({ one }) => ({
  transmission: one(transmissions, { fields: [transmissionSegments.transmissionId], references: [transmissions.id] }),
  tenant: one(tenants, { fields: [transmissionSegments.tenantId], references: [tenants.id] }),
}));

export const personAppearancesRelations = relations(personAppearances, ({ one }) => ({
  transmission: one(transmissions, { fields: [personAppearances.transmissionId], references: [transmissions.id] }),
  tenant: one(tenants, { fields: [personAppearances.tenantId], references: [tenants.id] }),
  person: one(persons, { fields: [personAppearances.personId], references: [persons.id] }),
}));

// ── editorial relations ───────────────────────────────────────────────────────
export const editorialProfilesRelations = relations(editorialProfiles, ({ one, many }) => ({
  tenant: one(tenants, { fields: [editorialProfiles.tenantId], references: [tenants.id] }),
  updatedByUser: one(users, { fields: [editorialProfiles.updatedBy], references: [users.id] }),
  versions: many(editorialProfileVersions),
}));

export const editorialProfileVersionsRelations = relations(editorialProfileVersions, ({ one }) => ({
  profile: one(editorialProfiles, { fields: [editorialProfileVersions.profileId], references: [editorialProfiles.id] }),
  updatedByUser: one(users, { fields: [editorialProfileVersions.updatedBy], references: [users.id] }),
}));

// ── saas relations ────────────────────────────────────────────────────────────
export const userTenantsRelations = relations(userTenants, ({ one }) => ({
  user: one(users, { fields: [userTenants.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [userTenants.tenantId], references: [tenants.id] }),
}));

export const tenantQuotasRelations = relations(tenantQuotas, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantQuotas.tenantId], references: [tenants.id] }),
}));

export const quotaOperationsRelations = relations(quotaOperations, ({ one }) => ({
  tenant: one(tenants, { fields: [quotaOperations.tenantId], references: [tenants.id] }),
}));

export const billingEventsRelations = relations(billingEvents, ({ one }) => ({
  tenant: one(tenants, { fields: [billingEvents.tenantId], references: [tenants.id] }),
  subscription: one(subscriptions, { fields: [billingEvents.subscriptionId], references: [subscriptions.id] }),
}));

export const tenantFeaturesRelations = relations(tenantFeatures, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantFeatures.tenantId], references: [tenants.id] }),
  setByUser: one(users, { fields: [tenantFeatures.setBy], references: [users.id] }),
}));

export const jobsQueueRelations = relations(jobsQueue, ({ one }) => ({
  tenant: one(tenants, { fields: [jobsQueue.tenantId], references: [tenants.id] }),
}));

export const aiCostRecordsRelations = relations(aiCostRecords, ({ one }) => ({
  tenant: one(tenants, { fields: [aiCostRecords.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, { fields: [aiCostRecords.transmissionId], references: [transmissions.id] }),
}));

export const adminImpersonationsRelations = relations(adminImpersonations, ({ one }) => ({
  adminUser: one(users, { fields: [adminImpersonations.adminUserId], references: [users.id] }),
  tenant: one(tenants, { fields: [adminImpersonations.tenantId], references: [tenants.id] }),
}));

// ── assets relations ──────────────────────────────────────────────────────────
export const assetsRelations = relations(assets, ({ one, many }) => ({
  tenant: one(tenants, { fields: [assets.tenantId], references: [tenants.id] }),
  transmission: one(transmissions, { fields: [assets.transmissionId], references: [transmissions.id] }),
  program: one(programs, { fields: [assets.programId], references: [programs.id] }),
  persons: many(assetPersons),
  publishJobs: many(publishJobs),
}));

export const assetPersonsRelations = relations(assetPersons, ({ one }) => ({
  asset: one(assets, { fields: [assetPersons.assetId], references: [assets.id] }),
  person: one(persons, { fields: [assetPersons.personId], references: [persons.id] }),
}));

export const socialConnectionsRelations = relations(socialConnections, ({ one, many }) => ({
  tenant: one(tenants, { fields: [socialConnections.tenantId], references: [tenants.id] }),
  portfolio: one(socialPortfolios, { fields: [socialConnections.portfolioId], references: [socialPortfolios.id] }),
  publishJobs: many(publishJobs),
}));

export const publishJobsRelations = relations(publishJobs, ({ one }) => ({
  tenant: one(tenants, { fields: [publishJobs.tenantId], references: [tenants.id] }),
  asset: one(assets, { fields: [publishJobs.assetId], references: [assets.id] }),
  socialConnection: one(socialConnections, { fields: [publishJobs.socialConnectionId], references: [socialConnections.id] }),
}));
