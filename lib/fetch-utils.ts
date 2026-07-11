export interface FetchTimeoutOptions {
  timeoutMs: number;
  label: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Run a fetch request with a hard deadline and a stable, operation-specific timeout error.
 */
export async function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  { timeoutMs, label }: FetchTimeoutOptions,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (timeoutSignal.aborted && isAbortError(error)) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  }
}
