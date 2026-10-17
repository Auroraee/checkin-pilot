import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { AppSnapshot } from '../shared/domain';
import type { AppRequest, AppResponse } from '../shared/messages';
import { sendAppMessage } from '../shared/runtime';

export interface AppSnapshotState {
  snapshot: AppSnapshot | undefined;
  loading: boolean;
  errorCode: string | undefined;
  refresh: () => Promise<void>;
  request: (request: AppRequest) => Promise<AppResponse>;
}

export function useAppSnapshot(): AppSnapshotState {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string>();
  const readSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++readSequence.current;
    const response = await sendAppMessage({ type: 'snapshot:get' }).catch(() => ({ ok: false as const, errorCode: 'unknown' }));
    if (sequence !== readSequence.current) return;
    if (response.ok && response.type === 'snapshot') {
      setSnapshot(response.snapshot);
      setErrorCode(undefined);
    } else if (!response.ok) {
      setErrorCode(response.errorCode);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName === 'local' && 'checkinPilotState' in changes) void refresh();
    };
    browser.storage.onChanged.addListener(onStorageChanged);
    const onMessage = (message: unknown) => {
      if (typeof message === 'object' && message !== null &&
          'target' in message && message.target === 'ui' &&
          'type' in message && message.type === 'snapshot:changed') void refresh();
    };
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    browser.runtime.onMessage.addListener(onMessage);
    document.addEventListener('visibilitychange', refreshVisible);
    // Refresh the local date and overdue retry text even without storage writes.
    const timer = window.setInterval(refreshVisible, 30_000);
    return () => {
      browser.storage.onChanged.removeListener(onStorageChanged);
      browser.runtime.onMessage.removeListener(onMessage);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.clearInterval(timer);
      readSequence.current += 1;
    };
  }, [refresh]);

  const request = useCallback(async (appRequest: AppRequest) => {
    const response = await sendAppMessage(appRequest).catch(() => ({ ok: false as const, errorCode: 'unknown' }));
    if (response.ok && 'snapshot' in response) {
      readSequence.current += 1;
      setSnapshot(response.snapshot);
      setErrorCode(undefined);
    } else if (!response.ok) {
      setErrorCode(response.errorCode);
    }
    return response;
  }, []);

  return { snapshot, loading, errorCode, refresh, request };
}
