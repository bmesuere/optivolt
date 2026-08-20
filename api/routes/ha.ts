import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { assertCondition, toHttpError } from '../http-errors.ts';
import { loadSettings } from '../services/settings-store.ts';
import { fetchHaEntityState } from '../services/ha-client.ts';
import { isAddon } from '../env.ts';

const router = express.Router();

router.get('/entity/:entityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const entityId = req.params.entityId as string;
    assertCondition(!!entityId, 400, 'entityId is required');

    const settings = await loadSettings();
    assertCondition(
      !!settings.haUrl || isAddon(),
      422,
      'HA URL is not configured',
    );

    let state;
    try {
      state = await fetchHaEntityState({
        haUrl: settings.haUrl,
        haToken: settings.haToken,
        entityId,
      });
    } catch (error) {
      // A bad entity id or an unreachable HA is the caller's problem, not ours.
      throw toHttpError(error, 422, error instanceof Error ? error.message : 'Failed to fetch entity state');
    }

    res.json(state);
  } catch (error) {
    next(toHttpError(error, 500, 'Failed to read the Home Assistant entity'));
  }
});

export default router;
