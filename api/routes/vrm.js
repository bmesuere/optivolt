import express from 'express';

import { VRMClient } from '../../lib/vrm-api.js';

const router = express.Router();

function createClient({ installationId, token }) {
  if (!installationId || !token) {
    const err = new Error('installationId and token are required');
    err.statusCode = 400;
    throw err;
  }

  const client = new VRMClient({
    installationId: String(installationId).trim(),
    token: String(token).trim(),
  });

  return client;
}

function sendError(res, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
  const message = error?.message || 'VRM request failed';
  if (status >= 500) {
    console.error('VRM proxy error:', error);
  }
  res.status(status).json({ error: message });
}

router.post('/settings', async (req, res) => {
  try {
    const body = req.body ?? {};
    const client = createClient(body);

    const settings = await client.fetchDynamicEssSettings();
    res.json({ settings });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/timeseries', async (req, res) => {
  try {
    const body = req.body ?? {};
    const client = createClient(body);

    const [forecasts, prices, soc] = await Promise.all([
      client.fetchForecasts(),
      client.fetchPrices(),
      client.fetchCurrentSoc(),
    ]);

    res.json({ forecasts, prices, soc });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
