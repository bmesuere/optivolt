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

router.post('/refresh-settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    validateEnvOrThrow();
    const saved = await refreshSettingsFromVrmAndPersist();
    res.json({ message: 'System settings updated from VRM and saved.', settings: redactSettingsForClient(saved) });
  } catch (error) {
    next(toHttpError(error, 502, 'Failed to refresh VRM system settings'));
  }
});

export default router;
