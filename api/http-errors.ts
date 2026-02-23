interface HttpErrorOptions {
  expose?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const STATUS_MESSAGES = new Map<number, string>([
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

function defaultMessage(statusCode: number): string {
  return STATUS_MESSAGES.get(statusCode) ?? 'HTTP Error';
}

export class HttpError extends Error {
  statusCode: number;
  expose: boolean;
  details?: Record<string, unknown>;

  constructor(statusCode: number, message?: string, options: HttpErrorOptions = {}) {
    super(message ?? defaultMessage(statusCode), { cause: options.cause });
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = options.expose ?? statusCode < 500;
    if (options.details) this.details = options.details;
  }
}

export function toHttpError(error: unknown, statusCode = 500, message?: string): HttpError {
  if (error instanceof HttpError) return error;

  const expose = statusCode < 500;
  const fallbackMessage = message ?? (expose && error instanceof Error ? error.message : defaultMessage(statusCode));
  const httpError = new HttpError(statusCode, fallbackMessage, { cause: error, expose });

  if (!expose && error instanceof Error && error.message) {
    httpError.details = { message: error.message };
  }

  return httpError;
}

export function assertCondition(condition: boolean, statusCode: number, message: string): asserts condition {
  if (!condition) throw new HttpError(statusCode, message);
}
