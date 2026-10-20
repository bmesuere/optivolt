const root = document.documentElement;
const btn = document.getElementById('themeToggle');
const STORAGE_KEY = 'optivolt-theme'; // 'light' | 'dark' | 'ha' | null (system)
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const HA_POLL_MS = 2000;

function getStoredTheme() {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'ha') return v;
  return null; // system
}

/**
 * Whether Home Assistant is showing its dark theme: true/false, or null when this page is not
 * embedded in Home Assistant. As an add-on the page runs in an ingress iframe on Home
 * Assistant's own origin, so the frontend's state can be read from the parent document.
 */
function getHaDarkMode() {
  try {
    if (window.parent === window) return null;
    const darkMode = window.parent.document.querySelector('home-assistant')?.hass?.themes?.darkMode;
    return typeof darkMode === 'boolean' ? darkMode : null;
  } catch {
    return null; // cross-origin parent: not Home Assistant's ingress
  }
}

function getEffectiveTheme() {
  const stored = getStoredTheme();
  if (stored === 'light' || stored === 'dark') return stored;
  // Following Home Assistant falls back to the system preference outside it.
  const haDark = stored === 'ha' ? getHaDarkMode() : null;
  return (haDark ?? mq.matches) ? 'dark' : 'light';
}

const MODE_TITLE = {
  light: 'Theme: light',
  dark: 'Theme: dark',
  ha: 'Theme: follows Home Assistant',
  system: 'Theme: follows the system',
};

let appliedTheme = null;

function applyTheme() {
  const theme = getEffectiveTheme();
  if (btn) {
    const title = `${MODE_TITLE[getStoredTheme() ?? 'system']} (click to change)`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
  if (theme === appliedTheme) return;
  appliedTheme = theme;
  root.classList.toggle('dark', theme === 'dark');
  // color-scheme is handled by CSS: :root / :root.dark above
  window.dispatchEvent(new CustomEvent('optivolt:themechange', { detail: { theme } }));
}

// Initial
applyTheme();

// In "system" mode (and in "ha" mode outside Home Assistant), react to OS changes
const followsSystem = () => getStoredTheme() !== 'light' && getStoredTheme() !== 'dark';
if (mq.addEventListener) {
  mq.addEventListener('change', () => {
    if (followsSystem()) applyTheme();
  });
} else if (mq.addListener) {
  mq.addListener(() => {
    if (followsSystem()) applyTheme();
  });
}

// Home Assistant does not announce a theme change to its iframes, so in "ha" mode look again
// every couple of seconds; applyTheme does nothing while the theme is unchanged.
setInterval(() => {
  if (getStoredTheme() === 'ha') applyTheme();
}, HA_POLL_MS);

// Button cycles:
// system → opposite-of-system → other override → Home Assistant (when embedded in it) → system
btn?.addEventListener('click', () => {
  const stored = getStoredTheme();
  let next = null;

  if (!stored) {
    // From system: go to explicit opposite so the toggle "does something"
    next = mq.matches ? 'light' : 'dark';
  } else if (stored === 'dark') {
    next = 'light';
  } else if (stored === 'light') {
    next = getHaDarkMode() != null ? 'ha' : null; // "ha" is only offered inside Home Assistant
  } else if (stored === 'ha') {
    next = null; // back to system
  }

  if (next) {
    localStorage.setItem(STORAGE_KEY, next);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }

  applyTheme();
});
