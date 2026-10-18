import { defineConfig } from 'vitest/config';
import { roadstronautApiPlugin } from './server/vitePlugin';

export default defineConfig({
  plugins: [roadstronautApiPlugin()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
