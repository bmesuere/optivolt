/**
 * ha-client.ts
 *
 * Home Assistant client utilities:
 * - WebSocket client for fetching long-term statistics.
 * - REST client for fetching entity states.
 * Uses the Node.js built-in WebSocket (Node >= 22).
 */

import type { HaReading } from '../../lib/ha-postprocess.ts';

/** Convert a HA WebSocket URL to an HTTP URL for REST API calls. */
export function wsUrlToHttp(wsUrl: string): string {
  return wsUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://').replace(/\/api\/websocket$/, '');
}

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
  timeoutMs?: number;
}

/**
 * Fetch the current state of a single HA entity via the REST API.
 */
export async function fetchHaEntityState({
  haUrl,
  haToken,
  entityId,
  timeoutMs = 10000,
}: FetchHaEntityStateOptions): Promise<HaEntityState> {
  const isAddon = !!process.env.SUPERVISOR_TOKEN;
  const baseUrl = isAddon ? 'http://supervisor/core' : wsUrlToHttp(haUrl);
  const token: string = isAddon ? process.env.SUPERVISOR_TOKEN! : haToken;

  const url = `${baseUrl}/api/states/${entityId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HA REST API error ${res.status} for ${entityId}`);
    }
    return (await res.json()) as HaEntityState;
  } finally {
    clearTimeout(timer);
  }
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
