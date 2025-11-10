import { buildApiUrl } from "./api-utils.js";

export async function requestRemoteSolve({ config, timing }) {
  const payload = {
    config,
    timing: {
      timestampsMs: Array.isArray(timing?.timestampsMs) ? timing.timestampsMs : null,
      startMs: Number.isFinite(timing?.startMs) ? timing.startMs : null,
      stepMin: Number.isFinite(timing?.stepMin) ? timing.stepMin : null,
    },
  };

  const res = await fetch(buildApiUrl("/calculate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let message = `Calculation request failed with ${res.status}`;
    try {
      const text = await res.text();
      if (text) message = text;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return res.json();
}
