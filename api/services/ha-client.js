/**
 * ha-client.js
 *
 * Home Assistant WebSocket client for fetching long-term statistics.
 * Uses the Node.js built-in WebSocket (Node >= 22).
 * Creates a new WebSocket connection per call.
 */

/**
 * Fetch statistics from HA via WebSocket.
 *
 * @param {{
 *   haUrl: string,
 *   haToken: string,
 *   entityIds: string[],
 *   startTime: string,
 *   endTime?: string,
 *   period?: string,
 *   timeoutMs?: number
 * }} options
 * @returns {Promise<Object>} raw HA statistics_during_period result
 */
export async function fetchHaStats({ haUrl, haToken, entityIds, startTime, endTime, period = 'hour', timeoutMs = 30000 }) {
  const ws = new WebSocket(haUrl);

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

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: haToken }));

      } else if (msg.type === 'auth_ok') {
        authenticated = true;
        const request = {
          id: commandId++,
          type: 'recorder/statistics_during_period',
          start_time: startTime,
          statistic_ids: entityIds,
          period,
        };
        if (endTime) request.end_time = endTime;
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

    ws.onerror = (err) => {
      done(() => reject(new Error(`HA WebSocket error: ${err?.message ?? String(err)}`)));
    };

    ws.onclose = () => {
      if (!authenticated && !settled) {
        done(() => reject(new Error('HA WebSocket closed before authentication')));
      }
    };
  });
}
