import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isOffscreenRequest,
  SinglePowWorkerController,
} from '../../../src/pow/offscreen-controller';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly listeners = new Map<string, (event: { data?: unknown }) => void>();
  posted: unknown;
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, listener);
  }

  postMessage(value: unknown): void {
    this.posted = value;
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(data: unknown): void {
    this.listeners.get('message')?.({ data });
  }
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe('single offscreen PoW worker controller', () => {
  it('accepts only bounded solve and targeted cancel messages', () => {
    expect(
      isOffscreenRequest({
        target: 'offscreen',
        type: 'pow:solve',
        taskId: 'a',
        prefix: 'p',
        difficulty: 18,
        maxMs: 12_000,
      }),
    ).toBe(true);
    expect(
      isOffscreenRequest({
        target: 'offscreen',
        type: 'pow:cancel',
        taskId: 'a',
      }),
    ).toBe(true);
    expect(isOffscreenRequest({ type: 'anything', taskId: 'a' })).toBe(false);
    // Page-session solve requests target the background and must be ignored.
    expect(
      isOffscreenRequest({
        target: 'background',
        type: 'pow:solve',
        tabId: 1,
        taskId: 'a',
        prefix: 'p',
        difficulty: 18,
        maxMs: 12_000,
      }),
    ).toBe(false);
  });

  it('returns the worker result and terminates it immediately', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new SinglePowWorkerController();
    const resultPromise = controller.solve({
      target: 'offscreen',
        type: 'pow:solve',
      taskId: 'task-1',
      prefix: 'private',
      difficulty: 18,
      maxMs: 1_000,
    });
    const worker = FakeWorker.instances[0];
    expect(worker?.posted).toEqual({
      type: 'solve',
      taskId: 'task-1',
      prefix: 'private',
      difficulty: 18,
      maxMs: 1_000,
    });
    worker?.emitMessage({
      taskId: 'task-1',
      status: 'solved',
      nonce: '0000abcd',
      elapsedMs: 12,
    });
    await expect(resultPromise).resolves.toEqual({
      status: 'solved',
      nonce: '0000abcd',
      elapsedMs: 12,
    });
    expect(worker?.terminated).toBe(true);
  });

  it('allows only one worker and resolves cancellation', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const controller = new SinglePowWorkerController();
    const first = controller.solve({
      target: 'offscreen',
        type: 'pow:solve',
      taskId: 'task-1',
      prefix: 'private',
      difficulty: 18,
      maxMs: 1_000,
    });
    await expect(
      controller.solve({
        target: 'offscreen',
        type: 'pow:solve',
        taskId: 'task-2',
        prefix: 'other',
        difficulty: 18,
        maxMs: 1_000,
      }),
    ).resolves.toEqual({ status: 'error', elapsedMs: 0 });
    expect(controller.cancel({ target: 'offscreen',
        type: 'pow:cancel', taskId: 'task-1' })).toMatchObject({
      status: 'cancelled',
    });
    await expect(first).resolves.toMatchObject({ status: 'cancelled' });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
});

