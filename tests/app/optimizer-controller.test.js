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

function setupController() {
  const rows = [{ tIdx: 0, timestampMs: 1714586400000, soc_percent: 55 }];
  const rebalanceWindow = { startIdx: 0, endIdx: 0 };
  const summary = { netGridCost_cents: 12.5 };
  const els = {
    cap: input('9000'),
    evDepartureTime: input('2026-05-01T18:30'),
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
    updateEvDepartureQuickSet: vi.fn(),
    updateEvPanel: vi.fn(),
    updatePlanMeta: vi.fn(),
    updateRebalanceNudgeUI: vi.fn(),
    updateSummaryUI: vi.fn(),
  };

  return {
    controller: createOptimizerController({ els, services }),
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
    expect(services.updatePlanMeta).toHaveBeenCalledWith(
      els,
      42,
      '2026-05-01T12:00:00.000Z',
    );
    expect(services.updateSummaryUI).toHaveBeenCalledWith(els, summary);
    expect(services.updateRebalanceNudgeUI).toHaveBeenCalledWith(els, undefined);

    const tableArgs = services.renderTable.mock.calls[0][0];
    expect(tableArgs.rows).toBe(rows);
    expect(tableArgs.cfg).toEqual({ batteryCapacity_Wh: 9000, stepSize_m: 30 });
    expect(tableArgs.targets).toEqual({ table: els.table, tableUnit: els.tableUnit });
    expect(tableArgs.showKwh).toBe(true);
    expect(tableArgs.showDess).toBe(false);
    expect(tableArgs.rebalanceWindow).toBe(rebalanceWindow);
    expect(tableArgs.evSettings).toEqual({
      departureTime: '2026-05-01T18:30',
      targetSoc_percent: 80,
    });

    expect(services.drawFlowsBarStackSigned).toHaveBeenCalledWith(
      els.flows,
      rows,
      30,
      rebalanceWindow,
      tableArgs.evSettings,
    );
    expect(services.drawSocChart).toHaveBeenCalledWith(els.soc, rows, 30, tableArgs.evSettings);
    expect(services.drawPricesStepLines).toHaveBeenCalledWith(els.prices, rows, 30);
    expect(services.drawLoadPvGrouped).toHaveBeenCalledWith(els.loadpv, rows, 30);
    expect(services.updateEvPanel).toHaveBeenCalledWith(els, rows, summary, 30);
    expect(services.updateEvDepartureQuickSet).toHaveBeenCalledWith(els, rows);
    expect(els.status.textContent).toBe('Plan updated');
    expect(els.run.disabled).toBe(false);
    expect(els.run.classList.contains('loading')).toBe(false);
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
});
