import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5174,
        open: true,
        headers: {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
    },
    build: {
        outDir: 'dist',
        sourcemap: false,
        target: 'es2020',
        cssCodeSplit: false,
        rollupOptions: {
            output: {
                manualChunks: {
                    'vendor-react': ['react', 'react-dom', 'react-router-dom'],
                    'vendor-prism': ['prismjs'],
                    'vendor-marked': ['marked'],
                },
            },
        },
        minify: 'esbuild',
        esbuildOptions: {
            legalComments: 'none',
            drop: ['console', 'debugger'],
        },
    },
})
