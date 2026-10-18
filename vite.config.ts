import { defineConfig } from 'vitest/config';
import { thrustshiftApiPlugin } from './server/vitePlugin';

export default defineConfig({
  plugins: [thrustshiftApiPlugin()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
