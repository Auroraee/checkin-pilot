import type { GlobalSettings, StorageState } from './domain';
import { STORAGE_SCHEMA_VERSION } from './domain';

export const PRODUCT_NAME = 'CheckinPilot';
export const STORAGE_KEY = 'checkinPilotState';
export const SCHEDULE_ALARM_PREFIX = 'checkin-pilot:schedule:';
export const RETRY_ALARM_PREFIX = 'checkin-pilot:retry:';
export const BATCH_ALARM_NAME = 'checkin-pilot:batch-next';

export const DEFAULT_SETTINGS: GlobalSettings = {
  windowStartMinutes: 8 * 60,
  windowEndMinutes: 10 * 60,
  notifyOnSuccess: false,
};

export const HISTORY_RETENTION_DAYS = 30;
export const HISTORY_LIMIT_PER_SITE = 100;
export const SERIAL_DELAY_MIN_MS = 5_000;
export const SERIAL_DELAY_MAX_MS = 15_000;
export const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;
export const POW_MAX_CHALLENGES_PER_DAY = 2;
export const POW_MAX_WORKER_MS_PER_DAY = 24_000;
export const POW_MAX_WORKER_MS_PER_CHALLENGE = 12_000;
export const POW_MIN_DIFFICULTY = 10;
export const POW_MAX_DIFFICULTY = 20;
export const POW_MAX_ATTEMPTS_PER_RUN = 2;

/** New API dashboard token refresh endpoint (same-origin, ISOLATED world only). */
export const MODERN_REFRESH_PATH = '/api/user/auth/refresh';
export const MODERN_CHECKIN_PATH = '/api/user/checkin';
export const MODERN_POW_CHALLENGE_PATH = '/api/user/pow/challenge';
export const MODERN_STATUS_PATH = '/api/status';

/** Hard cap for one injected same-origin session, including page load. */
export const PAGE_SESSION_OPEN_TIMEOUT_MS = 20_000;
export const PAGE_SESSION_INJECTION_TIMEOUT_MS = 60_000;

export function createDefaultState(): StorageState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    sites: {},
    records: [],
    schedules: {},
    retries: [],
    powLedgers: {},
    upgrade: { authUpgradeNoticeSent: false },
  };
}
