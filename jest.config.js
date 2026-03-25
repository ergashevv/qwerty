/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  projects: [
    // ─── UNIT TESTLAR (mock + fake keys) ─────────────────────────────────────
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/movieService.test.ts'],
      setupFiles: ['<rootDir>/src/__tests__/setup.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: { module: 'commonjs', esModuleInterop: true },
        }],
      },
      moduleNameMapper: {
        '^sharp$': '<rootDir>/src/__tests__/__mocks__/sharp.ts',
      },
      testTimeout: 15000,
    },

    // ─── INTEGRATION TESTLAR (real APIs, real sharp) ──────────────────────────
    {
      displayName: 'integration',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/__tests__/integration.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: { module: 'commonjs', esModuleInterop: true },
        }],
      },
      // Explicit empty moduleNameMapper — sharp mock ISHLATILMAYDI
      moduleNameMapper: {},
      testTimeout: 60000,
    },
  ],
};
