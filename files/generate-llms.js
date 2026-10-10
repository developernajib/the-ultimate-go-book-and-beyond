#!/usr/bin/env node

/**
 * Generate an LLM-friendly index of the Go Book (llms.txt convention).
 *
 * Short file: what the book is and why it exists, then one goal line per
 * chapter extracted from each chapter's introduction. Links resolve in
 * the web reader, whose section slug rules are mirrored here.
 *
 * Usage: npm run generate-llms
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CHAPTERS_DIR = path.resolve(__dirname, '../public/chapters')
const ROOT_DIR = path.resolve(__dirname, '..')
const SITE = 'https://gobook.dev'

const slugify = (text) =>
	text
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.trim()
		.slice(0, 60)

// First-section slug, same rules as the web reader: the 00 file is always
// titled Introduction and always sorts first.
function firstSectionSlug(sectionTitles) {
	const title = sectionTitles[0]
	if (!title) return 'intro'
	return title === 'Introduction' ? 'intro' : slugify(title) || 'intro'
}

async function loadSection(chapterSlug, index) {
	const mod = await import(
		pathToFileURL(path.join(CHAPTERS_DIR, chapterSlug, `${index}.js`)).href
	)
	return typeof mod.default === 'string' ? mod.default : ''
}

// Strip markdown down to plain prose for goal extraction.
function mdToText(md) {
	const lines = md
		.replace(/^(`{3,}|~{3,}).*\n(?:.*\n)*?^\1.*$/gm, '')
		.split('\n')
		.map((line) => {
			if (/^#{1,6}\s+/.test(line)) return ''
			return line.replace(/^>\s?/, '')
		})
		.filter((line) => {
			if (/^\s*$/.test(line)) return false
			if (/^\s*\|/.test(line)) return false
			if (/[│┌┐└┘─┬┴┼╗╔║╝╚╠╣╦╩╬█░▒▓]/.test(line)) return false
			if (/^\s*!?\[[^\]]*\]\([^)]*\)\s*$/.test(line)) return false
			return true
		})
	return lines
		.join(' ')
		.replace(/!\[(.*?)\]\(.*?\)/g, '$1')
		.replace(/\[(.*?)\]\(.*?\)/g, '$1')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		.replace(/(^|\s)[*_](\S)/g, '$1$2')
		.replace(/(\S)[*_](\s|$)/g, '$1$2')
		.replace(/(`+)(.*?)\1/g, '$2')
		.replace(/<[^>]+>/g, '')
		.replace(/-{3,}/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

// First sentences of a text, capped so one chapter stays one line.
function goalOf(text, maxChars = 240) {
	const sentences = text.match(/[^.!?]+[.!?]+/g) || [text]
	let out = ''
	for (const s of sentences) {
		if ((out + s).trim().length > maxChars) break
		out += s
	}
	out = out.trim() || text.slice(0, maxChars).trim()
	return out || ''
}

async function generateLlms() {
	console.log('Generating llms.txt for Go Book...\n')

	const indexPath = path.join(CHAPTERS_DIR, 'index.json')
	if (!fs.existsSync(indexPath)) {
		console.error('Chapter index not found. Run `npm run prebuild` first.')
		process.exit(1)
	}

	const chapters = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))

	// Same counting rules as the homepage and chapter list: only
	// "Chapter N:" titles count as chapters, "Chapter NX:" as sub-chapters.
	const mainCount = chapters.filter((c) => /^Chapter \d+:/i.test(c.title)).length
	const subCount = chapters.filter((c) => /^Chapter \d+[a-z]+:/i.test(c.title)).length
	const partCount = new Set(
		chapters.map((c) => (c.part.match(/part-(\d+)/) || [])[1]).filter(Boolean)
	).size

	// Why the book exists: opening prose of the cover chapter.
	const cover = chapters.find((c) => c.slug === '00-front-matter--cover')
	const whyItExists = cover ? goalOf(mdToText(await loadSection(cover.slug, 0)), 500) : ''

	const outLines = [
		'# The Ultimate Go Book & Beyond',
		'',
		'> Your complete path from beginner to senior engineer.',
		'> Free and open source (content CC BY 4.0).',
		'',
		`- ${mainCount} chapters and ${subCount} sub-chapters across ${partCount} parts.`,
		'',
		'## Why this book exists',
		'',
		whyItExists,
		'',
		'## Chapters',
		'',
	]

	for (const chapter of chapters) {
		const href = `${SITE}/chapters/${chapter.slug}/${firstSectionSlug(chapter.sections)}`
		let goal = ''
		try {
			goal = goalOf(mdToText(await loadSection(chapter.slug, 0)))
		} catch {
			goal = ''
		}
		if (goal.length < 40) goal = `Covers ${chapter.title}.`
		outLines.push(`- [${chapter.title}](${href}): ${goal}`)
	}

	outLines.push('')

	const outputContent = outLines.join('\n').replace(/\r\n/g, '\n')

	for (const outputPath of [
		path.join(ROOT_DIR, 'llms.txt'),
		path.join(ROOT_DIR, 'public', 'llms.txt'),
	]) {
		fs.writeFileSync(outputPath, outputContent, 'utf8')
		console.log(`Generated: ${outputPath}`)
	}

	console.log(
		`\n${chapters.length} entries, ${outLines.length} lines, ${(outputContent.length / 1024).toFixed(0)} KB`
	)
}

generateLlms().catch((err) => {
	console.error('Failed to generate llms.txt:', err)
	process.exit(1)
})
