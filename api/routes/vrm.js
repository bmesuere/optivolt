import express from 'express';

import { HttpError, assertCondition, toHttpError } from '../http-errors.js';
import { loadSettings, updateSettings } from '../settings-store.js';
import { VRMClient } from '../../lib/vrm-api.js';

const router = express.Router();

function createClient() {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();

  assertCondition(installationId.length > 0, 400, 'VRM Site ID not configured in add-on settings');
  assertCondition(token.length > 0, 400, 'VRM API token not configured in add-on settings');

  return new VRMClient({
    installationId,
    token,
  });
}

function normalizeVrmError(error, message) {
  const status = error instanceof HttpError ? error.statusCode : 502;
  return toHttpError(error, status, message);
}


function pickFinite(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  return undefined;
}

function mapVrmToSystem(vrmSettings = {}) {
  const limits = vrmSettings.limits ?? {};
  const system = {};

  const add = (key, ...candidates) => {
    const value = pickFinite(...candidates);
    if (value !== undefined) {
      system[key] = value;
    }
  };

  add('batteryCapacity_Wh', vrmSettings.batteryCapacity_Wh);
  add('maxDischargePower_W', vrmSettings.dischargePower_W, limits.batteryDischargeLimit_W);
  add('maxChargePower_W', vrmSettings.chargePower_W, limits.batteryChargeLimit_W);
  add('maxGridImport_W', vrmSettings.maxPowerFromGrid_W, limits.gridImportLimit_W);
  add('maxGridExport_W', vrmSettings.maxPowerToGrid_W, limits.gridExportLimit_W);
  add('batteryCost_cent_per_kWh', vrmSettings.batteryCosts_cents_per_kWh);

  return system;
}


router.post('/settings', async (req, res, next) => {
  try {
    const client = createClient();
    const vrmSettings = await client.fetchDynamicEssSettings();
    const systemPatch = mapVrmToSystem(vrmSettings);

    const updated = Object.keys(systemPatch).length
      ? await updateSettings({ system: systemPatch })
      : await loadSettings();

    res.json({ settings: updated });
  } catch (error) {
    next(normalizeVrmError(error, 'Failed to sync VRM settings'));
  }
});

router.post('/timeseries', async (req, res, next) => {
  try {
    const client = createClient();
    const [forecasts, prices, soc] = await Promise.all([
      client.fetchForecasts(),
      client.fetchPrices(),
      client.fetchCurrentSoc(),
    ]);

    res.json({ forecasts, prices, soc });
  } catch (error) {
    next(normalizeVrmError(error, 'Failed to fetch VRM data'));
  }
});

export default router;
