/**
 * Barcha Reels ishlarini ketma-ket bajaradi — serverga parallel og'ir yuk tushmasin.
 */
let mutexChain: Promise<void> = Promise.resolve();
let queueDepth = 0;

export function getReelsQueueDepth(): number {
  return queueDepth;
}

export function enqueueReelsJob<T>(fn: () => Promise<T>): Promise<T> {
  queueDepth++;
  const result = new Promise<T>((resolve, reject) => {
    mutexChain = mutexChain.then(() =>
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => { queueDepth--; })
    );
  });
  return result;
}
