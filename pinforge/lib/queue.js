// lib/queue.js
// Runs many jobs with a limit on how many run at the same time (concurrency)
// and how often a new one may start (requests per minute). This keeps us under
// Gemini's rate limits during bulk processing.

/**
 * @param {Array} jobs                 list of job ids/values
 * @param {(job) => Promise} worker    does one job; errors are caught and reported
 * @param {object} opts
 *   concurrency       max jobs running at once
 *   requestsPerMinute max job starts per minute (0 = no limit)
 *   signal            AbortSignal to stop starting new jobs
 *   onProgress        ({done, total, failed}) after each job
 */
export async function runQueue(jobs, worker, { concurrency = 2, requestsPerMinute = 0, signal, onProgress } = {}) {
  const total = jobs.length;
  const gapMs = requestsPerMinute > 0 ? Math.ceil(60000 / requestsPerMinute) : 0;
  let next = 0;
  let done = 0;
  let failed = 0;
  let lastStart = 0;
  let startLock = Promise.resolve();

  // Only one lane at a time may "claim a start slot", so starts stay evenly spaced.
  const waitForSlot = () => {
    const p = startLock.then(async () => {
      const wait = lastStart + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = Date.now();
    });
    startLock = p.catch(() => {});
    return p;
  };

  async function lane() {
    while (next < total) {
      if (signal?.aborted) return;
      const job = jobs[next++];
      await waitForSlot();
      if (signal?.aborted) return;
      try {
        await worker(job);
      } catch {
        failed += 1;
      }
      done += 1;
      onProgress?.({ done, total, failed });
    }
  }

  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, lane);
  await Promise.all(lanes);
  return { done, total, failed, aborted: !!signal?.aborted };
}
