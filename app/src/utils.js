export function toDatetimeLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/**
 * Index of the first plan row starting at or after the given time (an ISO string
 * or anything `Date` parses), or -1 when the time is absent, unparseable, or
 * beyond the last row. The one place schedule times are lined up with plan rows.
 */
export function rowIndexAtOrAfter(rows, time) {
  if (!time) return -1;
  const ms = new Date(time).getTime();
  if (!Number.isFinite(ms)) return -1;
  return rows.findIndex(r => r.timestampMs >= ms);
}

export function debounce(fn, wait = 250) {
  let timer = null;

  const debounced = (...args) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
