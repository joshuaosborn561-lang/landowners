/** ASP.NET WebForms helpers: carry VIEWSTATE / EVENTVALIDATION across GET → POST. */

export function decodeHtmlAttr(value: string): string {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function collectAspNetFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of String(html || '').matchAll(/<input\b([^>]*)>/gi)) {
    const tag = m[1] || '';
    const name = tag.match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const type = (tag.match(/\btype="([^"]+)"/i)?.[1] || 'text').toLowerCase();
    if (type === 'submit' || type === 'image' || type === 'button') continue;
    if (type === 'checkbox' && !/\bchecked\b/i.test(tag)) continue;
    fields[name] = decodeHtmlAttr(tag.match(/\bvalue="([^"]*)"/i)?.[1] ?? '');
  }
  for (const m of String(html || '').matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = (m[1] || '').match(/\bname="([^"]+)"/i)?.[1];
    if (!name) continue;
    const selected =
      (m[2] || '').match(/<option[^>]*\bselected\b[^>]*value="([^"]*)"/i)?.[1] ??
      (m[2] || '').match(/<option[^>]*value="([^"]*)"[^>]*\bselected\b/i)?.[1];
    const first = (m[2] || '').match(/<option[^>]*value="([^"]*)"/i)?.[1];
    fields[name] = decodeHtmlAttr(selected ?? first ?? '');
  }
  return fields;
}

export function mergeCookies(previous: string, setCookie: string[]): string {
  const map = new Map<string, string>();
  for (const part of previous.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  for (const raw of setCookie) {
    const pair = String(raw || '').split(';')[0] || '';
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function cookiesFrom(res: { headers: Headers }, previous = ''): string {
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return mergeCookies(previous, set);
}

export function cookiesFromList(setCookie: string[], previous = ''): string {
  return mergeCookies(previous, setCookie);
}

export function hasAspNetState(fields: Record<string, string>): boolean {
  return Boolean(fields.__VIEWSTATE);
}
