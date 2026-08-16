import type { AuthMode, GlobalSettings } from '../shared/domain';
import { normalizeHttpsOrigin } from '../shared/url';

export function validateUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateOrigin(value: unknown): value is string {
  return typeof value === 'string' && normalizeHttpsOrigin(value) === value;
}

export function validateIdentitySource(value: unknown): boolean {
  return value === 'uid' || value === 'user.id' || value === 'refresh';
}

export function validateAuthMode(value: unknown): value is AuthMode {
  return value === 'legacy-session' || value === 'same-origin-refresh' || value === 'none';
}

export function validateSettingsPatch(
  current: GlobalSettings,
  patch: Partial<GlobalSettings>,
): GlobalSettings | undefined {
  const scheduleMode =
    patch.scheduleMode === undefined ? current.scheduleMode : patch.scheduleMode;
  const candidate: GlobalSettings = {
    scheduleMode,
    windowStartMinutes:
      patch.windowStartMinutes ?? current.windowStartMinutes,
    windowEndMinutes: patch.windowEndMinutes ?? current.windowEndMinutes,
    notifyOnSuccess: patch.notifyOnSuccess ?? current.notifyOnSuccess,
  };

  if (
    (scheduleMode !== 'startup' && scheduleMode !== 'window') ||
    !Number.isInteger(candidate.windowStartMinutes) ||
    !Number.isInteger(candidate.windowEndMinutes) ||
    candidate.windowStartMinutes < 0 ||
    candidate.windowEndMinutes > 24 * 60 - 1 ||
    candidate.windowEndMinutes - candidate.windowStartMinutes < 5 ||
    typeof candidate.notifyOnSuccess !== 'boolean'
  ) {
    return undefined;
  }
  return candidate;
}

export function isSafeEnrollmentLabel(label: unknown): label is string {
  return (
    typeof label === 'string' &&
    label.trim().length > 0 &&
    label.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(label)
  );
}

export function validateCapabilities(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const capabilities = value as Record<string, unknown>;
  if (typeof capabilities.checkin !== 'boolean') return false;
  if (typeof capabilities.statusEndpoint !== 'boolean') return false;
  if (capabilities.pow === undefined) return true;
  const pow = capabilities.pow as Record<string, unknown>;
  return (
    typeof pow === 'object' &&
    pow !== null &&
    typeof pow.enabled === 'boolean' &&
    (pow.mode === 'replace' || pow.mode === 'supplement' || pow.mode === 'fallback' || pow.mode === 'unknown') &&
    typeof pow.turnstileCheck === 'boolean'
  );
}
