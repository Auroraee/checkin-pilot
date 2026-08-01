import { describe, expect, it } from 'vitest';
import {
  createStateRepository,
  normalizeStorageState,
} from '../../../src/core';
import { STORAGE_KEY, createDefaultState } from '../../../src/shared/constants';
import type { StorageAreaLike } from '../../../src/core';
import { site } from './fixtures';

class MemoryStorage implements StorageAreaLike {
  readonly data: Record<string, unknown> = {};

  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: this.data[key] };
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, structuredClone(items));
  }
}

describe('state repository', () => {
  const now = () => new Date(2026, 6, 31, 12, 0);

  it('falls back safely for unknown schema data', () => {
    expect(normalizeStorageState({ schemaVersion: 999 }, now())).toEqual(createDefaultState());
  });

  it('strips unknown and secret-bearing fields before persistence', async () => {
    const area = new MemoryStorage();
    const repository = createStateRepository(area, now);
    const unsafe = {
      ...createDefaultState(),
      token: 'must-not-persist',
      sites: {
        'https://example.test': {
          ...site(),
          cookie: 'must-not-persist',
        },
      },
    };
    await repository.write(unsafe);
    const serialized = JSON.stringify(area.data[STORAGE_KEY]);
    expect(serialized).not.toContain('must-not-persist');
    expect(serialized).not.toContain('"token"');
    expect(serialized).not.toContain('"cookie"');
  });

  it('serializes concurrent read-modify-write updates', async () => {
    const area = new MemoryStorage();
    const repository = createStateRepository(area, now);
    await repository.reset();
    await Promise.all([
      repository.update(async (state) => {
        await Promise.resolve();
        state.settings.notifyOnSuccess = true;
        return 'first';
      }),
      repository.update((state) => {
        state.settings.windowStartMinutes = 9 * 60;
        return 'second';
      }),
    ]);
    const saved = await repository.read();
    expect(saved.settings.notifyOnSuccess).toBe(true);
    expect(saved.settings.windowStartMinutes).toBe(9 * 60);
  });
});
