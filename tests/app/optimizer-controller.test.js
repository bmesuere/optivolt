// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOptimizerController } from '../../app/src/optimizer-controller.js';

function checkbox(checked = false) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  return input;
}

function input(value = '') {
  const element = document.createElement('input');
  element.value = value;
  return element;
}

function immediateDebounce(fn) {
  const debounced = vi.fn((...args) => fn(...args));
  debounced.cancel = vi.fn();
  return debounced;
}

function setupController(overrides = {}) {
  const rows = [{ tIdx: 0, timestampMs: 1714586400000, soc_percent: 55 }];
  const rebalanceWindow = { startIdx: 0, endIdx: 0 };
  const summary = { netGridCost_cents: 12.5 };
  const els = {
    cap: input('9000'),
    evDepartureTime: input('2026-05-01T18:30'),
    evDepartureTargetSoc: input('80'),
    evEnabled: checkbox(true),
    evTargetSoc: input('80'),
    flows: document.createElement('canvas'),
    loadpv: document.createElement('canvas'),
    prices: document.createElement('canvas'),
    pushToVictron: checkbox(false),
    run: document.createElement('button'),
    soc: document.createElement('canvas'),
    status: document.createElement('div'),
    step: input('30'),
    table: document.createElement('table'),
    tableDess: checkbox(false),
    tableKwh: checkbox(true),
    tableUnit: document.createElement('span'),
    updateDataBeforeRun: checkbox(true),
  };
  const services = {
    debounce: vi.fn((fn) => immediateDebounce(fn)),
    drawFlowsBarStackSigned: vi.fn(),
    drawLoadPvGrouped: vi.fn(),
    drawPricesStepLines: vi.fn(),
    drawSocChart: vi.fn(),
    renderTable: vi.fn(),
    requestRemoteSolve: vi.fn().mockResolvedValue({
      initialSoc_percent: 42,
      rebalanceWindow,
      rows,
      solverStatus: 'optimal',
      summary,
      tsStart: '2026-05-01T12:00:00.000Z',
    }),
    saveConfig: vi.fn().mockResolvedValue(undefined),
    snapshotUI: vi.fn(() => ({ tableShowKwh: els.tableKwh.checked })),
    updateEvPanel: vi.fn(),
    updatePlanMeta: vi.fn(),
    updateRebalanceNudgeUI: vi.fn(),
    updateSummaryUI: vi.fn(),
  };

  const evEntries = [{ type: 'departure', time: '2026-05-01T18:30', soc_percent: 80 }];
  return {
    controller: createOptimizerController({ els, services, getEvEntries: () => evEntries, ...overrides }),
    els,
    rebalanceWindow,
    rows,
    services,
    summary,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('optimizer controller', () => {
  it('persists settings, solves remotely, and renders optimizer outputs', async () => {
    const { controller, els, rebalanceWindow, rows, services, summary } = setupController();

    await controller.onRun();

    expect(services.saveConfig).toHaveBeenCalledWith({ tableShowKwh: true });
    expect(services.requestRemoteSolve).toHaveBeenCalledWith({
      updateData: true,
      writeToVictron: false,
    });
    // Plan end is the last planned slot's start, not the boundary after it.
    expect(services.updatePlanMeta).toHaveBeenCalledWith(
      els,
      '2026-05-01T12:00:00.000Z',
      1714586400000,
    );
    expect(services.updateSummaryUI).toHaveBeenCalledWith(els, summary);
    expect(services.updateRebalanceNudgeUI).toHaveBeenCalledWith(els, undefined);

    const tableArgs = services.renderTable.mock.calls[0][0];
    expect(tableArgs.rows).toBe(rows);
    expect(tableArgs.cfg).toEqual({ batteryCapacity_Wh: 9000, stepSize_m: 30 });
    expect(tableArgs.targets).toEqual({ table: els.table, tableUnit: els.tableUnit });
    expect(tableArgs.showKwh).toBe(true);
    expect(tableArgs.showDess).toBe(false);
    expect(tableArgs.rebalanceWindow).toEqual(rebalanceWindow);
    expect(tableArgs.evSettings).toEqual({
      arrivals: [],
      departures: ['2026-05-01T18:30'],
      targets: [{ time: '2026-05-01T18:30', soc_percent: 80 }],
      trips: [],
    });

    expect(services.drawFlowsBarStackSigned).toHaveBeenCalledWith(
      els.flows,
      rows,
      30,
      rebalanceWindow,
      tableArgs.evSettings,
    );
    expect(services.drawSocChart).toHaveBeenCalledWith(els.soc, rows, 30, tableArgs.evSettings);
    expect(services.drawPricesStepLines).toHaveBeenCalledWith(els.prices, rows, 30, null);
    expect(services.drawLoadPvGrouped).toHaveBeenCalledWith(els.loadpv, rows, 30);
    expect(services.updateEvPanel).toHaveBeenCalledWith(els, rows, summary, 30, tableArgs.evSettings);
    expect(els.status.textContent).toBe('Plan updated');
    expect(els.run.disabled).toBe(false);
    expect(els.run.classList.contains('loading')).toBe(false);
  });

  it('keeps a solved plan on screen when rendering throws', async () => {
    const { controller, els, services, summary } = setupController();
    services.drawSocChart.mockImplementation(() => {
      throw new Error('canvas exploded');
    });

    await controller.onRun();

    // The solve succeeded — and may already have been written to Victron — so the summary must
    // survive, and the failure has to read as a display problem rather than a planning one.
    expect(services.updateSummaryUI).toHaveBeenCalledWith(els, summary);
    expect(services.updateSummaryUI).not.toHaveBeenCalledWith(els, null);
    expect(els.status.textContent).toBe('Plan calculated, but display failed: canvas exploded');
    expect(els.run.disabled).toBe(false);
  });

  it('reports a failed solve and clears the summary', async () => {
    const { controller, els, services } = setupController();
    services.requestRemoteSolve.mockRejectedValue(new Error('solver unavailable'));

    await controller.onRun();

    expect(services.updateSummaryUI).toHaveBeenCalledWith(els, null);
    expect(els.status.textContent).toBe('Error: solver unavailable');
    expect(els.run.disabled).toBe(false);
  });

  it('renders the EV panel when the EV toggle is off', async () => {
    const { controller, els, services } = setupController();
    els.evEnabled.checked = false;

    await controller.onRun();

    // getEvSettings returns null with EV off; the panel has to survive it.
    expect(services.updateEvPanel).toHaveBeenCalledWith(els, expect.anything(), expect.anything(), 30, null);
    expect(els.status.textContent).toBe('Plan updated');
  });

  it('re-renders cached table rows when table display toggles change', async () => {
    const { controller, els, services } = setupController();
    await controller.onRun();
    services.renderTable.mockClear();
    services.saveConfig.mockClear();

    els.tableKwh.checked = false;
    controller.onTableDisplayChange({ currentTarget: els.tableKwh });
    await Promise.resolve();

    expect(services.renderTable).toHaveBeenCalledTimes(1);
    expect(services.renderTable.mock.calls[0][0].showKwh).toBe(false);
    expect(services.saveConfig).toHaveBeenCalledWith({ tableShowKwh: false });
  });

  it('marks the chart placeholders as calculating while a solve is in flight', async () => {
    document.body.innerHTML = `
      <div id="panel-optimizer"><div class="chart-empty"><span>Run the optimizer to see results</span></div></div>
      <div id="panel-ev"><div class="chart-empty"><span>Run the optimizer to see results</span></div></div>`;
    const texts = () => [...document.querySelectorAll('.chart-empty span')].map(s => s.textContent);

    const { controller, services } = setupController();
    let releaseSolve;
    services.requestRemoteSolve.mockImplementation(
      () => new Promise(resolve => { releaseSolve = resolve; }),
    );

    const run = controller.onRun();
    // Set synchronously, before the awaited config persist.
    expect(texts()).toEqual(['Calculating…', 'Calculating…']);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(texts()).toEqual(['Calculating…', 'Calculating…']);

    releaseSolve({ rows: [], solverStatus: 'Optimal', summary: {} });
    await run;
  });

  it('restores the actionable placeholder when a solve fails', async () => {
    document.body.innerHTML =
      '<div id="panel-optimizer"><div class="chart-empty"><span>x</span></div></div>';

    const { controller, services } = setupController();
    services.requestRemoteSolve.mockRejectedValue(new Error('boom'));

    await controller.onRun();

    expect(document.querySelector('.chart-empty span').textContent)
      .toBe('Run the optimizer to see results');
  });

  it('re-reads the cached forecasts when the server regenerated them', async () => {
    const onForecastsRefreshed = vi.fn();
    const { controller, services } = setupController({ onForecastsRefreshed });
    services.saveConfig.mockResolvedValue({ forecastsRefreshed: true });

    await controller.persistConfig();

    expect(onForecastsRefreshed).toHaveBeenCalledTimes(1);
  });

  it('leaves the cached forecasts alone when the server did not regenerate', async () => {
    const onForecastsRefreshed = vi.fn();
    const { controller, services } = setupController({ onForecastsRefreshed });
    services.saveConfig.mockResolvedValue({ forecastsRefreshed: false });

    await controller.persistConfig();

    expect(onForecastsRefreshed).not.toHaveBeenCalled();
  });
});
