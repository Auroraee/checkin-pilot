import { browser } from 'wxt/browser';
import {
  isPageIdentityResult,
  readPageIdentity,
  type PageIdentityResult,
} from '../shared/identity';

export type EnrollmentErrorCode =
  | 'no_active_tab'
  | 'https_required'
  | 'permission_denied'
  | 'identity_missing'
  | 'script_failed';

export class EnrollmentError extends Error {
  constructor(public readonly code: EnrollmentErrorCode) {
    super(code);
  }
}

export interface ActiveTabPage {
  tabId: number;
  origin: string;
  originPattern: string;
  label: string;
}

/** Mirrors the 120-character cap in the background's isSafeEnrollmentLabel. */
const MAX_SITE_LABEL_LENGTH = 120;

/**
 * Derives the stored site label from the tab title — the same page name the
 * browser pre-fills when bookmarking — falling back to the hostname when the
 * title is missing or unusable.
 */
export function siteLabelFromTabTitle(
  title: string | undefined,
  hostname: string,
): string {
  const normalized = title
    ?.replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SITE_LABEL_LENGTH);
  return normalized ? normalized : hostname;
}

export interface EnrollmentPage {
  origin: string;
  originPattern: string;
  label: string;
  userId: number;
  identitySource: PageIdentityResult['identitySource'];
}

export function exactOriginPattern(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return undefined;
    return `${url.origin}/*`;
  } catch {
    return undefined;
  }
}

/** Resolves the active HTTPS tab without requesting any permission. */
export async function inspectActiveTab(): Promise<ActiveTabPage> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new EnrollmentError('no_active_tab');

  const originPattern = exactOriginPattern(tab.url);
  if (!originPattern) throw new EnrollmentError('https_required');
  const url = new URL(tab.url);
  return {
    tabId: tab.id,
    origin: url.origin,
    originPattern,
    label: siteLabelFromTabTitle(tab.title, url.hostname),
  };
}

/** Requests the origin permission, then reads the page's numeric account ID. */
export async function readTabIdentity(page: ActiveTabPage): Promise<EnrollmentPage> {
  const granted = await browser.permissions.request({ origins: [page.originPattern] });
  if (!granted) throw new EnrollmentError('permission_denied');

  let identity: unknown;
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId: page.tabId },
      world: 'MAIN',
      func: readPageIdentity,
    });
    identity = results[0]?.result;
  } catch {
    throw new EnrollmentError('script_failed');
  }

  if (!isPageIdentityResult(identity)) throw new EnrollmentError('identity_missing');

  return {
    origin: page.origin,
    originPattern: page.originPattern,
    label: page.label,
    userId: identity.userId,
    identitySource: identity.identitySource,
  };
}

export async function revokeOrigin(origin: string): Promise<boolean> {
  const originPattern = exactOriginPattern(origin);
  if (!originPattern) return false;
  return browser.permissions.remove({ origins: [originPattern] });
}
