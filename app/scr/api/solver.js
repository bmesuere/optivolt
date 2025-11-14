import { postJson } from "./client.js";

export function requestRemoteSolve(body = {}) {
  // Pass the body (which may contain `updateData: true`)
  return postJson("/calculate", body);
}
