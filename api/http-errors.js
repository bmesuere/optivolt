const STATUS_MESSAGES = new Map([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [409, 'Conflict'],
  [422, 'Unprocessable Entity'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
]);

function defaultMessage(statusCode) {
  return STATUS_MESSAGES.get(statusCode) ?? 'HTTP Error';
}

export class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message ?? defaultMessage(statusCode), options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = options.expose ?? statusCode < 500;
    if (options.details && typeof options.details === 'object') {
      this.details = options.details;
    }
  }
}

export function toHttpError(error, statusCode = 500, message) {
  if (error instanceof HttpError) {
    return error;
  }

  const expose = statusCode < 500;
  const fallbackMessage = message ?? (expose && error instanceof Error ? error.message : defaultMessage(statusCode));
  const httpError = new HttpError(statusCode, fallbackMessage, { cause: error, expose });

  if (!expose && error instanceof Error && error.message) {
    httpError.details = { message: error.message };
  }

  return httpError;
}

export function assertCondition(condition, statusCode, message) {
  if (!condition) {
    throw new HttpError(statusCode, message);
  }
}
