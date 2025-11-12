import express from 'express';

import { HttpError, assertCondition, toHttpError } from '../http-errors.js';
import { VRMClient } from '../../lib/vrm-api.js';

const router = express.Router();

function createClient() {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();

  assertCondition(installationId.length > 0, 400, 'installationId is required');
  assertCondition(token.length > 0, 400, 'token is required');

  return new VRMClient({
    installationId,
    token,
  });
}

function normalizeVrmError(error, message) {
  const status = error instanceof HttpError ? error.statusCode : 502;
  return toHttpError(error, status, message);
}


router.post('/settings', async (req, res, next) => {
  try {
    const client = createClient();
    const settings = await client.fetchDynamicEssSettings();
    res.json({ settings });
  } catch (error) {
    next(normalizeVrmError(error, 'Failed to fetch VRM settings'));
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
