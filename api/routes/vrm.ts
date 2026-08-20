import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { HttpError, toHttpError } from '../http-errors.ts';
import { refreshSettingsFromVrmAndPersist } from '../services/vrm-refresh.ts';
import { redactSettingsForClient } from '../settings-redaction.ts';
import { getVrmCredentials } from '../env.ts';

const router = express.Router();

function validateEnvOrThrow(): void {
  try {
    getVrmCredentials();
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
}

function asHttp(error: unknown, message: string, defaultStatus = 502): HttpError {
  const status = error instanceof HttpError ? error.statusCode : defaultStatus;
  return toHttpError(error, status, message);
}

router.post('/refresh-settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    validateEnvOrThrow();
    const saved = await refreshSettingsFromVrmAndPersist();
    res.json({ message: 'System settings updated from VRM and saved.', settings: redactSettingsForClient(saved) });
  } catch (error) {
    next(asHttp(error, 'Failed to refresh VRM system settings'));
  }
});

export default router;
