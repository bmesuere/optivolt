import { postJson } from "./client.js";

export function requestRemoteSolve() {
  // Server builds config & timing from /settings only
  return postJson("/calculate", {});
}
