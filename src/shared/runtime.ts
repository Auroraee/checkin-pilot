import { browser } from 'wxt/browser';
import type { AppRequest, AppResponse } from './messages';

export async function sendAppMessage(request: AppRequest): Promise<AppResponse> {
  const response: unknown = await browser.runtime.sendMessage(request);
  if (
    typeof response !== 'object' ||
    response === null ||
    !('ok' in response) ||
    typeof response.ok !== 'boolean'
  ) {
    return { ok: false, errorCode: 'invalid_extension_response' };
  }
  return response as AppResponse;
}
