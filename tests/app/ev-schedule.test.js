// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvScheduleController } from '../../app/src/ev-schedule.js';
import { createEvScheduleEntry } from '../../app/src/api/api.js';

vi.mock('../../app/src/api/api.js', () => ({
  fetchEvScheduleEntries: vi.fn(async () => ({ entries: [] })),
  createEvScheduleEntry: vi.fn(async () => ({ entries: [] })),
  updateEvScheduleEntry: vi.fn(async () => ({ entries: [] })),
  deleteEvScheduleEntry: vi.fn(async () => ({ entries: [] })),
}));

function setup() {
  const els = {
    evTripSocBuffer: Object.assign(document.createElement('input'), { type: 'number', value: '20' }),
    evScheduleEntriesList: document.createElement('ul'),
    evEntrySoc: document.createElement('input'),
    evEntryTripHint: Object.assign(document.createElement('p'), { className: 'hidden' }),
    evEntryTime: document.createElement('input'),
    evEntryEndTime: document.createElement('input'),
    step: Object.assign(document.createElement('input'), { type: 'number', value: '15' }),
    evEntryError: Object.assign(document.createElement('p'), { className: 'hidden' }),
    evEntryTimeClear: document.createElement('button'),
    evEntrySave: document.createElement('button'),
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

describe('ev schedule — the arrival field follows the departure', () => {
  const typeDeparture = (els, value) => {
    els.evEntryTime.value = value;
    els.evEntryTime.dispatchEvent(new Event('input'));
  };

  it('mirrors the departure into a blank arrival, and keeps following until edited', () => {
    const { controller, els } = setup();
    controller.openEditor(null);

    typeDeparture(els, '2099-05-01T08:00');
    expect(els.evEntryEndTime.value).toBe('2099-05-01T08:00');

    // Still untouched by the user, so a corrected departure carries over too.
    typeDeparture(els, '2099-05-02T09:15');
    expect(els.evEntryEndTime.value).toBe('2099-05-02T09:15');
  });

  it('stops following once the user edits the arrival', () => {
    const { controller, els } = setup();
    controller.openEditor(null);

    typeDeparture(els, '2099-05-01T08:00');
    els.evEntryEndTime.value = '2099-05-01T17:30';
    els.evEntryEndTime.dispatchEvent(new Event('input'));

    typeDeparture(els, '2099-05-01T08:30');
    expect(els.evEntryEndTime.value).toBe('2099-05-01T17:30');
  });

  it('leaves an existing entry\'s arrival alone when the departure is changed', () => {
    const { controller, els } = setup();
    controller.openEditor(trip);
    const arrival = els.evEntryEndTime.value;
    expect(arrival).not.toBe('');

    typeDeparture(els, '2099-05-01T09:00');
    expect(els.evEntryEndTime.value).toBe(arrival);
  });

  it('clears the arrival along with the departure while it is still following', () => {
    const { controller, els } = setup();
    controller.openEditor(null);

    typeDeparture(els, '2099-05-01T08:00');
    els.evEntryTimeClear.dispatchEvent(new Event('click'));
    expect(els.evEntryTime.value).toBe('');
    expect(els.evEntryEndTime.value).toBe('');
  });
});

describe('ev schedule — times snap to the planning grid', () => {
  async function saveTrip(els, time, endTime) {
    els.evEntryTime.value = time;
    els.evEntryEndTime.value = endTime;
    els.evEntrySave.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(createEvScheduleEntry).toHaveBeenCalled());
    return createEvScheduleEntry.mock.calls.at(-1)[0];
  }

  it('floors a hand-typed off-grid departure and arrival onto the block the solver uses', async () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    const payload = await saveTrip(els, '2099-05-01T08:07', '2099-05-01T17:23');

    expect(payload).toMatchObject({
      time: new Date('2099-05-01T08:00').toISOString(),
      endTime: new Date('2099-05-01T17:15').toISOString(),
    });
  });

  it('floors a time in the upper half of a block too, never forward', async () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    // 08:08 belongs to the 08:00 slot; storing 08:15 would give the plan a slot the car is gone for.
    const payload = await saveTrip(els, '2099-05-01T08:08', '2099-05-01T09:40');

    expect(payload).toMatchObject({
      time: new Date('2099-05-01T08:00').toISOString(),
      endTime: new Date('2099-05-01T09:30').toISOString(),
    });
  });

  it('keeps a trip shorter than one slot savable by stretching it to a single slot', async () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    const payload = await saveTrip(els, '2099-05-01T08:08', '2099-05-01T08:14');

    expect(payload).toMatchObject({
      time: new Date('2099-05-01T08:00').toISOString(),
      endTime: new Date('2099-05-01T08:15').toISOString(),
    });
  });

  it('still rejects an arrival that is not after the departure', async () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    createEvScheduleEntry.mockClear();
    els.evEntryTime.value = '2099-05-01T08:00';
    els.evEntryEndTime.value = '2099-05-01T08:00';
    els.evEntrySave.dispatchEvent(new Event('click'));

    expect(createEvScheduleEntry).not.toHaveBeenCalled();
    expect(els.evEntryError.textContent).toContain('Arrival must be after departure');
  });

  it('floors a hand-typed departure as soon as the field is left', () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    els.evEntryTime.value = '2099-05-01T08:07';
    els.evEntryTime.dispatchEvent(new Event('input'));
    els.evEntryTime.dispatchEvent(new Event('blur'));

    expect(els.evEntryTime.value).toBe('2099-05-01T08:00');
    // The arrival was still mirroring the departure, so it follows the snap.
    expect(els.evEntryEndTime.value).toBe('2099-05-01T08:00');
  });

  it('shows the one-slot stretch a sub-slot arrival gets on save', () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    els.evEntryTime.value = '2099-05-01T08:07';
    els.evEntryTime.dispatchEvent(new Event('blur'));
    els.evEntryEndTime.value = '2099-05-01T08:14';
    els.evEntryEndTime.dispatchEvent(new Event('input'));
    els.evEntryEndTime.dispatchEvent(new Event('blur'));

    expect(els.evEntryEndTime.value).toBe('2099-05-01T08:15');
  });

  it('leaves an arrival typed before the departure where it is', () => {
    const { controller, els } = setup();
    controller.openEditor(null);
    els.evEntryTime.value = '2099-05-01T09:00';
    els.evEntryTime.dispatchEvent(new Event('blur'));
    els.evEntryEndTime.value = '2099-05-01T08:07';
    els.evEntryEndTime.dispatchEvent(new Event('input'));
    els.evEntryEndTime.dispatchEvent(new Event('blur'));

    // Floored, but not pushed past the departure — saving must still report the ordering.
    expect(els.evEntryEndTime.value).toBe('2099-05-01T08:00');
    createEvScheduleEntry.mockClear();
    els.evEntrySave.dispatchEvent(new Event('click'));
    expect(createEvScheduleEntry).not.toHaveBeenCalled();
    expect(els.evEntryError.textContent).toContain('Arrival must be after departure');
  });

  it('floors on blur onto the configured step size too', () => {
    const { controller, els } = setup();
    els.step.value = '60';
    controller.openEditor(null);
    els.evEntryTime.value = '2099-05-01T08:17';
    els.evEntryTime.dispatchEvent(new Event('blur'));

    expect(els.evEntryTime.value).toBe('2099-05-01T08:00');
  });

  it('snaps onto the configured step size, not a hard-coded 15 minutes', async () => {
    const { controller, els } = setup();
    els.step.value = '60';
    controller.openEditor(null);
    const payload = await saveTrip(els, '2099-05-01T08:17', '2099-05-01T17:45');

    expect(payload).toMatchObject({
      time: new Date('2099-05-01T08:00').toISOString(),
      endTime: new Date('2099-05-01T17:00').toISOString(),
    });
    expect(els.evEntryTime.step).toBe('3600');
    expect(els.evEntryEndTime.step).toBe('3600');
  });
});
