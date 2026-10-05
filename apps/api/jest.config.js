/** @type {import('jest').Config} */
const swc = [
  '@swc/jest',
  {
    jsc: {
      parser: { syntax: 'typescript', decorators: true },
      transform: { legacyDecorator: true, decoratorMetadata: true },
      target: 'es2022',
    },
    module: { type: 'commonjs' },
  },
];
const base = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': swc },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
module.exports = {
  projects: [
    { ...base, displayName: 'unit', rootDir: '.', testMatch: ['<rootDir>/src/**/*.spec.ts'] },
    { ...base, displayName: 'integration', rootDir: '.', testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'], testTimeout: 120000 },
  ],
};
