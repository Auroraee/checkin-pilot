// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readPageIdentity } from '../../../src/shared/identity';

describe('readPageIdentity', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('prefers an independent positive uid', () => {
    window.localStorage.setItem('uid', '42');
    window.localStorage.setItem(
      'user',
      JSON.stringify({ id: 99, token: 'must-not-cross-context' }),
    );

    expect(readPageIdentity()).toEqual({ userId: 42, identitySource: 'uid' });
  });

  it('returns only a validated user.id fallback', () => {
    window.localStorage.setItem(
      'user',
      JSON.stringify({ id: 77, access_token: 'must-not-cross-context', name: 'Hidden' }),
    );

    const result = readPageIdentity();
    expect(result).toEqual({ userId: 77, identitySource: 'user.id' });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-context');
    expect(JSON.stringify(result)).not.toContain('Hidden');
  });

  it.each(['0', '-1', '1.2', 'abc'])('rejects invalid uid %s', (uid) => {
    window.localStorage.setItem('uid', uid);
    expect(readPageIdentity()).toBeUndefined();
  });

  it('does not throw for malformed serialized user data', () => {
    window.localStorage.setItem('user', '{not-json');
    expect(readPageIdentity()).toBeUndefined();
  });
});
