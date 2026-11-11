import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {cpSync} from 'node:fs'

// The PDF viewer (pdf.js) loads its character maps and standard fonts on demand from /pdfjs/.
const pdfjsAssets = {
	name: 'pdfjs-assets',
	writeBundle() {
		for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
			cpSync(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, {recursive: true})
	},
}

export default defineConfig({
	root: 'web',
	plugins: [react(), pdfjsAssets],
	build: {outDir: '../dist', emptyOutDir: true, sourcemap: false},
	server: {port: 5173, proxy: {'/api': 'http://127.0.0.1:7780'}},
})
