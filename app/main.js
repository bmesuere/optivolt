import { refreshVrmSettings } from "./src/api/api.js";
import { loadInitialConfig } from "./src/config-store.js";
import { initPredictionsTab } from "./src/predictions.js";
import {
  initDepartureDatetimeMin,
  refreshEvSensorStates,
  wireEvSensorInputs,
} from "./src/ev-settings.js";
import { initOptimizerQuickSettings } from "./src/optimizer-quick-settings.js";
import { createOptimizerController } from "./src/optimizer-controller.js";
import {
  getElements,
  wireGlobalInputs,
  wireVrmSettingInput,
} from "./src/ui-binding.js";
import {
  hydrateUI,
  updateTerminalCustomUI,
} from "./src/state.js";

// ---------- Helpers ----------
function revealCards(panel) {
  const cards = panel.querySelectorAll('.card');
  cards.forEach((card, i) => {
    card.style.animationDelay = `${i * 50}ms`;
    card.classList.add('revealed');
  });
}

// ---------- DOM ----------
const els = getElements();
const optimizer = createOptimizerController({ els });
let optimizerQuickSettings = null;

// ---------- Boot ----------
boot();

function setupTabSwitcher() {
  const ACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium bg-white text-ink shadow-sm dark:bg-slate-700 dark:text-slate-100 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';
  const INACTIVE_CLS = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 transition-all focus:outline-none focus:ring-2 focus:ring-sky-400/50';

  const tabs = [
    { tab: document.getElementById('tab-optimizer'),   panel: document.getElementById('panel-optimizer') },
    { tab: document.getElementById('tab-predictions'), panel: document.getElementById('panel-predictions') },
    { tab: document.getElementById('tab-ev'),          panel: document.getElementById('panel-ev') },
    { tab: document.getElementById('tab-settings'),    panel: document.getElementById('panel-settings') },
  ].filter(t => t.tab && t.panel);

  let activeIndex = 0;
  let pendingSwitch = null;

  function activateTab(newIndex) {
    // Update tab button styles immediately
    tabs.forEach(({ tab }, i) => {
      tab.setAttribute('aria-selected', String(i === newIndex));
      tab.className = i === newIndex ? ACTIVE_CLS : INACTIVE_CLS;
    });

    if (newIndex === activeIndex) return;

    // Cancel any in-progress transition and snap to clean state
    if (pendingSwitch !== null) {
      clearTimeout(pendingSwitch);
      pendingSwitch = null;
      tabs.forEach(({ panel }, i) => {
        panel.classList.remove('panel-exit', 'panel-enter');
        panel.classList.toggle('panel-hidden', i !== activeIndex);
      });
    }

    const outgoing = tabs[activeIndex];
    const incoming = tabs[newIndex];

    outgoing.panel.classList.add('panel-exit');

    pendingSwitch = setTimeout(() => {
      pendingSwitch = null;
      outgoing.panel.classList.add('panel-hidden');
      outgoing.panel.classList.remove('panel-exit');

      // Pre-reveal cards so they don't double-fade during the panel crossfade
      incoming.panel.querySelectorAll('.card').forEach(card => {
        card.style.animationDelay = '';
        card.classList.add('revealed');
      });

      // Show incoming, start transparent
      incoming.panel.classList.remove('panel-hidden');
      incoming.panel.classList.add('panel-enter');

      // Force reflow, then remove panel-enter to trigger fade-in transition
      incoming.panel.getBoundingClientRect();
      incoming.panel.classList.remove('panel-enter');

      activeIndex = newIndex;
    }, 200);
  }

  tabs.forEach(({ tab }, i) => tab.addEventListener('click', () => activateTab(i)));
  activateTab(0);
}

async function boot() {
  const { config: initialConfig, source } = await loadInitialConfig();

  hydrateUI(els, initialConfig);
  optimizerQuickSettings = initOptimizerQuickSettings({
    selectionInput: els.optimizerQuickSettingsSelection,
    section: els.optimizerQuickSettingsSection,
    body: els.optimizerQuickSettingsBody,
    onSelectionChange: () => {
      void optimizer.persistConfig();
    },
  });

  setupTabSwitcher();
  await initPredictionsTab();

  // Wire inputs with callbacks
  wireGlobalInputs(els, {
    onInput: () => {
      optimizer.queuePersistSnapshot();
      optimizer.debounceRun();
    },
    onSave: optimizer.queuePersistSnapshot,
    onRun: optimizer.onRun,
    onTableDisplayChange: optimizer.onTableDisplayChange,
    updateTerminalCustomUI: () => updateTerminalCustomUI(els),
  });

  wireVrmSettingInput(els, {
    onRefresh: onRefreshVrmSettings,
  });

  wireEvSensorInputs(els, {
    persistConfig: optimizer.persistConfig,
    persistConfigDebounced: optimizer.persistConfigDebounced,
    debounceRun: optimizer.debounceRun,
  });
  initDepartureDatetimeMin(els);

  if (els.status) {
    els.status.textContent =
      source === "api" ? "Loaded settings from API." : "No settings yet (use the VRM buttons).";
  }

  // Fire-and-forget: fetch HA sensor states so the EV Status card shows current values.
  // Not awaited — HA may be slow or unconfigured; the initial solve should not wait for it.
  void refreshEvSensorStates(els);

  // Initial compute
  await optimizer.onRun();

  // Reveal cards on the initial (optimizer) panel after first compute
  const optimizerPanel = document.getElementById('panel-optimizer');
  if (optimizerPanel) revealCards(optimizerPanel);
}

// ---------- Actions ----------
async function onRefreshVrmSettings() {
  try {
    if (els.status) els.status.textContent = "Refreshing system settings from VRM…";
    const payload = await refreshVrmSettings();
    const saved = payload?.settings || {};
    hydrateUI(els, saved);
    optimizerQuickSettings?.refresh();
    if (els.status) els.status.textContent = "System settings saved from VRM.";
  } catch (err) {
    console.error(err);
    if (els.status) els.status.textContent = `VRM error: ${err.message}`;
  }
}
