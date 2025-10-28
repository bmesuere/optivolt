export function encodeConfigToQuery(obj, baseHref = location.href) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const u = new URL(baseHref);
  u.searchParams.set("cfg", urlSafe);
  return u.toString();
}

export function decodeConfigFromQuery(href = location.href) {
  const u = new URL(href);
  const cfg = u.searchParams.get("cfg");
  if (!cfg) return null;
  try {
    const b64 = cfg.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(escape(atob(b64)));
    return JSON.parse(json);
  } catch { return null; }
}
