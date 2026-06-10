/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
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
