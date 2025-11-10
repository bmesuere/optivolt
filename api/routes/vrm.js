import express from 'express';

import { HttpError, assertCondition, toHttpError } from '../http-errors.js';
import { VRMClient } from '../../lib/vrm-api.js';

const router = express.Router();

function createClient(body = {}) {
  const installationId = String(body.installationId ?? '').trim();
  const token = String(body.token ?? '').trim();

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
    const client = createClient(req.body);
    const settings = await client.fetchDynamicEssSettings();
    res.json({ settings });
  } catch (error) {
    next(normalizeVrmError(error, 'Failed to fetch VRM settings'));
  }
});

router.post('/timeseries', async (req, res, next) => {
  try {
    const client = createClient(req.body);
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
