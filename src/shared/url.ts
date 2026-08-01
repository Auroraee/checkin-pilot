export function normalizeHttpsOrigin(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function originPermissionPattern(origin: string): string {
  const normalized = normalizeHttpsOrigin(origin);
  if (!normalized) throw new Error('Only HTTPS origins are supported.');
  return `${normalized}/*`;
}
