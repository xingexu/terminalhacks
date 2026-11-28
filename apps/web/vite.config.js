import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  esbuild: { jsx: 'automatic' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        workspace: fileURLToPath(new URL('./index.html', import.meta.url)),
        landing: fileURLToPath(new URL('./landing/index.html', import.meta.url))
      }
    }
  }
});
