/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';
import { isOffscreenRequest } from '../../src/pow/offscreen-controller';
import type { StorageAreaLike } from '../../src/core/storage';

/**
 * Mock extension runtime for mock-e2e tests. Models three contexts:
 * - the background service worker (uses `browser` from 'wxt/browser'),
 * - the offscreen document (receives `chrome.runtime` messages with
 *   `target: 'offscreen'`),
 * - an ISOLATED-world page tab (runs the injected refresh script with a
 *   page-scoped `fetch` against the mock site server and a `chrome` whose
 *   `runtime.sendMessage` delivers to the background).
 *
 * Every message, storage write, notification and console line is recorded so
 * tests can assert that a sentinel bearer token never leaves the page.
 */

export const SENTINEL_TOKEN = 'sentinel-access-token-9f3a71c4';

export interface MockTab {
  id: number;
  url: string;
  status: 'complete' | 'loading';
  active: boolean;
}

export interface RecordedMessage {
  from: 'sw' | 'page' | 'offscreen';
  message: unknown;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  from: 'sw' | 'page';
}

export type PowSolverBehavior = 'solve' | 'timeout' | 'error';

export interface MockServerConfig {
  status?: Record<string, unknown> | 'fail' | 'html';
  refresh?: 'ok' | 'needs_login' | 'legacy_only' | 'network' | 'invalid' | 'get_only' | 'sw_needs_login';
  refreshAccount?: number;
  checkin?: 'unchecked' | 'checked' | 'needs_login' | 'already_message' | 'invalid';
  challenge?: 'ok' | 'needs_login' | 'invalid' | 'out_of_range';
  challengeDifficulty?: number;
  submit?: 'success' | 'pow_stale' | 'needs_login' | 'turnstile_message' | 'invalid';
  powSolver?: PowSolverBehavior;
}

const DEFAULT_STATUS = {
  success: true,
  data: {
    checkin_enabled: true,
    turnstile_check: true,
    pow_enabled: true,
    pow_mode: 'replace',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class MockSiteServer {
  config: MockServerConfig = {};
  readonly requests: RecordedRequest[] = [];

  setConfig(config: MockServerConfig): void {
    this.config = config;
    this.requests.length = 0;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    const headerInit = init?.headers;
    if (headerInit instanceof Headers) {
      headerInit.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(headerInit)) {
      for (const [key, value] of headerInit) headers[key] = value;
    } else if (typeof headerInit === 'object' && headerInit !== null) {
      Object.assign(headers, headerInit);
    }
    this.requests.push({
      url: `${url.pathname}${url.search}`,
      method,
      headers,
      from: this.currentCaller,
    });
    return this.route(url, init);
  };

  private currentCaller: 'sw' | 'page' = 'sw';

  /** Runs the injected script with requests attributed to the page world. */
  async withPageCaller<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.currentCaller;
    this.currentCaller = 'page';
    try {
      return await work();
    } finally {
      this.currentCaller = previous;
    }
  }

  private route(url: URL, init?: RequestInit): Promise<Response> {
    const cfg = this.config;
    if (url.pathname === '/api/status') {
      if (cfg.status === 'fail') return Promise.resolve(new Response('', { status: 500 }));
      if (cfg.status === 'html') {
        return Promise.resolve(
          new Response('<html>login</html>', {
            headers: { 'Content-Type': 'text/html' },
          }),
        );
      }
      return Promise.resolve(jsonResponse((cfg.status as Record<string, unknown>) ?? DEFAULT_STATUS));
    }
    if (url.pathname === '/api/user/auth/refresh') {
      const method = init?.method ?? 'GET';
      switch (cfg.refresh) {
        case 'needs_login':
          return Promise.resolve(new Response('', { status: 401 }));
        case 'sw_needs_login':
          // Origin-checked deployments: only page-world refreshes are accepted.
          if (this.currentCaller === 'sw') {
            return Promise.resolve(new Response('', { status: 401 }));
          }
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: {
                access_token: SENTINEL_TOKEN,
                token_type: 'Bearer',
                user: { id: cfg.refreshAccount ?? 7 },
              },
            }),
          );
        case 'legacy_only':
          return Promise.resolve(new Response('', { status: 404 }));
        case 'network':
          return Promise.reject(new TypeError('network error'));
        case 'invalid':
          return Promise.resolve(jsonResponse({ success: false, message: 'invalid' }));
        case 'get_only':
          // Older deployments only accept GET; POST is absent.
          if (method === 'POST') return Promise.resolve(new Response('', { status: 404 }));
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: {
                access_token: SENTINEL_TOKEN,
                token_type: 'Bearer',
                user: { id: cfg.refreshAccount ?? 7 },
              },
            }),
          );
        default:
          // Current New API mainline: refresh is POST-only and returns the
          // account inside data.user.id (mirrors runanytime.hxi.me).
          if (method === 'GET') return Promise.resolve(new Response('', { status: 404 }));
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: {
                access_token: SENTINEL_TOKEN,
                access_expires_at: 1_800_000_000,
                session: 'mock-session',
                token_type: 'Bearer',
                user: { id: cfg.refreshAccount ?? 7 },
              },
            }),
          );
      }
    }
    if (url.pathname === '/api/user/checkin' && (init?.method ?? 'GET') === 'GET') {
      switch (cfg.checkin) {
        case 'checked':
          return Promise.resolve(
            jsonResponse({ success: true, data: { stats: { checked_in_today: true } } }),
          );
        case 'needs_login':
          return Promise.resolve(new Response('', { status: 401 }));
        case 'already_message':
          return Promise.resolve(
            jsonResponse({ success: false, message: 'already checked in today' }),
          );
        case 'invalid':
          return Promise.resolve(jsonResponse({ success: true, data: { stats: {} } }));
        default:
          return Promise.resolve(
            jsonResponse({ success: true, data: { stats: { checked_in_today: false } } }),
          );
      }
    }
    if (url.pathname === '/api/user/pow/challenge') {
      switch (cfg.challenge) {
        case 'needs_login':
          return Promise.resolve(new Response('', { status: 401 }));
        case 'invalid':
          return Promise.resolve(jsonResponse({ success: true, data: { difficulty: 'x' } }));
        case 'out_of_range':
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: { challenge_id: 'c1', prefix: 'p:', difficulty: 30 },
            }),
          );
        default:
          return Promise.resolve(
            jsonResponse({
              success: true,
              data: {
                challenge_id: 'challenge-1',
                prefix: 'private-prefix:',
                difficulty: cfg.challengeDifficulty ?? 18,
              },
            }),
          );
      }
    }
    if (url.pathname === '/api/user/checkin' && (init?.method ?? 'GET') === 'POST') {
      switch (cfg.submit) {
        case 'pow_stale':
          return Promise.resolve(
            jsonResponse({ success: false, message: 'challenge expired' }),
          );
        case 'needs_login':
          return Promise.resolve(new Response('', { status: 401 }));
        case 'turnstile_message':
          return Promise.resolve(
            jsonResponse({ success: false, message: 'turnstile verification required' }),
          );
        case 'invalid':
          return Promise.resolve(new Response('', { status: 500 }));
        default:
          return Promise.resolve(jsonResponse({ success: true, data: { reward: '3 credits' } }));
      }
    }
    return Promise.resolve(new Response('', { status: 404 }));
  }
}

type Listener = (message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => unknown;

class ListenerSet {
  readonly listeners: Listener[] = [];
  addListener(listener: Listener): void {
    this.listeners.push(listener);
  }
  removeListener(listener: Listener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }
  clear(): void {
    this.listeners.length = 0;
  }
}

export class MockBrowser {
  readonly tabsById = new Map<number, MockTab>();
  readonly grantedOrigins = new Set<string>();
  readonly createdAlarms = new Map<string, unknown>();
  readonly notifications: Array<{ id: string; title: string; message: string }> = [];
  readonly messageLog: RecordedMessage[] = [];
  readonly storageWrites: unknown[] = [];
  readonly consoleLog: string[] = [];
  readonly localData = new Map<string, unknown>();
  readonly sessionData = new Map<string, unknown>();
  readonly server = new MockSiteServer();
  readonly runtimeOnMessage = new ListenerSet();
  readonly runtimeOnInstalled = new ListenerSet();
  readonly runtimeOnStartup = new ListenerSet();
  readonly alarmListeners = new ListenerSet();
  readonly notificationClickListeners = new ListenerSet();
  readonly permissionAddedListeners = new ListenerSet();
  private nextTabId = 1;
  readonly removedTabs: number[] = [];
  readonly createdTabs: Array<{ url: string; active: boolean }> = [];
  /** When true, scripting.executeScript rejects like a navigated-away tab. */
  tabGone = false;
  powBehavior: PowSolverBehavior = 'solve';
  private powTaskIds = new Set<string>();
  private swChrome: any;

  constructor() {
    this.swChrome = this.buildSwChrome();
    (globalThis as any).chrome = this.swChrome;
    // The service worker's default fetch is the mock site server too.
    (globalThis as any).fetch = this.server.fetch;
    (globalThis as any).defineBackground ??= (fn: unknown) => ({ main: fn });
  }

  /** Browser API surface consumed by the extension (wxt/browser). */
  readonly browser = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: this.localData.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            this.localData.set(key, structuredClone(value));
            this.storageWrites.push(structuredClone(value));
          }
        },
        remove: async (key: string) => {
          this.localData.delete(key);
        },
      },
      session: {
        get: async (key: string) => ({ [key]: this.sessionData.get(key) }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            this.sessionData.set(key, structuredClone(value));
          }
        },
        remove: async (key: string) => {
          this.sessionData.delete(key);
        },
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
    tabs: {
      create: async (options: { url?: string; active?: boolean }) => {
        const id = this.nextTabId++;
        const url = options.url ?? 'chrome://newtab/';
        const tab: MockTab = { id, url, status: 'complete', active: options.active === true };
        this.tabsById.set(id, tab);
        this.createdTabs.push({ url, active: options.active === true });
        return tab;
      },
      get: async (tabId: number) => {
        const tab = this.tabsById.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return tab;
      },
      query: async (query: { url?: string }) => {
        const pattern = query.url ?? '';
        const prefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        return [...this.tabsById.values()].filter((tab) => tab.url.startsWith(prefix));
      },
      remove: async (tabId: number) => {
        this.removedTabs.push(tabId);
        this.tabsById.delete(tabId);
      },
    },
    scripting: {
      executeScript: async (options: {
        target: { tabId: number };
        world?: 'ISOLATED' | 'MAIN';
        func: (...args: any[]) => unknown;
        args?: unknown[];
      }) => {
        if (this.tabGone) throw new Error('The tab was closed.');
        const tab = this.tabsById.get(options.target.tabId);
        if (!tab) throw new Error(`No tab with id: ${options.target.tabId}.`);
        const args = options.args ?? [];
        if (options.world === 'MAIN') {
          return [{ result: options.func.apply(undefined, args) }];
        }
        // ISOLATED world: run the injected script with page-scoped globals.
        // Relative URLs resolve against the tab, like a real content script.
        const previousFetch = (globalThis as any).fetch;
        const previousChrome = (globalThis as any).chrome;
        try {
          (globalThis as any).fetch = (input: RequestInfo | URL, init?: RequestInit) =>
            this.server.fetch(new URL(String(input), tab.url), init);
          (globalThis as any).chrome = this.buildPageChrome(tab);
          const result = await this.server.withPageCaller(async () => {
            const value = options.func.apply(undefined, args);
            return value instanceof Promise ? value : Promise.resolve(value);
          });
          return [{ result }];
        } finally {
          (globalThis as any).fetch = previousFetch;
          (globalThis as any).chrome = previousChrome;
        }
      },
    },
    runtime: {
      onMessage: this.runtimeOnMessage,
      onInstalled: this.runtimeOnInstalled,
      onStartup: this.runtimeOnStartup,
      openOptionsPage: async () => undefined,
      getURL: (path: string) => `chrome-extension://checkin-pilot/${path.replace(/^\//, '')}`,
    },
    alarms: {
      create: async (name: string, info: unknown) => {
        this.createdAlarms.set(name, info);
      },
      clear: async (name: string) => {
        this.createdAlarms.delete(name);
      },
      onAlarm: this.alarmListeners,
    },
    notifications: {
      create: async (id: string, options: { title: string; message: string }) => {
        this.notifications.push({ id, title: options.title, message: options.message });
      },
      onClicked: this.notificationClickListeners,
    },
    permissions: {
      contains: async (request: { origins: string[] }) =>
        request.origins.every((pattern) =>
          [...this.grantedOrigins].some((origin) =>
            pattern === origin || pattern === `${origin}/*`,
          ),
        ),
      request: async (request: { origins: string[] }) => {
        request.origins.forEach((origin) => this.grantedOrigins.add(origin.replace(/\/\*$/, '')));
        return true;
      },
      remove: async (request: { origins: string[] }) => {
        request.origins.forEach((origin) =>
          this.grantedOrigins.delete(origin.replace(/\/\*$/, '')),
        );
        return true;
      },
      onAdded: this.permissionAddedListeners,
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
    },
    i18n: {
      getUILanguage: () => 'zh-CN',
    },
  };

  private buildSwChrome(): any {
    return {
      runtime: {
        sendMessage: (message: unknown) =>
          this.deliver({ from: 'sw', message, sender: { tab: undefined } }),
        getURL: (path: string) => `chrome-extension://checkin-pilot/${path.replace(/^\//, '')}`,
      },
      offscreen: {
        Reason: { WORKERS: 'WORKERS' },
        createDocument: async () => undefined,
        hasDocument: async () => true,
        closeDocument: async () => undefined,
      },
    };
  }

  private buildPageChrome(tab: MockTab): any {
    return {
      ...this.buildSwChrome(),
      runtime: {
        sendMessage: (message: unknown) =>
          this.deliver({
            from: 'page',
            message,
            sender: { tab: { id: tab.id, url: tab.url } },
          }),
        getURL: (path: string) =>
          `chrome-extension://checkin-pilot/${path.replace(/^\//, '')}`,
      },
    };
  }

  /** Chrome-style delivery: all contexts except the sender; first response wins. */
  private deliver(request: {
    from: 'sw' | 'page' | 'offscreen';
    message: unknown;
    sender: unknown;
  }): Promise<unknown> {
    this.messageLog.push({ from: request.from, message: request.message });
    const contexts: Array<{ listeners: ListenerSet; from: 'sw' | 'page' | 'offscreen' }> = [];
    if (request.from !== 'sw') contexts.push({ listeners: this.runtimeOnMessage, from: 'sw' });
    if (request.from !== 'offscreen') {
      contexts.push({ listeners: this.offscreenListenerSet, from: 'offscreen' });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let closedChannels = 0;
      const total = contexts.length;
      const settle = (value: unknown, delivered: boolean) => {
        if (settled) return;
        settled = true;
        if (delivered) resolve(value);
        else reject(new Error('The message port closed before a response was received.'));
      };
      if (total === 0) {
        settle(undefined, false);
        return;
      }
      for (const context of contexts) {
        let responded = false;
        let open = false;
        const sendResponse = (value: unknown) => {
          if (responded) return;
          responded = true;
          // Responses (including snapshots) are scanned for sentinel tokens.
          this.messageLog.push({ from: request.from, message: { __response: true, value } });
          settle(value, true);
        };
        for (const listener of context.listeners.listeners) {
          let result: unknown;
          try {
            result = listener(request.message, request.sender, sendResponse);
          } catch {
            result = undefined;
          }
          if (result === true) open = true;
          if (settled) return;
        }
        if (!open) {
          closedChannels += 1;
          if (closedChannels === total && !responded) settle(undefined, false);
        }
        // A keep-open channel waits for a later sendResponse; if the listener
        // never responds the promise stays pending, mirroring Chrome.
      }
    });
  }

  private readonly offscreenListenerSet = new ListenerSet();

  /** Installs the fake offscreen document listener (strict target routing). */
  installOffscreenDocument(): void {
    this.offscreenListenerSet.addListener(
      (message: unknown, _sender, sendResponse) => {
        if (!isOffscreenRequest(message)) return false;
        void this.solveOffscreen(message).then((result) => sendResponse(result));
        return true;
      },
    );
  }

  private async solveOffscreen(
    message: { type: 'pow:solve'; taskId: string; prefix: string; difficulty: number; maxMs: number } | { type: 'pow:cancel'; taskId: string },
  ): Promise<unknown> {
    if (message.type === 'pow:cancel') {
      return { status: 'cancelled', elapsedMs: 0 };
    }
    if (this.powTaskIds.has(message.taskId)) {
      return { status: 'error', elapsedMs: 0 };
    }
    this.powTaskIds.add(message.taskId);
    if (this.powBehavior === 'error') {
      return { status: 'error', elapsedMs: 0 };
    }
    if (this.powBehavior === 'timeout') {
      return { status: 'timeout', elapsedMs: 12_000 };
    }
    return { status: 'solved', nonce: '0000000a', elapsedMs: 25 };
  }

  grant(origin: string): void {
    this.grantedOrigins.add(origin);
  }

  seedTab(url: string): MockTab {
    const id = this.nextTabId++;
    const tab: MockTab = { id, url, status: 'complete', active: true };
    this.tabsById.set(id, tab);
    return tab;
  }

  reset(): void {
    this.tabsById.clear();
    this.grantedOrigins.clear();
    this.createdAlarms.clear();
    this.notifications.length = 0;
    this.messageLog.length = 0;
    this.storageWrites.length = 0;
    this.consoleLog.length = 0;
    this.localData.clear();
    this.sessionData.clear();
    this.removedTabs.length = 0;
    this.createdTabs.length = 0;
    this.tabGone = false;
    this.powBehavior = 'solve';
    this.powTaskIds.clear();
    this.nextTabId = 1;
    this.runtimeOnMessage.clear();
    this.runtimeOnInstalled.clear();
    this.runtimeOnStartup.clear();
    this.alarmListeners.clear();
    this.notificationClickListeners.clear();
    this.permissionAddedListeners.clear();
    this.offscreenListenerSet.clear();
    this.installOffscreenDocument();
    this.server.setConfig({});
  }

  /** Captures console output for sentinel scanning. */
  captureConsole(): void {
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        this.consoleLog.push(args.map(String).join(' '));
      });
    }
  }

  /** Fires a runtime message as if the popup sent it. */
  sendToBackground(message: unknown): Promise<unknown> {
    return this.deliver({ from: 'page', message, sender: { tab: undefined } });
  }

  /** Serialized storage snapshot (the normalized state under STORAGE_KEY). */
  storedState(): unknown {
    return this.localData.get('checkinPilotState');
  }
}

export class MockHarness {
  readonly browser = new MockBrowser();

  constructor() {
    this.browser.installOffscreenDocument();
    this.browser.captureConsole();
  }

  get server(): MockSiteServer {
    return this.browser.server;
  }

  get state(): any {
    return this.browser.storedState();
  }

  /** Imports and starts the real background entrypoint. */
  async startBackground(): Promise<void> {
    const module = await import('../../entrypoints/background');
    const definition = (module as { default?: unknown }).default as
      | { main: () => void }
      | undefined;
    if (!definition || typeof definition.main !== 'function') {
      throw new Error('background entrypoint did not export defineBackground({ main })');
    }
    definition.main();
  }

  async manualCheckin(origin: string): Promise<any> {
    return this.browser.sendToBackground({ type: 'site:manual-checkin', origin });
  }

  async probe(origin: string, options: { userId?: number; identitySource?: string; tabId?: number } = {}): Promise<any> {
    return this.browser.sendToBackground({
      type: 'site:probe',
      origin,
      ...(options.userId !== undefined ? { userId: options.userId } : {}),
      ...(options.identitySource !== undefined ? { identitySource: options.identitySource } : {}),
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
    });
  }

  async confirm(enrollment: Record<string, unknown>): Promise<any> {
    return this.browser.sendToBackground({ type: 'site:confirm', enrollment });
  }

  async upgrade(enrollment: Record<string, unknown>): Promise<any> {
    return this.browser.sendToBackground({ type: 'site:upgrade', enrollment });
  }

  async rename(origin: string, label: string): Promise<any> {
    return this.browser.sendToBackground({ type: 'site:rename', origin, label });
  }

  async runAll(): Promise<any> {
    return this.browser.sendToBackground({ type: 'batch:run-all' });
  }

  reset(): void {
    this.browser.reset();
  }

  /** Asserts the sentinel token appears nowhere outside the page world. */
  assertSentinelConfined(): void {
    const serializedMessages = JSON.stringify(this.browser.messageLog);
    const serializedStorage = JSON.stringify(this.browser.storageWrites);
    const serializedNotifications = JSON.stringify(this.browser.notifications);
    const serializedConsole = JSON.stringify(this.browser.consoleLog);
    if (serializedMessages.includes(SENTINEL_TOKEN)) {
      throw new Error('Sentinel token leaked into an extension message.');
    }
    if (serializedStorage.includes(SENTINEL_TOKEN)) {
      throw new Error('Sentinel token leaked into extension storage.');
    }
    if (serializedNotifications.includes(SENTINEL_TOKEN)) {
      throw new Error('Sentinel token leaked into a notification.');
    }
    if (serializedConsole.includes(SENTINEL_TOKEN)) {
      throw new Error('Sentinel token leaked into logs.');
    }
  }
}

export type { StorageAreaLike };
