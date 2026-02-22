import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { HttpError, toHttpError } from './http-errors.js';
import calculateRouter from './routes/calculate.js';
import settingsRouter from './routes/settings.js';
import dataRouter from './routes/data.js';
import vrmRouter from './routes/vrm.js';
import predictionsRouter from './routes/predictions.js';

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

app.get('/health', (_req, res) => {
  res.json({ message: 'Optivolt API is running.' });
});

app.use(express.static(staticDir));

app.use((req, res, next) => {
  next(new HttpError(404, 'Not found'));
});

app.use((err, req, res, _next) => {
  const httpError = toHttpError(err);
  const status = httpError.statusCode ?? 500;

  if (status >= 500) {
    console.error(`Unhandled error for ${req.method} ${req.originalUrl}:`, err);
  }

  const payload = { error: httpError.message };
  if (httpError.expose && httpError.details) {
    payload.details = httpError.details;
  }

  res.status(status).json(payload);
});

export default app;
