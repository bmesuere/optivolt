import app from './app.ts';
import { getServerEnv } from './env.ts';
import { shutdownVictronClient } from './services/mqtt-service.ts';

const { host, port } = getServerEnv();

const server = app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Node version: ${process.version}`);
});

// The add-on supervisor stops us with SIGTERM; disconnect the MQTT client
// cleanly instead of letting the broker see a dropped connection.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal} received; shutting down`);
    server.close(() => {
      shutdownVictronClient()
        .catch((err: unknown) => console.warn('MQTT shutdown failed:', err instanceof Error ? err.message : String(err)))
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections();
    // Hard stop if a hung connection keeps close() from ever completing.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
