import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  oxc: { jsx: 'react-jsx' },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
