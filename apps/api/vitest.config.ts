import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// NestJS resolves constructor injection from decorator metadata, which esbuild does not emit; SWC does.
export default defineConfig({
  plugins: [swc.vite({ jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true }, target: 'es2022' }, module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    globals: false,
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['src/test/setup.ts'],
  },
});
