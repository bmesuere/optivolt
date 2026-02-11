const root = document.documentElement;
const btn = document.getElementById('themeToggle');
const STORAGE_KEY = 'optivolt-theme'; // 'light' | 'dark' | null (system)
const mq = window.matchMedia('(prefers-color-scheme: dark)');

function getStoredTheme() {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark') return v;
  return null; // system
}

function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored) return stored;
  return mq.matches ? 'dark' : 'light'; // system preference
}

function applyTheme() {
  const theme = getEffectiveTheme();
  root.classList.toggle('dark', theme === 'dark');
  // color-scheme is handled by CSS: :root / :root.dark above
}

// Initial
applyTheme();

// If we're in "system" mode, react to OS changes
if (mq.addEventListener) {
  mq.addEventListener('change', () => {
    if (!getStoredTheme()) applyTheme();
  });
} else if (mq.addListener) {
  mq.addListener(() => {
    if (!getStoredTheme()) applyTheme();
  });
}

// Button cycles:
// system → opposite-of-system → other override → back to system
btn?.addEventListener('click', () => {
  const stored = getStoredTheme();
  let next = null;

  if (!stored) {
    // From system: go to explicit opposite so the toggle "does something"
    next = mq.matches ? 'light' : 'dark';
  } else if (stored === 'dark') {
    next = 'light';
  } else if (stored === 'light') {
    next = null; // back to system
  }

  if (next) {
    localStorage.setItem(STORAGE_KEY, next);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  applyTheme();
});
