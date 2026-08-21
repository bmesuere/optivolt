// Worker-thread entry point for HiGHS solves. The WASM solve is synchronous
// and can run for tens of seconds; running it here keeps the main event loop
// (and every HTTP request) responsive. See solve-runner.ts for the caller.
import { parentPort } from 'node:worker_threads';
// @ts-expect-error — no .d.ts alongside the vendor build artifact
import highsFactory from '../../vendor/highs-build/highs.js';

interface SolveRequest {
  id: number;
  lpText: string;
  options: Record<string, unknown>;
  /** Optional partial starting solution ({column name: value}); see lib/warm-start.ts. */
  warmColumns?: Record<string, number>;
}

const highsPromise = highsFactory({});

parentPort!.on('message', async ({ id, lpText, options, warmColumns }: SolveRequest) => {
  try {
    const highs = await highsPromise;
    const result = highs.solve(lpText, options, warmColumns);
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
