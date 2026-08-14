import { createDefaultState, DEFAULT_SETTINGS, STORAGE_KEY } from '../shared/constants';
import {
  STORAGE_SCHEMA_VERSION,
  type BatchJob,
  type CheckinRecord,
  type DailySchedule,
  type PowLedger,
  type RetryJob,
  type SiteConfig,
  type StorageState,
  type UpgradeState,
} from '../shared/domain';
import { pruneHistory } from './history';
import { clearExpiredPowLedgers } from './pow-ledger';
import { dropInvalidRetries } from './retry';
import { pruneSchedules } from './schedule';
import { localScheduleDay } from './time';

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(key: string): Promise<void>;
}

export interface StateUpdate<T> {
  state: StorageState;
  value: T;
}

type StateMutator<T> = (draft: StorageState) => T | Promise<T>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value;
  } catch {
    return false;
  }
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function optionalKnownString<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return isOneOf(value, values) ? value : undefined;
}

const ACTION_REASONS = [
  'sign_in',
  'account_changed',
  'turnstile',
  'captcha',
  'unknown_challenge',
  'permission_missing',
  'rebind_required',
  'auth_upgrade_required',
  'identity_missing',
] as const;
const ERROR_CODES = [
  'network',
  'rate_limited',
  'server_error',
  'auth_failed',
  'business_rejected',
  'invalid_response',
  'unsupported_protocol',
  'pow_budget_exhausted',
  'pow_difficulty_out_of_range',
  'pow_timeout',
  'pow_cancelled',
  'permission_missing',
  'schedule_day_ended',
  'unknown',
] as const;
const AUTH_MODES = ['legacy-session', 'same-origin-refresh', 'none'] as const;
const ADAPTER_IDS = ['new-api', 'runanytime', 'visit-open'] as const;
const IDENTITY_SOURCES = ['uid', 'user.id', 'refresh'] as const;

function sanitizeSite(value: unknown): SiteConfig | undefined {
  if (!isObject(value) || !isObject(value.binding) || !isObject(value.capabilities)) return undefined;
  const binding = value.binding;
  const capabilities = value.capabilities;
  if (
    !isCanonicalHttpsOrigin(value.origin) ||
    typeof value.label !== 'string' ||
    !isOneOf(value.platform, ['new-api', 'runanytime', 'generic'] as const) ||
    !isOneOf(value.adapterId, ADAPTER_IDS) ||
    !isOneOf(value.authMode, AUTH_MODES) ||
    !isOneOf(value.supportLevel, ['detected', 'verified'] as const) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof capabilities.checkin !== 'boolean' ||
    typeof capabilities.statusEndpoint !== 'boolean' ||
    !Number.isInteger(binding.userId) ||
    Number(binding.userId) <= 0 ||
    !isOneOf(binding.identitySource, IDENTITY_SOURCES) ||
    typeof binding.generation !== 'string' ||
    typeof binding.boundAt !== 'string' ||
    !isOneOf(binding.state, ['active', 'action_required'] as const)
  ) {
    return undefined;
  }

  const sanitized: SiteConfig = {
    origin: value.origin,
    label: value.label,
    platform: value.platform,
    adapterId: value.adapterId,
    authMode: value.authMode,
    supportLevel: value.supportLevel,
    enabled: value.enabled,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    capabilities: {
      checkin: capabilities.checkin,
      statusEndpoint: capabilities.statusEndpoint,
    },
    binding: {
      userId: Number(binding.userId),
      identitySource: binding.identitySource,
      generation: binding.generation,
      boundAt: binding.boundAt,
      state: binding.state,
    },
  };
  const actionReason = optionalKnownString(binding.actionReason, ACTION_REASONS);
  if (actionReason) sanitized.binding.actionReason = actionReason;

  if (
    isObject(capabilities.pow) &&
    typeof capabilities.pow.enabled === 'boolean' &&
    isOneOf(capabilities.pow.mode, ['replace', 'supplement', 'fallback', 'unknown'] as const) &&
    typeof capabilities.pow.turnstileCheck === 'boolean'
  ) {
    sanitized.capabilities.pow = {
      enabled: capabilities.pow.enabled,
      mode: capabilities.pow.mode,
      turnstileCheck: capabilities.pow.turnstileCheck,
    };
  }
  return sanitized;
}

function sanitizeRecord(value: unknown): CheckinRecord | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.bindingGeneration !== 'string' ||
    typeof value.scheduleDay !== 'string' ||
    typeof value.attemptedAt !== 'string' ||
    !isOneOf(value.trigger, ['scheduled', 'catchup', 'manual', 'run_all', 'retry'] as const) ||
    !isOneOf(value.outcome, ['success', 'already_checked', 'action_required', 'failed', 'unsupported', 'cancelled', 'unverified'] as const) ||
    !Number.isFinite(value.durationMs) ||
    Number(value.durationMs) < 0 ||
    !Number.isInteger(value.retryCount) ||
    Number(value.retryCount) < 0
  ) return undefined;

  const sanitized: CheckinRecord = {
    id: value.id,
    origin: value.origin,
    bindingGeneration: value.bindingGeneration,
    scheduleDay: value.scheduleDay,
    attemptedAt: value.attemptedAt,
    trigger: value.trigger,
    outcome: value.outcome,
    durationMs: Number(value.durationMs),
    retryCount: Number(value.retryCount),
  };
  if (typeof value.reward === 'string') sanitized.reward = value.reward;
  const actionReason = optionalKnownString(value.actionReason, ACTION_REASONS);
  if (actionReason) sanitized.actionReason = actionReason;
  const errorCode = optionalKnownString(value.errorCode, ERROR_CODES);
  if (errorCode) sanitized.errorCode = errorCode;
  return sanitized;
}

function sanitizeSchedule(value: unknown): DailySchedule | undefined {
  if (
    !isObject(value) ||
    typeof value.scheduleDay !== 'string' ||
    typeof value.scheduledAt !== 'string' ||
    !isOneOf(value.state, ['scheduled', 'running', 'complete'] as const)
  ) return undefined;
  const sanitized: DailySchedule = {
    scheduleDay: value.scheduleDay,
    scheduledAt: value.scheduledAt,
    state: value.state,
  };
  if (typeof value.startedAt === 'string') sanitized.startedAt = value.startedAt;
  if (typeof value.completedAt === 'string') sanitized.completedAt = value.completedAt;
  return sanitized;
}

function sanitizeRetry(value: unknown): RetryJob | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.bindingGeneration !== 'string' ||
    typeof value.scheduleDay !== 'string' ||
    (value.retryCount !== 1 && value.retryCount !== 2) ||
    typeof value.dueAt !== 'string' ||
    !isOneOf(value.originalTrigger, ['scheduled', 'catchup', 'manual', 'run_all'] as const)
  ) return undefined;
  return {
    id: value.id,
    origin: value.origin,
    bindingGeneration: value.bindingGeneration,
    scheduleDay: value.scheduleDay,
    retryCount: value.retryCount,
    dueAt: value.dueAt,
    originalTrigger: value.originalTrigger,
  };
}

function sanitizeLedger(value: unknown): PowLedger | undefined {
  if (
    !isObject(value) ||
    typeof value.origin !== 'string' ||
    typeof value.scheduleDay !== 'string' ||
    !Number.isInteger(value.challengesUsed) ||
    Number(value.challengesUsed) < 0 ||
    !Number.isFinite(value.workerMsUsed) ||
    Number(value.workerMsUsed) < 0 ||
    typeof value.removedSiteTombstone !== 'boolean'
  ) return undefined;
  return {
    origin: value.origin,
    scheduleDay: value.scheduleDay,
    challengesUsed: Number(value.challengesUsed),
    workerMsUsed: Number(value.workerMsUsed),
    removedSiteTombstone: value.removedSiteTombstone,
  };
}

function sanitizeBatch(value: unknown): BatchJob | undefined {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.scheduleDay !== 'string' ||
    !isOneOf(value.trigger, ['scheduled', 'catchup', 'run_all'] as const) ||
    !Array.isArray(value.pendingOrigins) ||
    !value.pendingOrigins.every((origin) => typeof origin === 'string') ||
    !isObject(value.bindingGenerations) ||
    !Object.values(value.bindingGenerations).every((generation) => typeof generation === 'string') ||
    typeof value.createdAt !== 'string'
  ) return undefined;
  const sanitized: BatchJob = {
    id: value.id,
    scheduleDay: value.scheduleDay,
    trigger: value.trigger,
    pendingOrigins: [...new Set(value.pendingOrigins)],
    bindingGenerations: Object.fromEntries(
      Object.entries(value.bindingGenerations).filter(([, generation]) => typeof generation === 'string'),
    ) as Record<string, string>,
    createdAt: value.createdAt,
  };
  if (typeof value.nextOriginAt === 'string') sanitized.nextOriginAt = value.nextOriginAt;
  return sanitized;
}

function sanitizeMap<T>(
  value: unknown,
  sanitize: (candidate: unknown) => T | undefined,
  key: (candidate: T) => string,
): Record<string, T> {
  if (!isObject(value)) return {};
  const filtered: Record<string, T> = {};
  for (const candidate of Object.values(value)) {
    const sanitized = sanitize(candidate);
    if (sanitized) filtered[key(sanitized)] = sanitized;
  }
  return filtered;
}

function sanitizeUpgrade(value: unknown): UpgradeState {
  const upgrade = isObject(value) ? value : {};
  return { authUpgradeNoticeSent: upgrade.authUpgradeNoticeSent === true };
}

/**
 * Explicit v1 → v2 migration. Every collection is carried over losslessly:
 * settings, sites, history, schedules, retries and the PoW ledger. Sites gain
 * an `authMode`; existing runanytime sites (which now require the modern
 * same-origin-refresh login) are paused immediately with a one-time
 * "update login method" notice, other sites keep legacy session auth.
 */
export function migrateV1ToV2(value: Record<string, unknown>): Record<string, unknown> {
  const sites: Record<string, unknown> = {};
  if (isObject(value.sites)) {
    for (const [origin, rawSite] of Object.entries(value.sites)) {
      if (!isObject(rawSite)) continue;
      const adapterId = rawSite.adapterId;
      if (adapterId === 'runanytime-pow') {
        sites[origin] = {
          ...rawSite,
          adapterId: 'runanytime',
          authMode: 'same-origin-refresh',
          enabled: false,
          binding: {
            ...(isObject(rawSite.binding) ? rawSite.binding : {}),
            state: 'action_required',
            actionReason: 'auth_upgrade_required',
          },
        };
      } else if (adapterId === 'visit-open') {
        sites[origin] = { ...rawSite, adapterId: 'visit-open', authMode: 'none' };
      } else {
        sites[origin] = { ...rawSite, adapterId: 'new-api', authMode: 'legacy-session' };
      }
    }
  }
  return {
    ...value,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    sites,
    upgrade: { authUpgradeNoticeSent: false },
  };
}

/**
 * Copies only schema fields, preventing unknown or secret-bearing fields from
 * persisting. v1 states are migrated explicitly to v2 first.
 */
export function normalizeStorageState(value: unknown, now: Date = new Date()): StorageState {
  if (!isObject(value)) return createDefaultState();
  const migrated = value.schemaVersion === 1 ? migrateV1ToV2(value) : value;
  if (migrated.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    return createDefaultState();
  }

  const settingsValue = isObject(value.settings) ? value.settings : {};
  const start = Number(settingsValue.windowStartMinutes);
  const end = Number(settingsValue.windowEndMinutes);
  const settings =
    Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 * 60 && start < end
      ? {
          windowStartMinutes: start,
          windowEndMinutes: end,
          notifyOnSuccess:
            typeof settingsValue.notifyOnSuccess === 'boolean'
              ? settingsValue.notifyOnSuccess
              : DEFAULT_SETTINGS.notifyOnSuccess,
        }
      : { ...DEFAULT_SETTINGS };

  const scheduleDay = localScheduleDay(now);
  const activeBatch = sanitizeBatch(migrated.activeBatch);
  const state: StorageState = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings,
    sites: sanitizeMap(migrated.sites, sanitizeSite, (site) => site.origin),
    records: Array.isArray(migrated.records)
      ? migrated.records.map(sanitizeRecord).filter((record): record is CheckinRecord => record !== undefined)
      : [],
    schedules: sanitizeMap(migrated.schedules, sanitizeSchedule, (schedule) => schedule.scheduleDay),
    retries: Array.isArray(migrated.retries)
      ? migrated.retries.map(sanitizeRetry).filter((retry): retry is RetryJob => retry !== undefined)
      : [],
    powLedgers: sanitizeMap(
      migrated.powLedgers,
      sanitizeLedger,
      (ledger) => `${ledger.origin}\n${ledger.scheduleDay}`,
    ),
    upgrade: sanitizeUpgrade(migrated.upgrade),
  };
  if (activeBatch && activeBatch.scheduleDay === scheduleDay) state.activeBatch = activeBatch;

  const current = clearExpiredPowLedgers(state, scheduleDay);
  const retries = dropInvalidRetries(current, scheduleDay);
  const records = pruneHistory(current.records, now).filter(
    (record) => current.sites[record.origin] !== undefined,
  );
  return {
    ...current,
    records,
    schedules: pruneSchedules(current.schedules, scheduleDay),
    retries,
  };
}

export class StateRepository {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly area: StorageAreaLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<StorageState> {
    const stored = await this.area.get(STORAGE_KEY);
    const raw = stored[STORAGE_KEY];
    const normalized = normalizeStorageState(raw, this.now());
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) {
      await this.area.set({ [STORAGE_KEY]: normalized });
    }
    return normalized;
  }

  async write(state: StorageState): Promise<StorageState> {
    const normalized = normalizeStorageState(state, this.now());
    await this.area.set({ [STORAGE_KEY]: normalized });
    return normalized;
  }

  update<T>(mutator: StateMutator<T>): Promise<StateUpdate<T>> {
    const task = this.pending.then(async () => {
      const state = structuredClone(await this.read());
      const value = await mutator(state);
      const saved = await this.write(state);
      return { state: saved, value };
    });
    this.pending = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async reset(): Promise<StorageState> {
    const state = createDefaultState();
    await this.area.set({ [STORAGE_KEY]: state });
    return state;
  }
}

export function createStateRepository(
  area: StorageAreaLike,
  now?: () => Date,
): StateRepository {
  return new StateRepository(area, now);
}
