// Unit tests (src, *.spec.ts) and e2e tests (test, *.e2e-spec.ts). Workspace packages are used from source.
module.exports = {
  testEnvironment: '<rootDir>/test/node-environment.js',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: { '^@fb/(engine|connectors)$': '<rootDir>/../../packages/$1/src', '^@fb/gateway$': '<rootDir>/../gateway/src' },
  testTimeout: 30000,
  maxWorkers: 4,
};
