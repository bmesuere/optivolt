import express from 'express';

import { HttpError, toHttpError } from './http-errors.js';
import calculateRouter from './routes/calculate.js';
import settingsRouter from './routes/settings.js';
import vrmRouter from './routes/vrm.js';

const app = express();
app.disable('x-powered-by');

const rawPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isFinite(rawPort) ? rawPort : 3000;
const host = process.env.HOST ?? '0.0.0.0';

app.use(express.json({ limit: '1mb' }));

app.use('/calculate', calculateRouter);
app.use('/settings', settingsRouter);
app.use('/vrm', vrmRouter);

app.get('/', (req, res) => {
  res.json({ message: 'Optivolt API is running.' });
});

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

app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
