const API_BASE_URL = ".";

export function normaliseBaseUrl(baseUrl) {
  return (baseUrl || "").replace(/\/$/, "");
}

export function buildApiUrl(path, baseUrl = API_BASE_URL) {
  return `${normaliseBaseUrl(baseUrl)}${path}`;
}

async function requestJson(path, init = {}) {
  const options = {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  };

  const response = await fetch(buildApiUrl(path), options);
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    raw = "";
  }

  if (!response.ok) {
    let message = `API request to ${path} failed with ${response.status}`;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === "string") {
          message = parsed.error;
        } else if (parsed && typeof parsed.message === "string") {
          message = parsed.message;
        } else {
          message = raw;
        }
      } catch {
        message = raw;
      }
    }
    throw new Error(message);
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function jsonHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    ...extra,
  };
}

export function getJson(path, init = {}) {
  return requestJson(path, init);
}

export function postJson(path, payload = {}, init = {}) {
  return requestJson(path, {
    ...init,
    method: init.method ?? "POST",
    headers: jsonHeaders(init.headers ?? {}),
    body: JSON.stringify(payload),
  });
}

export function deleteJson(path, init = {}) {
  return requestJson(path, {
    ...init,
    method: "DELETE",
    headers: jsonHeaders(init.headers ?? {}),
  });
}

export function putJson(path, payload = {}, init = {}) {
  return requestJson(path, {
    ...init,
    method: "PUT",
    headers: jsonHeaders(init.headers ?? {}),
    body: JSON.stringify(payload),
  });
}
