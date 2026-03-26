/**
 * Barcha Reels ishlarini ketma-ket bajaradi — serverga parallel og‘ir yuk tushmasin.
 */
let mutexChain: Promise<void> = Promise.resolve();

export function enqueueReelsJob<T>(fn: () => Promise<T>): Promise<T> {
  const result = new Promise<T>((resolve, reject) => {
    mutexChain = mutexChain.then(() =>
      fn()
        .then(resolve)
        .catch(reject)
    );
  });
  return result;
}
