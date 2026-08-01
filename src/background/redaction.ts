import type { RedactedErrorCode } from '../shared/domain';

export function redactUnknownError(error: unknown): RedactedErrorCode {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'unknown';
  }
  if (error instanceof TypeError) return 'network';
  return 'unknown';
}

export function safeLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>> = {},
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  console[level](`[CheckinPilot] ${event}`, safeFields);
}
