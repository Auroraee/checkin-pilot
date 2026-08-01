import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
    const response = await sendAppMessage({ type: 'snapshot:get' });
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
    return () => browser.storage.onChanged.removeListener(onStorageChanged);
  }, [refresh]);

  const request = useCallback(async (appRequest: AppRequest) => {
    const response = await sendAppMessage(appRequest);
    if (response.ok && 'snapshot' in response) {
      setSnapshot(response.snapshot);
      setErrorCode(undefined);
    } else if (!response.ok) {
      setErrorCode(response.errorCode);
    }
    return response;
  }, []);

  return { snapshot, loading, errorCode, refresh, request };
}
