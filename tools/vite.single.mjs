import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    outDir: 'dist-single',
    rollupOptions: { output: { inlineDynamicImports: true, manualChunks: undefined } },
  },
});
