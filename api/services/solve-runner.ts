import { Worker } from 'node:worker_threads';
import type { HighsSolution } from '../../lib/parse-solution.ts';

/**
 * Runs HiGHS solves on a persistent worker thread (see solve-worker.ts), so a
 * long MILP no longer blocks the event loop. One worker, one solve at a time:
 * calls are queued, preserving the serialization the old synchronous solve
 * gave for free. A solve error discards the worker — a throwing WASM solve may
 * leave the heap corrupted (the old lazy-instance code reset for the same
 * reason) — and the next call starts a fresh one, paying init again.
 */

interface PendingSolve {
  resolve(result: HighsSolution): void;
  reject(err: Error): void;
}

let worker: Worker | undefined;
const pending = new Map<number, PendingSolve>();
let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();

function createWorker(): Worker {
  const w = new Worker(new URL('./solve-worker.ts', import.meta.url));
  // Only an in-flight solve should keep the process alive, not the idle worker.
  w.unref();

  const discard = (err?: Error) => {
    if (worker === w) worker = undefined;
    void w.terminate();
    if (err) {
      const failed = [...pending.values()];
      pending.clear();
      for (const p of failed) p.reject(err);
    }
  };

  w.on('message', ({ id, result, error }: { id: number; result?: HighsSolution; error?: string }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (pending.size === 0) w.unref();
    if (error != null) {
      discard();
      p?.reject(new Error(error));
    } else {
      p?.resolve(result!);
    }
  });
  w.on('error', (err: Error) => discard(err));
  w.on('exit', (code) => {
    if (worker === w) discard(new Error(`Solver worker exited unexpectedly with code ${code}`));
  });

  return w;
}

export function solveLp(lpText: string, options: Record<string, unknown>, warmColumns?: Record<string, number>): Promise<HighsSolution> {
  const run = queue.then(() => new Promise<HighsSolution>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (!worker) worker = createWorker();
    worker.ref();
    worker.postMessage({ id, lpText, options, warmColumns });
  }));
  queue = run.catch(() => {});
  return run;
}
