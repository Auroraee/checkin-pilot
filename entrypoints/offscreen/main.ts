/// <reference types="chrome" />

import {
  isOffscreenRequest,
  SinglePowWorkerController,
} from '../../src/pow/offscreen-controller';

const controller = new SinglePowWorkerController();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isOffscreenRequest(message)) return false;
  void controller.handle(message).then(sendResponse);
  return true;
});
