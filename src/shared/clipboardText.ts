// Remove a small set of attribution parameters without reserializing the URL.
// Keep all other bytes (including encoded query values and fragments) intact.
const trackingKeys = new Set(['gclid', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid']);
const protectedKeys = new Set(['sig', 'signature', 'token', 'access_token', 'auth', 'authorization', 'policy', 'expires', 'key-pair-id']);

export function cleanClipboardUrl(text: string): string {
  if (text.length > 16_384 || !/^https?:\/\//i.test(text) || /[\s\u0000-\u001f\u007f]/.test(text)) return text;
  try {
    const url = new URL(text);
    if (!url.hostname || url.username || url.password) return text;
    const hash = text.indexOf('#');
    const end = hash < 0 ? text.length : hash;
    const question = text.indexOf('?');
    if (question < 0 || question > end) return text;
    const parts = text.slice(question + 1, end).split('&');
    const names = parts.map(part => decodeURIComponent(part.split('=', 1)[0].replace(/\+/g, ' ')).toLowerCase());
    if (names.some(name => protectedKeys.has(name) || name.startsWith('x-amz-') || name.startsWith('x-goog-'))) return text;
    const kept = parts.filter((_part, index) => !names[index].startsWith('utm_') && !trackingKeys.has(names[index]));
    if (kept.length === parts.length) return text;
    const query = kept.join('&');
    return text.slice(0, question) + (query ? `?${query}` : '') + text.slice(end);
  } catch { return text; }
}

export function clipboardSingleLine(text: string): string {
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').replace(/[\t ]+/g, ' ').trim();
}
