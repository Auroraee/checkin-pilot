export const STORAGE_SCHEMA_VERSION = 2 as const;

export type PlatformFamily = 'new-api' | 'runanytime' | 'generic';
export type AdapterId = 'new-api' | 'runanytime' | 'visit-open';
export type SupportLevel = 'detected' | 'verified';
export type IdentitySource = 'uid' | 'user.id' | 'refresh';
export type PowMode = 'replace' | 'supplement' | 'fallback' | 'unknown';

/**
 * Independent authentication modes. Protocol adapters are decoupled from the
 * auth method: `legacy-session` keeps the Cookie + `New-Api-User` path,
 * `same-origin-refresh` performs `/api/user/auth/refresh` inside an ISOLATED
 * world of an exact same-origin tab (the bearer token never leaves the page
 * context), and `none` covers visit mode where no authenticated API is used.
 */
export type AuthMode = 'legacy-session' | 'same-origin-refresh' | 'none';

export type TriggerKind =
  | 'scheduled'
  | 'catchup'
  | 'manual'
  | 'run_all'
  | 'retry';

export type OutcomeCode =
  | 'success'
  | 'already_checked'
  | 'action_required'
  | 'failed'
  | 'unsupported'
  | 'cancelled'
  | 'unverified';

export type ActionReason =
  | 'sign_in'
  | 'account_changed'
  | 'turnstile'
  | 'captcha'
  | 'unknown_challenge'
  | 'permission_missing'
  | 'rebind_required'
  | 'auth_upgrade_required'
  | 'identity_missing';

export type RedactedErrorCode =
  | 'network'
  | 'rate_limited'
  | 'server_error'
  | 'auth_failed'
  | 'business_rejected'
  | 'invalid_response'
  | 'unsupported_protocol'
  | 'pow_budget_exhausted'
  | 'pow_difficulty_out_of_range'
  | 'pow_timeout'
  | 'pow_cancelled'
  | 'permission_missing'
  | 'schedule_day_ended'
  | 'unknown';

export interface PowCapability {
  enabled: boolean;
  mode: PowMode;
  turnstileCheck: boolean;
}

export interface SiteCapabilities {
  checkin: boolean;
  statusEndpoint: boolean;
  pow?: PowCapability;
}

export interface SessionBinding {
  userId: number;
  identitySource: IdentitySource;
  generation: string;
  boundAt: string;
  state: 'active' | 'action_required';
  actionReason?: ActionReason;
}

export interface SiteConfig {
  origin: string;
  label: string;
  platform: PlatformFamily;
  adapterId: AdapterId;
  authMode: AuthMode;
  supportLevel: SupportLevel;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  capabilities: SiteCapabilities;
  binding: SessionBinding;
}

export interface GlobalSettings {
  windowStartMinutes: number;
  windowEndMinutes: number;
  notifyOnSuccess: boolean;
}

export interface CheckinRecord {
  id: string;
  origin: string;
  bindingGeneration: string;
  scheduleDay: string;
  attemptedAt: string;
  trigger: TriggerKind;
  outcome: OutcomeCode;
  reward?: string;
  durationMs: number;
  retryCount: number;
  actionReason?: ActionReason;
  errorCode?: RedactedErrorCode;
}

export interface DailySchedule {
  scheduleDay: string;
  scheduledAt: string;
  state: 'scheduled' | 'running' | 'complete';
  startedAt?: string;
  completedAt?: string;
}

export interface RetryJob {
  id: string;
  origin: string;
  bindingGeneration: string;
  scheduleDay: string;
  retryCount: 1 | 2;
  dueAt: string;
  originalTrigger: Exclude<TriggerKind, 'retry'>;
}

export interface BatchJob {
  id: string;
  scheduleDay: string;
  trigger: 'scheduled' | 'catchup' | 'run_all';
  pendingOrigins: string[];
  bindingGenerations: Record<string, string>;
  createdAt: string;
  nextOriginAt?: string;
}

export interface PowLedger {
  origin: string;
  scheduleDay: string;
  challengesUsed: number;
  workerMsUsed: number;
  removedSiteTombstone: boolean;
}

/** One-time migration flags; v2 introduces the auth-mode upgrade notice. */
export interface UpgradeState {
  authUpgradeNoticeSent: boolean;
}

export interface StorageState {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  settings: GlobalSettings;
  sites: Record<string, SiteConfig>;
  records: CheckinRecord[];
  schedules: Record<string, DailySchedule>;
  activeBatch?: BatchJob;
  retries: RetryJob[];
  powLedgers: Record<string, PowLedger>;
  upgrade: UpgradeState;
}

export interface NormalizedOutcome {
  code: OutcomeCode;
  reward?: string;
  actionReason?: ActionReason;
  errorCode?: RedactedErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface ProbeReport {
  origin: string;
  userId: number;
  identitySource: IdentitySource;
  supported: boolean;
  adapterId?: AdapterId;
  platform?: PlatformFamily;
  authMode?: AuthMode;
  supportLevel?: SupportLevel;
  capabilities?: SiteCapabilities;
  checkedInToday?: boolean;
  reason?: RedactedErrorCode | ActionReason;
}

export interface SiteView extends SiteConfig {
  latestRecord?: CheckinRecord;
  isPreviousBindingRecordExcluded: boolean;
}

export interface AppSnapshot {
  settings: GlobalSettings;
  sites: SiteView[];
  records: CheckinRecord[];
  currentSchedule?: DailySchedule;
  nextBatchAt?: string;
  scheduleDay: string;
  runningOrigins: string[];
}
