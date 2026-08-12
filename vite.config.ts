import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        // Keep three in its own chunk so the boot shell paints before the engine parses.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
