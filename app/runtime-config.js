// runtime-config.js
// Controls how the browser app interacts with the solver backend.
//
// mode: "local"  -> run the solver directly in the browser using the HiGHS WASM build.
//       "api"    -> delegate calculations & settings persistence to the Express API.
// apiBaseUrl: base URL for the API when mode === "api".
export const BACKEND_MODE = "local"; // change to "api" to use the server backend
export const API_BASE_URL = "http://localhost:3000";
