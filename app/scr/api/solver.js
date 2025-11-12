import { postJson } from "./client.js";

export function requestRemoteSolve({ config, timing }) {
  const payload = {
    config,
    timing: {
      timestampsMs: Array.isArray(timing?.timestampsMs) ? timing.timestampsMs : null,
      startMs: Number.isFinite(timing?.startMs) ? timing.startMs : null,
      stepMin: Number.isFinite(timing?.stepMin) ? timing.stepMin : null,
    },
  };

  return postJson("/calculate", payload);
}
