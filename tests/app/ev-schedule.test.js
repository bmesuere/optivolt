// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createEvScheduleController } from '../../app/src/ev-schedule.js';

function setup() {
  const els = {
    evTripSocBuffer: Object.assign(document.createElement('input'), { type: 'number', value: '20' }),
    evScheduleEntriesList: document.createElement('ul'),
    evEntrySoc: document.createElement('input'),
    evEntryTripHint: Object.assign(document.createElement('p'), { className: 'hidden' }),
  };
  const controller = createEvScheduleController({ els });
  controller.wireEditor();
  return { controller, els };
}

const trip = {
  id: 't1',
  type: 'trip',
  time: '2099-05-01T08:00:00.000Z',
  endTime: '2099-05-01T17:00:00.000Z',
  usage_percent: 25,
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ev schedule — derived targets follow the global trip buffer', () => {
  it('rerenders the list badges when the buffer setting changes', () => {
    const { controller, els } = setup();
    controller.setEntries([trip]);
    expect(els.evScheduleEntriesList.innerHTML).toContain('≥45%'); // 25% usage + 20% buffer

    els.evTripSocBuffer.value = '30';
    els.evTripSocBuffer.dispatchEvent(new Event('input'));
    expect(els.evScheduleEntriesList.innerHTML).toContain('≥55%');
  });

  it('updates an open editor hint when the buffer setting changes', () => {
    const { controller, els } = setup();
    controller.openEditor(null); // a new entry defaults to a trip draft
    els.evEntrySoc.value = '25';
    els.evEntrySoc.dispatchEvent(new Event('input'));
    expect(els.evEntryTripHint.textContent).toContain('≥ 45%');

    els.evTripSocBuffer.value = '30';
    els.evTripSocBuffer.dispatchEvent(new Event('input'));
    expect(els.evEntryTripHint.textContent).toContain('≥ 55%');
  });
});
