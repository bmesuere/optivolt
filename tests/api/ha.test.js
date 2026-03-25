import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../api/app.ts';

vi.mock('../../api/services/settings-store.ts');
vi.mock('../../api/services/ha-client.ts');

import { loadSettings } from '../../api/services/settings-store.ts';
import { fetchHaEntityState } from '../../api/services/ha-client.ts';

const mockSettings = {
  haUrl: 'ws://homeassistant.local:8123/api/websocket',
  haToken: 'test-token',
};

const mockEntityState = {
  entity_id: 'sensor.ev_battery_level',
  state: '75',
  attributes: { unit_of_measurement: '%' },
  last_changed: '2026-01-01T00:00:00Z',
  last_updated: '2026-01-01T00:00:00Z',
};

describe('GET /ha/entity/:entityId', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadSettings.mockResolvedValue(mockSettings);
  });

  it('returns entity state for a valid entity', async () => {
    fetchHaEntityState.mockResolvedValue(mockEntityState);

    const res = await request(app).get('/ha/entity/sensor.ev_battery_level');

    expect(res.status).toBe(200);
    expect(res.body.entity_id).toBe('sensor.ev_battery_level');
    expect(res.body.state).toBe('75');
    expect(fetchHaEntityState).toHaveBeenCalledWith({
      haUrl: mockSettings.haUrl,
      haToken: mockSettings.haToken,
      entityId: 'sensor.ev_battery_level',
    });
  });

  it('returns 422 when entity is not found in HA', async () => {
    fetchHaEntityState.mockRejectedValue(new Error('HA returned 404 for entity "sensor.unknown"'));

    const res = await request(app).get('/ha/entity/sensor.unknown');

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('404');
  });

  it('passes URL-decoded entity ID to fetchHaEntityState', async () => {
    fetchHaEntityState.mockResolvedValue(mockEntityState);

    await request(app).get('/ha/entity/sensor.test%20entity');

    expect(fetchHaEntityState).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'sensor.test entity' }),
    );
  });
});
