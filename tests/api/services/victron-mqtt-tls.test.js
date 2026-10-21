import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, connect as tlsConnect } from 'node:tls';
import mqtt from 'mqtt';
import {
  buildMqttConnectOptions,
  validateTlsConfig,
} from '../../../api/services/victron-mqtt-client.ts';

const certPem = readFileSync(
  new URL('../../fixtures/tls/test-only-cert.pem', import.meta.url),
  'utf8',
);
const keyPem = readFileSync(
  new URL('../../fixtures/tls/test-only-key.pem', import.meta.url),
  'utf8',
);

const expectedFingerprint = createHash('sha256')
  .update(new X509Certificate(certPem).raw)
  .digest('hex');

const HANDSHAKE_TIMEOUT_MS = 2000;

function handshake(port, built, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  // Only these three TLS fields are taken from the production builder; the
  // remaining mqtt client options (username, reconnectPeriod, ...) are not
  // meaningful for a raw tls.connect().
  const { ca, rejectUnauthorized, checkServerIdentity } = built.options;
  const tlsOptions = {
    host: '127.0.0.1',
    port,
    servername: 'localhost',
    ca,
    rejectUnauthorized,
  };
  if (checkServerIdentity) tlsOptions.checkServerIdentity = checkServerIdentity;
  const socket = tlsConnect(tlsOptions);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

describe('Victron MQTT TLS handshake', () => {
  let server;
  let port;
  let connections;
  let sockets;
  let applicationBytes;

  beforeEach(async () => {
    connections = 0;
    applicationBytes = 0;
    sockets = new Set();
    server = createServer({ key: keyPem, cert: certPem, requestCert: false });
    server.on('tlsClientError', () => {});
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('secureConnection', (socket) => {
      socket.on('data', (chunk) => {
        applicationBytes += chunk.length;
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const build = (overrides = {}) =>
    buildMqttConnectOptions({
      host: '127.0.0.1',
      port,
      tls: true,
      tlsVerify: true,
      tlsCa: certPem,
      ...overrides,
    });

  it('completes the handshake with a matching fingerprint, CA, and verification', async () => {
    const built = build({ tlsFingerprint: expectedFingerprint });
    expect(built.url).toBe(`mqtts://127.0.0.1:${port}`);

    const socket = await handshake(port, built);
    try {
      expect(socket.authorized).toBe(true);
      expect(socket.getPeerCertificate().fingerprint256.replaceAll(':', '').toLowerCase())
        .toBe(expectedFingerprint);
    } finally {
      socket.destroy();
    }
  });

  it('rejects the handshake with a wrong fingerprint', async () => {
    const wrongFingerprint = `${expectedFingerprint.slice(0, -1)}${
      expectedFingerprint.endsWith('0') ? '1' : '0'
    }`;
    const built = build({ tlsFingerprint: wrongFingerprint });

    const error = await handshake(port, built).then(
      () => null,
      (err) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/certificate fingerprint mismatch/i);
    expect(error.message).toContain(wrongFingerprint);
  });

  it('rejects a real mqtt connect with a wrong fingerprint without application bytes', async () => {
    const wrongFingerprint = `${expectedFingerprint.slice(0, -1)}${
      expectedFingerprint.endsWith('0') ? '1' : '0'
    }`;
    const built = build({ tlsFingerprint: wrongFingerprint });

    await expect(
      mqtt.connectAsync(built.url, {
        ...built.options,
        connectTimeout: HANDSHAKE_TIMEOUT_MS,
        reconnectPeriod: 0,
      }),
    ).rejects.toThrow(/fingerprint mismatch/i);

    expect(applicationBytes).toBe(0);
  }, 10_000);

  it('rejects a self-signed server when no CA is supplied', async () => {
    const built = build({ tlsCa: undefined });

    const error = await handshake(port, built).then(
      () => null,
      (err) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/self-signed certificate/i);
    expect(error.code).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('fails closed before connecting when verification is disabled with a fingerprint', async () => {
    const config = {
      host: '127.0.0.1',
      port,
      tls: true,
      tlsVerify: false,
      tlsCa: certPem,
      tlsFingerprint: expectedFingerprint,
    };

    expect(() => validateTlsConfig(config)).toThrow(/tlsVerify: false/);
    expect(() => buildMqttConnectOptions(config)).toThrow(/tlsVerify: false/);

    const connectionsBefore = connections;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connections).toBe(connectionsBefore);
  });

  it('allows an insecure handshake only without a fingerprint', async () => {
    const built = build({ tlsVerify: false, tlsCa: undefined, tlsFingerprint: undefined });
    expect(built.options.rejectUnauthorized).toBe(false);
    expect(built.options.checkServerIdentity).toBeUndefined();

    const socket = await handshake(port, built);
    try {
      expect(socket.authorized).toBe(false);
    } finally {
      socket.destroy();
    }
  });
});
