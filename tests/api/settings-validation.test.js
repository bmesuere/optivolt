import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The settings store resolves DATA_DIR at module load, so point it at a temp
// dir before the app (and its stores) are imported. No mocks here: these tests
// exercise the real validate-on-save path end to end.
const tmpDir = await mkdtemp(path.join(tmpdir(), 'optivolt-settings-test-'));
process.env.DATA_DIR = tmpDir;
const { default: app } = await import('../../api/app.ts');

const settingsPath = path.join(tmpDir, 'settings.json');

async function readPersisted() {
  return JSON.parse(await readFile(settingsPath, 'utf8'));
}

describe('POST /settings validation', () => {
  beforeEach(async () => {
    await rm(settingsPath, { force: true });
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects an invalid numeric value with a 400 and persists nothing', async () => {
    const res = await request(app).post('/settings').send({ stepSize_m: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid numeric setting: stepSize_m');
    // Nothing was written, so a subsequent load still works.
    await expect(readFile(settingsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const get = await request(app).get('/settings');
    expect(get.status).toBe(200);
    expect(get.body.stepSize_m).toBe(15);
  });

  it('drops unknown keys from the payload and the persisted file', async () => {
    const res = await request(app).post('/settings').send({ bogusKey: 42, stepSize_m: 30 });

    expect(res.status).toBe(200);
    expect(res.body.settings.stepSize_m).toBe(30);
    expect(res.body.settings).not.toHaveProperty('bogusKey');

    const persisted = await readPersisted();
    expect(persisted.stepSize_m).toBe(30);
    expect(persisted).not.toHaveProperty('bogusKey');
  });

  it('filters unknown nested dataSources keys and merges known ones', async () => {
    const res = await request(app)
      .post('/settings')
      .send({ dataSources: { load: 'api', bogus: 'x' } });

    expect(res.status).toBe(200);
    expect(res.body.settings.dataSources).toEqual({
      prices: 'vrm',
      load: 'api',
      pv: 'vrm',
      soc: 'mqtt',
    });

    const persisted = await readPersisted();
    expect(persisted.dataSources).toEqual({ prices: 'vrm', load: 'api', pv: 'vrm', soc: 'mqtt' });
  });

  it('returns the clamped settings and round-trips them through GET', async () => {
    const res = await request(app)
      .post('/settings')
      .send({ minSoc_percent: -10, evTripSocBuffer_percent: 250 });

    expect(res.status).toBe(200);
    expect(res.body.settings.minSoc_percent).toBe(0);
    expect(res.body.settings.evTripSocBuffer_percent).toBe(100);

    const persisted = await readPersisted();
    expect(persisted.minSoc_percent).toBe(0);
    expect(persisted.evTripSocBuffer_percent).toBe(100);

    const get = await request(app).get('/settings');
    expect(get.status).toBe(200);
    expect(get.body.minSoc_percent).toBe(0);
    expect(get.body.evTripSocBuffer_percent).toBe(100);
  });
});
