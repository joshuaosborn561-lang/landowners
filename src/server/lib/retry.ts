export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(
        `[retry] ${opts.label ?? 'op'} attempt ${i + 1}/${attempts} failed; waiting ${delay}ms`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cap in-flight Supabase RPCs. The project pool is 60 connections. */
export const SUPABASE_WRITE_CONCURRENCY = 4;

/** Simple concurrency limiter. Workers claim the next index synchronously. */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (!items.length) return results;
  let next = 0;
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: width }, () => worker());
  await Promise.all(workers);
  return results;
}

/** FIFO semaphore. Use for DB writes so board lanes cannot open more than `concurrency` RPCs. */
export function createLimiter(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  const waiters: Array<() => void> = [];

  return async function runLimited<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const resume = waiters.shift();
      if (resume) resume();
    }
  };
}
