import app from './app.ts';
import { getServerEnv } from './env.ts';
import { shutdownVictronClient } from './services/mqtt-service.ts';

const { host, port } = getServerEnv();

const server = app.listen(port, host, () => {
  console.log(`Server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`Node version: ${process.version}`);
});

// Node closes idle keep-alive sockets after 5 s, while Home Assistant's shared
// aiohttp pool reuses them for longer. A POST (e.g. the price push to /data)
// that lands on a socket we just closed fails with "Server disconnected" and
// is not retried. Outlast the client so it always closes first.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

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
