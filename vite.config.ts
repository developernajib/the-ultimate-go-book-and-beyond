import fs from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const STATIC_PUBLIC_FILES = [
	'favicon.svg',
	'og-gobook.png',
	'robots.txt',
	'.htaccess',
	'_headers',
	'book-stats.json',
	'llms.txt',
	'fonts',
]

function prepareDist(): Plugin {
	return {
		name: 'prepare-dist',
		apply: 'build',
		buildStart() {
			const root = import.meta.dirname
			const outDir = path.resolve(root, 'dist')
			const publicDir = path.resolve(root, 'public')
			if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
			for (const entry of fs.readdirSync(outDir)) {
				if (entry === 'chapters') continue
				fs.rmSync(path.join(outDir, entry), { recursive: true, force: true })
			}
			for (const entry of STATIC_PUBLIC_FILES) {
				const src = path.join(publicDir, entry)
				if (!fs.existsSync(src)) continue
				fs.cpSync(src, path.join(outDir, entry), { recursive: true })
			}
		},
	}
}

export default defineConfig({
	plugins: [react(), tailwindcss(), prepareDist()],
	resolve: {
		alias: {
			'@': import.meta.dirname + '/src',
		},
	},
	server: {
		port: 5173,
	},
	build: {
		outDir: 'dist',
		emptyOutDir: false,
		copyPublicDir: false,
		sourcemap: false,
		target: 'es2022',
		minify: 'esbuild',
	},
})
