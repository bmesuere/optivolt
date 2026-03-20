/**
 * ha-client.ts
 *
 * Home Assistant client: WebSocket for long-term statistics, REST for entity state.
 * Uses the Node.js built-in WebSocket (Node >= 22) and built-in fetch.
 * Creates a new WebSocket connection per call.
 */

import type { HaReading } from '../../lib/ha-postprocess.ts';

// ----------------------------- REST: entity state -----------------------------

export interface HaEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

interface FetchHaEntityStateOptions {
  haUrl: string;
  haToken: string;
  entityId: string;
}

/**
 * Convert a WebSocket URL (ws:// or wss://) to an HTTP base URL (http:// or https://).
 * Strips the /api/websocket suffix if present.
 */
export function wsUrlToHttp(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // Remove the websocket path suffix
  url.pathname = url.pathname.replace(/\/api\/websocket$/, '');
  return url.toString().replace(/\/$/, '');
}

/**
 * Fetch a single entity state from the HA REST API.
 * In add-on mode, uses the supervisor proxy instead.
 */
export async function fetchHaEntityState({
  haUrl,
  haToken,
  entityId,
}: FetchHaEntityStateOptions): Promise<HaEntityState> {
  const isAddon = !!process.env.SUPERVISOR_TOKEN;
  const baseUrl = isAddon ? 'http://supervisor/core' : wsUrlToHttp(haUrl);
  const token: string = isAddon ? process.env.SUPERVISOR_TOKEN! : haToken;

  const url = `${baseUrl}/api/states/${encodeURIComponent(entityId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    throw new Error(`HA returned ${res.status} for entity "${entityId}"`);
  }

  return res.json() as Promise<HaEntityState>;
}

interface FetchHaStatsOptions {
  haUrl: string;
  haToken: string;
  entityIds: string[];
  startTime: string;
  endTime?: string;
  period?: string;
  timeoutMs?: number;
}

type HaWsMessage =
  | { type: 'auth_required' }
  | { type: 'auth_ok' }
  | { type: 'auth_invalid'; message: string }
  | { type: 'result'; success: true; result: Record<string, HaReading[]> }
  | { type: 'result'; success: false; error?: { message?: string } };

/**
 * Fetch statistics from HA via WebSocket.
 */
export async function fetchHaStats({
  haUrl,
  haToken,
  entityIds,
  startTime,
  endTime,
  period = 'hour',
  timeoutMs = 30000,
}: FetchHaStatsOptions): Promise<Record<string, HaReading[]>> {
  // If running as an add-on, always prioritize the supervisor proxy
  const isAddon = !!process.env.SUPERVISOR_TOKEN;
  const targetUrl = isAddon ? 'ws://supervisor/core/websocket' : haUrl;
  const targetToken: string = isAddon ? process.env.SUPERVISOR_TOKEN! : haToken;

  const ws = new WebSocket(targetUrl);

  return new Promise((resolve, reject) => {
    let authenticated = false;
    let commandId = 1;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`HA WebSocket timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.onmessage = (event) => {
      let msg: HaWsMessage;
      try {
        msg = JSON.parse(event.data as string) as HaWsMessage;
      } catch {
        return;
      }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: targetToken }));

      } else if (msg.type === 'auth_ok') {
        authenticated = true;
        const request: Record<string, unknown> = {
          id: commandId++,
          type: 'recorder/statistics_during_period',
          start_time: startTime,
          statistic_ids: entityIds,
          period,
        };
        if (endTime) request['end_time'] = endTime;
        ws.send(JSON.stringify(request));

      } else if (msg.type === 'auth_invalid') {
        ws.close();
        done(() => reject(new Error(`HA authentication failed: ${msg.message}`)));

      } else if (msg.type === 'result') {
        ws.close();
        if (msg.success) {
          done(() => resolve(msg.result));
        } else {
          done(() => reject(new Error(msg.error?.message ?? 'HA returned error result')));
        }
      }
    };

    ws.onerror = (event) => {
      ws.close();
      const msg = (event as ErrorEvent).message ?? String(event);
      done(() => reject(new Error(`HA WebSocket error: ${msg}`)));
    };

    ws.onclose = () => {
      if (!authenticated && !settled) {
        done(() => reject(new Error('HA WebSocket closed before authentication')));
      }
    };
  });
}
