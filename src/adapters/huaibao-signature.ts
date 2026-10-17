/** Protocol observed in Huainova's public check-in client. Keep origin-scoped. */
export const HUAIBAO_ORIGIN = 'https://ai.huaibao.top';

export function isCheckinNonce(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_096;
}

/** One bounded digest; the server nonce and signature stay in request-local memory. */
export async function huaibaoSignatureHeaders(userId: number, nonce: string): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${timestamp}:${nonce}`));
  const signature = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { 'X-Checkin-Timestamp': timestamp, 'X-Checkin-Signature': signature };
}
