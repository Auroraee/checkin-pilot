import { browser } from 'wxt/browser';

const KEY = 'pendingEnrollment';
const TTL_MS = 10 * 60_000;

/**
 * Chrome closes the popup when the optional-permission dialog opens, killing
 * the enrollment flow mid-way. This session-scoped marker lets the background
 * resume the flow on permissions.onAdded, and lets a reopened popup surface
 * the visit-mode offer when automatic enrollment was not possible.
 */
export interface PendingEnrollmentMarker {
  origin: string;
  label: string;
  tabId: number;
  state: 'awaiting-permission' | 'visit-offer';
  createdAt: number;
}

function isMarker(value: unknown): value is PendingEnrollmentMarker {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PendingEnrollmentMarker>;
  return (
    typeof candidate.origin === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.tabId === 'number' &&
    (candidate.state === 'awaiting-permission' || candidate.state === 'visit-offer') &&
    typeof candidate.createdAt === 'number'
  );
}

export async function readPendingEnrollment(): Promise<PendingEnrollmentMarker | undefined> {
  try {
    const stored = await browser.storage.session.get(KEY);
    const marker = stored[KEY];
    if (!isMarker(marker)) return undefined;
    if (Date.now() - marker.createdAt > TTL_MS) {
      await clearPendingEnrollment();
      return undefined;
    }
    return marker;
  } catch {
    return undefined;
  }
}

export async function writePendingEnrollment(
  marker: PendingEnrollmentMarker,
): Promise<void> {
  try {
    await browser.storage.session.set({ [KEY]: marker });
  } catch {
    // Without session storage the flow degrades to a second manual click.
  }
}

export async function clearPendingEnrollment(): Promise<void> {
  try {
    await browser.storage.session.remove(KEY);
  } catch {
    // Stale markers expire via TTL.
  }
}
