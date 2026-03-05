// ---------- DOM helpers ----------

export function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

export function getVal(id) {
  return document.getElementById(id)?.value ?? '';
}

export function parseSilently(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// ---------- Timing ----------

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
