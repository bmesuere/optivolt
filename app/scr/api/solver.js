import { postJson } from "./client.js";

// The client no longer sends the full config; only optional timing hints remain.
export function requestRemoteSolve({ timing } = {}) {
  const payload = {
    timing: {
      timestampsMs: Array.isArray(timing?.timestampsMs) ? timing.timestampsMs : null,
      startMs: Number.isFinite(timing?.startMs) ? timing.startMs : null,
      stepMin: Number.isFinite(timing?.stepMin) ? timing.stepMin : null,
    },
  };
  return postJson("/calculate", payload);
}
