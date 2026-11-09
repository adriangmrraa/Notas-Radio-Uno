import { pgEnum } from 'drizzle-orm/pg-core';

// ── UserRole ──────────────────────────────────────────────────────────────────
export const userRoleEnum = pgEnum('UserRole', ['owner', 'editor', 'viewer']);
export const UserRole = { owner: 'owner', editor: 'editor', viewer: 'viewer' } as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

// ── UserStatus ────────────────────────────────────────────────────────────────
export const userStatusEnum = pgEnum('UserStatus', ['pending', 'active', 'suspended']);
export const UserStatus = { pending: 'pending', active: 'active', suspended: 'suspended' } as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

// ── PublicationSource ─────────────────────────────────────────────────────────
export const publicationSourceEnum = pgEnum('PublicationSource', ['pipeline', 'manual', 'scheduled']);
export const PublicationSource = { pipeline: 'pipeline', manual: 'manual', scheduled: 'scheduled' } as const;
export type PublicationSource = (typeof PublicationSource)[keyof typeof PublicationSource];

// ── SubscriptionStatus ────────────────────────────────────────────────────────
export const subscriptionStatusEnum = pgEnum('SubscriptionStatus', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'suspended',
  'expired',
]);
export const SubscriptionStatus = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  suspended: 'suspended',
  expired: 'expired',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

// ── InvoiceStatus ─────────────────────────────────────────────────────────────
export const invoiceStatusEnum = pgEnum('InvoiceStatus', ['pending', 'paid', 'failed', 'refunded']);
export const InvoiceStatus = { pending: 'pending', paid: 'paid', failed: 'failed', refunded: 'refunded' } as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

// ── ScheduleType ──────────────────────────────────────────────────────────────
export const scheduleTypeEnum = pgEnum('ScheduleType', ['recurring', 'one_time']);
export const ScheduleType = { recurring: 'recurring', one_time: 'one_time' } as const;
export type ScheduleType = (typeof ScheduleType)[keyof typeof ScheduleType];

// ── JobExecutionStatus ────────────────────────────────────────────────────────
export const jobExecutionStatusEnum = pgEnum('JobExecutionStatus', [
  'pending',
  'running',
  'completed',
  'failed',
  'canceled',
  'timeout',
]);
export const JobExecutionStatus = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  canceled: 'canceled',
  timeout: 'timeout',
} as const;
export type JobExecutionStatus = (typeof JobExecutionStatus)[keyof typeof JobExecutionStatus];

// ── InvitationStatus ──────────────────────────────────────────────────────────
export const invitationStatusEnum = pgEnum('InvitationStatus', ['pending', 'accepted', 'expired', 'revoked']);
export const InvitationStatus = {
  pending: 'pending',
  accepted: 'accepted',
  expired: 'expired',
  revoked: 'revoked',
} as const;
export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];

// ── PublicationStatus ─────────────────────────────────────────────────────────
export const publicationStatusEnum = pgEnum('PublicationStatus', [
  'pending_review', 'approved', 'published', 'rejected',
]);
export const PublicationStatus = {
  pending_review: 'pending_review',
  approved: 'approved',
  published: 'published',
  rejected: 'rejected',
} as const;
export type PublicationStatus = (typeof PublicationStatus)[keyof typeof PublicationStatus];

// ── UsageCycleStatus ──────────────────────────────────────────────────────────
export const usageCycleStatusEnum = pgEnum('UsageCycleStatus', ['open', 'closed']);
export const UsageCycleStatus = { open: 'open', closed: 'closed' } as const;
export type UsageCycleStatus = (typeof UsageCycleStatus)[keyof typeof UsageCycleStatus];

// ── QuotaOperationStatus ──────────────────────────────────────────────────────
export const quotaOperationStatusEnum = pgEnum('QuotaOperationStatus', ['reserved', 'consumed', 'released']);
export const QuotaOperationStatus = {
  reserved: 'reserved',
  consumed: 'consumed',
  released: 'released',
} as const;
export type QuotaOperationStatus = (typeof QuotaOperationStatus)[keyof typeof QuotaOperationStatus];

// ── AddonPurchaseStatus ───────────────────────────────────────────────────────
export const addonPurchaseStatusEnum = pgEnum('AddonPurchaseStatus', ['pending', 'paid', 'failed', 'refunded']);
export const AddonPurchaseStatus = {
  pending: 'pending',
  paid: 'paid',
  failed: 'failed',
  refunded: 'refunded',
} as const;
export type AddonPurchaseStatus = (typeof AddonPurchaseStatus)[keyof typeof AddonPurchaseStatus];

// ── FeatureSource ─────────────────────────────────────────────────────────────
// Origen del valor efectivo de un feature flag de tenant:
//   plan     → valor heredado del plan contratado
//   override → valor pisado manualmente por el owner del tenant
//   admin    → valor pisado por un super admin de la plataforma
export const featureSourceEnum = pgEnum('FeatureSource', ['plan', 'override', 'admin']);
export const FeatureSource = {
  plan: 'plan',
  override: 'override',
  admin: 'admin',
} as const;
export type FeatureSource = (typeof FeatureSource)[keyof typeof FeatureSource];
