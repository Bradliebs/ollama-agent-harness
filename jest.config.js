/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // Bound parallelism so IO/network-bound tests (e.g. the optional-service
  // health probes that abort after 5s) don't starve each other for CPU/IO
  // under full-suite load. Unbounded workers caused intermittent single-test
  // timeouts that never reproduced in isolation. 50% keeps runs fast while
  // leaving headroom so a slow-but-correct test isn't killed by contention.
  maxWorkers: '50%',
  setupFilesAfterEnv: ['<rootDir>/src/test/envIsolation.setup.ts'],
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@tools/(.*)$': '<rootDir>/src/tools/$1',
    '^@permissions/(.*)$': '<rootDir>/src/permissions/$1',
    '^@context/(.*)$': '<rootDir>/src/context/$1',
    '^@agents/(.*)$': '<rootDir>/src/agents/$1',
    '^@persistence/(.*)$': '<rootDir>/src/persistence/$1',
    '^@extensibility/(.*)$': '<rootDir>/src/extensibility/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1',
  },
};
