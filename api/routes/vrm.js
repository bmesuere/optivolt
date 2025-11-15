import express from 'express';
import { HttpError, assertCondition, toHttpError } from '../http-errors.js';
import {
  refreshSettingsFromVrmAndPersist
} from '../services/vrm-refresh.js';

const router = express.Router();

function validateEnvOrThrow() {
  const installationId = (process.env.VRM_INSTALLATION_ID ?? '').trim();
  const token = (process.env.VRM_TOKEN ?? '').trim();
  assertCondition(installationId.length > 0, 400, 'VRM Site ID not configured in add-on settings');
  assertCondition(token.length > 0, 400, 'VRM API token not configured in add-on settings');
}
function asHttp(error, message, defaultStatus = 502) {
  const status = error instanceof HttpError ? error.statusCode : defaultStatus;
  return toHttpError(error, status, message);
}

// Refresh only static-ish system settings (persist)
router.post('/refresh-settings', async (_req, res, next) => {
  try {
    validateEnvOrThrow();
    const saved = await refreshSettingsFromVrmAndPersist();
    res.json({ message: 'System settings updated from VRM and saved.', settings: saved });
  } catch (error) {
    next(asHttp(error, 'Failed to refresh VRM system settings'));
  }
});

export default router;
