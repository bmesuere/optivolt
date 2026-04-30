import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external I/O dependencies before importing the module under test
vi.mock('../../../api/services/settings-store.ts');
vi.mock('../../../api/services/data-store.ts');
vi.mock('../../../api/services/vrm-refresh.ts');
vi.mock('../../../api/services/mqtt-service.ts');

import { loadSettings, saveSettings } from '../../../api/services/settings-store.ts';
import { loadData, saveData } from '../../../api/services/data-store.ts';
import { refreshSeriesFromVrmAndPersist } from '../../../api/services/vrm-refresh.ts';
import { setDynamicEssSchedule } from '../../../api/services/mqtt-service.ts';
import { computePlan } from '../../../api/services/planner-service.ts';
import { FeedIn } from '../../../lib/dess-mapper.ts';

const NOW_STRING = '2024-01-01T00:00:00Z';
const NOW_MS = new Date(NOW_STRING).getTime();

// Minimal settings — use 60-min slots for a smaller LP
const baseSettings = {
  stepSize_m: 60,
  batteryCapacity_Wh: 10000,
  minSoc_percent: 20,
  maxSoc_percent: 100,
  maxChargePower_W: 1000,
  maxDischargePower_W: 1000,
  maxGridImport_W: 2000,
  maxGridExport_W: 2000,
  chargeEfficiency_percent: 100,
  dischargeEfficiency_percent: 100,
  batteryCost_cent_per_kWh: 0,
  idleDrain_W: 0,
  terminalSocValuation: 'zero',
  terminalSocCustomPrice_cents_per_kWh: 0,
  dataSources: { load: 'vrm', pv: 'vrm', prices: 'vrm', soc: 'mqtt' },
  dessAlgorithm: 'v1',
  rebalanceEnabled: false,
  rebalanceHoldHours: 2,
};

// 5 slots of data starting at NOW
const baseData = {
  load: { start: NOW_STRING, step: 60, values: [500, 500, 500, 500, 500] },
  pv: { start: NOW_STRING, step: 60, values: [0, 0, 0, 0, 0] },
  importPrice: { start: NOW_STRING, step: 60, values: [10, 10, 10, 10, 10] },
  exportPrice: { start: NOW_STRING, step: 60, values: [5, 5, 5, 5, 5] },
  soc: { timestamp: NOW_STRING, value: 50 },
};

describe('computePlan — rebalance bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_STRING));
    vi.resetAllMocks();
    refreshSeriesFromVrmAndPersist.mockResolvedValue();
    setDynamicEssSchedule.mockResolvedValue();
    saveSettings.mockResolvedValue();
    saveData.mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT set startMs when soc < maxSoc_percent (not at target yet)', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 50 }, rebalanceState: { startMs: null } });

    await computePlan();

    // saveData should not have been called with a non-null startMs
    const savedDataCalls = saveData.mock.calls;
    const rebalanceSave = savedDataCalls.find(([d]) => d.rebalanceState?.startMs != null);
    expect(rebalanceSave).toBeUndefined();
  });

  it('sets startMs when soc >= maxSoc_percent (battery reached target)', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true });
    loadData.mockResolvedValue({ ...baseData, soc: { timestamp: NOW_STRING, value: 100 }, rebalanceState: { startMs: null } });

    await computePlan();

    // saveData should have been called with startMs set to NOW_MS
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: NOW_MS } })
    );
  });

  it('clears startMs and disables rebalancing when cycle is complete (remainingSlots = 0)', async () => {
    // holdHours=2, stepSize=60min → holdSlots=2; started 2h ago → remainingSlots=0
    const startMs = NOW_MS - 2 * 60 * 60_000;
    loadSettings.mockResolvedValue({ ...baseSettings, rebalanceEnabled: true, rebalanceHoldHours: 2 });
    loadData.mockResolvedValue({ ...baseData, rebalanceState: { startMs } });

    await computePlan();

    // Settings should be saved with rebalanceEnabled = false
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceEnabled: false })
    );
    // Data should be saved with startMs = null
    expect(saveData).toHaveBeenCalledWith(
      expect.objectContaining({ rebalanceState: { startMs: null } })
    );
  });

  it('keeps feed-in allowed on negative export prices when blocking is disabled', async () => {
    loadSettings.mockResolvedValue({ ...baseSettings, blockFeedInOnNegativePrices: false });
    loadData.mockResolvedValue({
      ...baseData,
      exportPrice: { ...baseData.exportPrice, values: [-1, -1, -1, -1, -1] },
    });

    const result = await computePlan();

    expect(result.rows[0].dess.feedin).toBe(FeedIn.allowed);
  });
});
