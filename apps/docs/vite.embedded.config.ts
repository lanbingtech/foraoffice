import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'out/embedded',
    target: 'es2022',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: resolve(__dirname, 'src/renderer/embedded.tsx'),
      output: {
        format: 'es',
        entryFileNames: 'editor.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? 'editor.css'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
