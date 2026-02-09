import app from './app.js';

const rawPort = Number.parseInt(process.env.PORT ?? '', 10);
const port = Number.isFinite(rawPort) ? rawPort : 3000;
const host = process.env.HOST ?? '0.0.0.0';

app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
