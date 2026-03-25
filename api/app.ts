import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { HttpError, toHttpError } from './http-errors.ts';
import calculateRouter from './routes/calculate.ts';
import settingsRouter from './routes/settings.ts';
import dataRouter from './routes/data.ts';
import vrmRouter from './routes/vrm.ts';
import predictionsRouter from './routes/predictions.ts';
import haRouter from './routes/ha.ts';
import evRouter from './routes/ev.ts';

const app = express();
app.disable('x-powered-by');

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticDir = join(__dirname, '../app');

app.use(express.json({ limit: '1mb' }));

app.use('/calculate', calculateRouter);
app.use('/settings', settingsRouter);
app.use('/data', dataRouter);
app.use('/vrm', vrmRouter);
app.use('/predictions', predictionsRouter);
app.use('/ha', haRouter);
app.use('/ev', evRouter);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ message: 'Optivolt API is running.' });
});

app.use(express.static(staticDir));

app.use((_req: Request, _res: Response, next: NextFunction) => {
  next(new HttpError(404, 'Not found'));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const httpError = toHttpError(err);

  if (httpError.statusCode >= 500) {
    console.error(`Unhandled error for ${_req.method} ${_req.originalUrl}:`, err);
  }

  const payload: Record<string, unknown> = { error: httpError.message };
  if (httpError.expose && httpError.details) {
    payload.details = httpError.details;
  }

  res.status(httpError.statusCode).json(payload);
});

export default app;
