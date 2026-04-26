const sharp = jest.fn((input?: Buffer | string) => {
  const seed =
    typeof input === 'string'
      ? `str:${input}`
      : Buffer.isBuffer(input)
        ? `buf:${input.toString('utf8')}`
        : 'empty';
  const ops: string[] = [];
  const api: {
    metadata: jest.Mock;
    rotate: jest.Mock;
    normalize: jest.Mock;
    sharpen: jest.Mock;
    extract: jest.Mock;
    resize: jest.Mock;
    jpeg: jest.Mock;
    toBuffer: jest.Mock;
  } = {
    metadata: jest.fn().mockResolvedValue({ width: 1080, height: 1920 }),
    rotate: jest.fn(() => {
      ops.push('rotate');
      return api;
    }),
    normalize: jest.fn(() => {
      ops.push('normalize');
      return api;
    }),
    sharpen: jest.fn(() => {
      ops.push('sharpen');
      return api;
    }),
    extract: jest.fn((args: { left: number; top: number; width: number; height: number }) => {
      ops.push(`extract:${args.left},${args.top},${args.width},${args.height}`);
      return api;
    }),
    resize: jest.fn((...args: unknown[]) => {
      ops.push(`resize:${JSON.stringify(args)}`);
      return api;
    }),
    jpeg: jest.fn((opts?: { quality?: number; mozjpeg?: boolean }) => {
      ops.push(`jpeg:${opts?.quality ?? 'default'}`);
      return api;
    }),
    toBuffer: jest.fn().mockImplementation(async () => Buffer.from(`fake-image|${seed}|${ops.join('|') || 'raw'}`)),
  };

  return api;
});

export default sharp;
