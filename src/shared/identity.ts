import type { IdentitySource } from './domain';

export interface PageIdentityResult {
  userId: number;
  identitySource: IdentitySource;
}

export function isPageIdentityResult(value: unknown): value is PageIdentityResult {
  if (typeof value !== 'object' || value === null) return false;
  if (!('userId' in value) || !('identitySource' in value)) return false;
  return (
    typeof value.userId === 'number' &&
    Number.isSafeInteger(value.userId) &&
    value.userId > 0 &&
    (value.identitySource === 'uid' || value.identitySource === 'user.id')
  );
}

export function readPageIdentity(): PageIdentityResult | undefined {
  const positiveInteger = (value: unknown): number | undefined => {
    const candidate =
      typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : value;
    return typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate > 0
      ? candidate
      : undefined;
  };

  const directId = positiveInteger(window.localStorage.getItem('uid'));
  if (directId !== undefined) {
    return { userId: directId, identitySource: 'uid' };
  }

  const serializedUser = window.localStorage.getItem('user');
  if (!serializedUser) return undefined;

  try {
    const parsed: unknown = JSON.parse(serializedUser);
    if (typeof parsed !== 'object' || parsed === null || !('id' in parsed)) {
      return undefined;
    }
    const userId = positiveInteger(parsed.id);
    return userId === undefined
      ? undefined
      : { userId, identitySource: 'user.id' };
  } catch {
    return undefined;
  }
}
