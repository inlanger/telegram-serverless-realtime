// Serialize application of overlapping prefix reads. Advance only after handling.
// This is in-process deduplication, not exactly-once effects across a crash.
export function createReceiver(onEvent, initialCursor = 0) {
  let cursor = initialCursor, duplicates = 0, applied = 0, queue = Promise.resolve();
  return {
    get cursor() { return cursor; },
    get stats() { return {cursor, duplicates, applied}; },
    accept(batch) {
      const task = queue.then(async () => {
        for (const event of batch.events) {
          if (event.seq <= cursor) {duplicates++; continue;}
          await onEvent(event);
          cursor = event.seq; applied++;
        }
      });
      // A failed handler leaves the cursor for replay; future batches can retry.
      queue = task.catch(() => {});
      return task;
    },
  };
}
