import { browser } from 'wxt/browser';
import {
  PAGE_SESSION_INJECTION_TIMEOUT_MS,
  PAGE_SESSION_OPEN_TIMEOUT_MS,
} from '../shared/constants';

export interface PageSession {
  readonly tabId: number;
  /** True when this session created the tab; only then is it closed. */
  readonly owned: boolean;
  run<T>(
    func: (...args: never[]) => unknown,
    args: readonly unknown[],
    options?: { timeoutMs?: number },
  ): Promise<T | undefined>;
  close(): Promise<void>;
}

export class PageSessionImpl implements PageSession {
  private closed = false;

  constructor(
    readonly tabId: number,
    readonly owned: boolean,
  ) {}

  async run<T>(
    func: (...args: never[]) => unknown,
    args: readonly unknown[],
    options?: { timeoutMs?: number },
  ): Promise<T | undefined> {
    if (this.closed) return undefined;
    const timeoutMs = options?.timeoutMs ?? PAGE_SESSION_INJECTION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('page_session_injection_timeout')),
        timeoutMs,
      );
    });
    try {
      const results = await Promise.race([
        browser.scripting.executeScript({
          target: { tabId: this.tabId },
          world: 'ISOLATED',
          func: func as (...args: unknown[]) => unknown,
          args: [...args],
        }),
        timeout,
      ]);
      return results[0]?.result as T | undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.owned) {
      try {
        await browser.tabs.remove(this.tabId);
      } catch {
        // The tab may already be gone (user closed it or a navigation raced).
      }
    }
  }
}

/**
 * Opens a page session on the exact origin: prefers an existing tab, then a
 * background (`active: false`) temporary tab. A temporary tab is always
 * closed by `close()`; tabs the user already had open are never closed.
 */
export async function openPageSession(
  origin: string,
  options: { preferredTabId?: number } = {},
): Promise<PageSession> {
  if (options.preferredTabId !== undefined) {
    const reused = await tryReuseTab(options.preferredTabId, origin);
    if (reused !== undefined) return reused;
  }
  try {
    const matches = await browser.tabs.query({ url: `${origin}/*` });
    for (const tab of matches) {
      if (tab.id === undefined) continue;
      const candidate = await tryReuseTab(tab.id, origin);
      if (candidate !== undefined) return candidate;
    }
  } catch {
    // Querying tab URLs needs the host permission; fall back to a new tab.
  }

  const created = await browser.tabs.create({ url: origin, active: false });
  if (created.id === undefined) {
    throw new Error('page_session_tab_creation_failed');
  }
  const session = new PageSessionImpl(created.id, true);
  await waitForComplete(session.tabId);
  return session;
}

async function tryReuseTab(
  tabId: number,
  origin: string,
): Promise<PageSession | undefined> {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.id === undefined || tab.url === undefined) return undefined;
    const parsed = new URL(tab.url);
    if (parsed.origin !== origin) return undefined;
    const session = new PageSessionImpl(tab.id, false);
    await waitForComplete(session.tabId);
    return session;
  } catch {
    return undefined;
  }
}

async function waitForComplete(tabId: number): Promise<void> {
  const deadline = Date.now() + PAGE_SESSION_OPEN_TIMEOUT_MS;
  for (;;) {
    let status: string | undefined;
    try {
      const tab = await browser.tabs.get(tabId);
      status = tab.status;
    } catch {
      return; // A dead tab surfaces later during injection.
    }
    if (status === 'complete') return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
