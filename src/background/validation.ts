import type { GlobalSettings } from '../shared/domain';
import { normalizeHttpsOrigin } from '../shared/url';

export function validateUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function validateOrigin(value: unknown): value is string {
  return typeof value === 'string' && normalizeHttpsOrigin(value) === value;
}

export function validateSettingsPatch(
  current: GlobalSettings,
  patch: Partial<GlobalSettings>,
): GlobalSettings | undefined {
  const candidate: GlobalSettings = {
    windowStartMinutes:
      patch.windowStartMinutes ?? current.windowStartMinutes,
    windowEndMinutes: patch.windowEndMinutes ?? current.windowEndMinutes,
    notifyOnSuccess: patch.notifyOnSuccess ?? current.notifyOnSuccess,
  };

  if (
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
    label.length > 0 &&
    label.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(label)
  );
}
