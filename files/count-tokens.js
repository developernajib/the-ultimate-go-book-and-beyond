#!/usr/bin/env node
/**
 * Counts content stats across all markdown source files.
 * Outputs: public/book-stats.json
 *
 * Usage: npm run token-count
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHAPTERS_DIR = path.resolve(__dirname, 'chapters')
const OUTPUT = path.resolve(__dirname, '../public/book-stats.json')
const SKIP = new Set(['BOOK-UPDATE-CHECKLIST.md', 'IMPROVEMENT-PLAN.md', 'PLAN-CPP-CHAPTERS.md'])

function walkMd(dir, results = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) walkMd(full, results)
		else if (entry.name.endsWith('.md') && !SKIP.has(entry.name)) results.push(full)
	}
	return results
}

// Approximate GPT-4 token count: ~4.5 chars per token on English prose
function approxTokens(text) {
	return Math.round(text.length / 4.5)
}

const files = walkMd(CHAPTERS_DIR)

let totalFiles = 0
let totalLines = 0 // all lines including empty
let contentLines = 0 // non-empty, non-whitespace-only
let codeLines = 0 // lines inside ``` blocks
let totalWords = 0
let totalChars = 0 // excluding whitespace
let totalCharsRaw = 0 // including whitespace
let totalTokens = 0

for (const file of files) {
	const raw = fs.readFileSync(file, 'utf-8')
	totalFiles++
	totalCharsRaw += raw.length
	totalChars += raw.replace(/\s/g, '').length
	totalTokens += approxTokens(raw)

	let inCode = false
	for (const line of raw.split('\n')) {
		totalLines++
		if (line.trimStart().startsWith('```')) inCode = !inCode
		if (line.trim() !== '') {
			contentLines++
			if (inCode) codeLines++
		}
		totalWords += line.trim().split(/\s+/).filter(Boolean).length
	}
}

const proseLines = contentLines - codeLines
const estimatedPages = Math.round(totalWords / 275) // ~275 words/page

const toK = (n) => `${Math.round(n / 1000)}K+`
const toM = (n) => `${(n / 1000000).toFixed(1)}M+`

const stats = {
	generatedAt: new Date().toISOString(),
	files: totalFiles,
	totalLines,
	contentLines: toK(contentLines),
	proseLines,
	codeLines: toK(codeLines),
	totalWords: toM(totalWords),
	totalCharsRaw: toM(totalCharsRaw),
	totalChars,
	totalTokens: toM(totalTokens),
	estimatedPages: estimatedPages.toLocaleString('en-US'),
	raw: {
		totalLines,
		contentLines,
		proseLines,
		codeLines,
		totalWords,
		totalCharsRaw,
		totalTokens,
		estimatedPages,
	},
}

fs.writeFileSync(OUTPUT, JSON.stringify(stats, null, 4))

const fmt = (n) => n.toLocaleString()

console.log('\n📊 Book Content Stats\n' + '─'.repeat(40))
console.log(`  Markdown files       : ${fmt(totalFiles)}`)
console.log(`  Total lines          : ${fmt(totalLines)}`)
console.log(`  Content lines        : ${fmt(contentLines)}  (non-empty)`)
console.log(`  Prose lines          : ${fmt(proseLines)}`)
console.log(`  Code lines           : ${fmt(codeLines)}`)
console.log(`  Total words          : ${fmt(totalWords)}`)
console.log(`  Characters (raw)     : ${fmt(totalCharsRaw)}`)
console.log(`  Approx tokens        : ${fmt(totalTokens)}  (~4.5 chars/token)`)
console.log(`  Estimated pages      : ${fmt(estimatedPages)}  (~275 words/page)`)
console.log(`\n  ✅ Written to public/book-stats.json\n`)
