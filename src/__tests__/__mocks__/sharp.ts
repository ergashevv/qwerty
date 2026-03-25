const sharp = jest.fn(() => ({
  metadata: jest.fn().mockResolvedValue({ width: 1080, height: 1920 }),
  extract: jest.fn().mockReturnThis(),
  jpeg: jest.fn().mockReturnThis(),
  toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-image')),
}));

export default sharp;
