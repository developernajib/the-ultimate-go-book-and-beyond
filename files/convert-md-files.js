#!/usr/bin/env node

/**
 * Convert split chapter folders to public/chapters/ as JSON for the web app.
 *
 * Reads: files/chapters/part-XX/chapter-YY/NN-section.md
 * Outputs: public/chapters/
 *   - index.json (chapter list with section info)
 *   - {slug}/{sectionIndex}.js (each section's content as JS module)
 *
 * The source .md files are NOT copied - only JS is output.
 * This means you can share the built project without sharing source markdown.
 *
 * Incremental: chapters whose sources are unchanged since the last successful
 * run are skipped entirely (no reads, no writes). Delete public/chapters to
 * force a full rebuild.
 *
 * Usage: npm run prebuild
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CHAPTERS_DIR = path.resolve(__dirname, 'chapters')
const OUTPUT_DIR = path.resolve(__dirname, '../public/chapters')
const DIST_OUTPUT_DIR = path.resolve(__dirname, '../dist/chapters')
const OUTPUT_DIRS = [OUTPUT_DIR, DIST_OUTPUT_DIR]

const PARTS_ORDER = [
	// Front Matter
	'00-front-matter',
	// Core Go Path (Parts I-XII)
	'part-01-go-mastery',
	'part-02-concurrency',
	'part-03a-production-ready',
	'part-03b-high-performance',
	'part-03c-testing-at-scale',
	'part-04-real-world-apps',
	'part-05a-data-layer',
	'part-05b-database-ecosystem',
	'part-05c-caching-engineering',
	'part-06-rest-api',
	'part-07-grpc',
	'part-08a-microservices',
	'part-08b-domain-driven-design',
	'part-08c-message-queues',
	'part-08d-workflow-orchestration',
	'part-09-fullstack',
	'part-10a-system-design',
	'part-10b-system-design-problems',
	'part-10c-distributed-systems-extended',
	'part-10d-multi-region-disaster-recovery',
	'part-11-dsa',
	'part-12-interview-mastery',
	// Advanced Path (Parts XIII-XVII)
	'part-13a-senior-engineer-mindset',
	'part-13b-architecture-patterns',
	'part-14a-career-guide',
	'part-14b-migration-modernization',
	'part-15a-cloud-infrastructure',
	'part-15b-devops-platform',
	'part-15c-networking-protocols',
	'part-16a-observability-sre',
	'part-16b-observability-extended',
	'part-17a-security',
	'part-17b-compliance-regulatory',
	// Parts XVIII-XIX (mandatory AI, optional blockchain)
	'part-18-ai-ml',
	'part-19-blockchain',
	// Capstone Projects
	'part-20-capstone-projects',
	// C++ Deep Dive
	'part-21a-cpp',
	'part-21b-cpp-concurrency-systems',
	'part-21c-cpp-performance',
	'part-21d-cpp-production',
	// eBPF and Linux Internals
	'part-22-ebpf-linux-internals',
	// Back Matter
	'appendices',
	'99-afterword',
]

const MANIFEST_FILE = '.manifest.json'
// Bump when title/section resolution changes so stale cached titles rebuild.
const MANIFEST_VERSION = 4

// Cached collator: String.localeCompare with options re-resolves the locale
// on every call (~30x slower). One shared instance fixes sort overhead.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function naturalSort(a, b) {
	return collator.compare(a, b)
}

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.trim()
		.slice(0, 60)
}

function stripFences(content) {
	return content.replace(/^(`{3,}|~{3,}).*\n(?:.*\n)*?^\1.*$/gm, '')
}

function withoutBom(content) {
	return content.replace(/^\uFEFF/, '')
}

function extractTitle(content) {
	const match = stripFences(withoutBom(content)).match(/^#\s+(.+)$/m)
	return match ? match[1].trim() : null
}

// Section title in priority order: ## heading, # heading, filename.
// Only the # fallback ignores fenced code: a ## match is almost always the
// real title (even inside a fenced example), while lone # lines are often
// shell/YAML comments.
function resolveSectionTitle(content, file) {
	const clean = withoutBom(content)
	const h2 = clean.match(/^##\s+(.+)$/m)
	if (h2) return h2[1].trim()
	const h1 = stripFences(clean).match(/^#\s+(.+)$/m)
	if (h1) return h1[1].trim()
	return file.replace(/^\d+-/, '').replace('.md', '').replace(/-/g, ' ')
}

// Every output file written or reused by this run, posix-style relative to OUTPUT_DIR.
// Used to delete stale files from removed chapters.
const writtenOutputs = new Set()

// mkdirSync(recursive:true) per file costs a syscall storm on Windows (NTFS +
// Defender). One mkdir per directory, remembered for the rest of the run.
const createdDirs = new Set()

function writeSection(slug, index, content) {
	const rel = `${slug}/${index}.js`
	// Export as JS module - browser caches these natively
	const escaped = content.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
	const next = `export default \`${escaped}\`;\n`
	writtenOutputs.add(rel)
	let changed = false
	for (const outDir of OUTPUT_DIRS) {
		const filePath = path.join(outDir, slug, `${index}.js`)
		const dir = path.dirname(filePath)
		if (!createdDirs.has(dir)) {
			fs.mkdirSync(dir, { recursive: true })
			createdDirs.add(dir)
		}
		let prev = null
		try {
			prev = fs.readFileSync(filePath, 'utf-8')
		} catch {
			prev = null
		}
		if (prev !== next) {
			fs.writeFileSync(filePath, next)
			changed = true
		}
	}
	return changed
}

function maxMtime(baseDir, files) {
	let max = 0
	for (const f of files) {
		try {
			const m = fs.statSync(path.join(baseDir, f)).mtimeMs
			if (m > max) max = m
		} catch {
			// Gone mid-run, full pass below will handle it.
		}
	}
	return max
}

function outputsExist(slug, count) {
	for (let j = 0; j < count; j++) {
		for (const outDir of OUTPUT_DIRS) {
			if (!fs.existsSync(path.join(outDir, slug, `${j}.js`))) return false
		}
	}
	return true
}

function pushChapter(chapters, partName, slug, title, sectionTitles) {
	const numStr = String(chapters.length + 1).padStart(3, '0')
	chapters.push({
		id: `${numStr}__${slugify(title)}`,
		title,
		number: numStr,
		part: partName,
		slug,
		sections: sectionTitles,
		sectionCount: sectionTitles.length,
	})
}

function writeIfChanged(filePath, data) {
	let prev = null
	try {
		prev = fs.readFileSync(filePath, 'utf-8')
	} catch {
		prev = null
	}
	if (prev === data) return false
	fs.writeFileSync(filePath, data)
	return true
}

function processChapters() {
	const start = Date.now()
	console.log('Converting chapters to JSON for web app...\n')

	// Incremental output: never wipe the directory. Vite's dev server tracks
	// public/ files through watcher add/unlink events, and mass-deleting
	// thousands of files makes it lose entries it never re-adds, which breaks
	// the running app (index.json falls through to index.html) until restart.
	// Overwriting in place only emits change/add events, which are safe.
	// Stale files from removed chapters are deleted via the manifest below.
	fs.mkdirSync(OUTPUT_DIR, { recursive: true })
	createdDirs.add(OUTPUT_DIR)
	fs.mkdirSync(DIST_OUTPUT_DIR, { recursive: true })
	createdDirs.add(DIST_OUTPUT_DIR)

	// Manifest from the previous successful run, for incremental skip and
	// stale-file cleanup. v1 was a plain array of output paths.
	let prevOutputs = []
	let prevChapters = {}
	let parsedVersion = 0
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, MANIFEST_FILE), 'utf-8'))
		if (Array.isArray(parsed)) {
			prevOutputs = parsed.map((s) => String(s).replace(/\\/g, '/'))
		} else if (parsed && typeof parsed === 'object') {
			prevOutputs = (parsed.outputs || []).map((s) => String(s).replace(/\\/g, '/'))
			prevChapters = parsed.chapters || {}
			parsedVersion = parsed.version || 0
		}
	} catch {
		prevOutputs = []
		prevChapters = {}
	}
	if (parsedVersion !== MANIFEST_VERSION) {
		prevOutputs = []
		prevChapters = {}
	}

	const chapters = []
	const nextChapters = {}
	let totalSections = 0
	let skippedChapters = 0
	let writtenFiles = 0

	for (const partName of PARTS_ORDER) {
		const partDir = path.join(CHAPTERS_DIR, partName)
		if (!fs.existsSync(partDir)) continue

		const entries = fs
			.readdirSync(partDir, { withFileTypes: true })
			.sort((a, b) => naturalSort(a.name, b.name))

		for (const entry of entries) {
			if (entry.isDirectory()) {
				// Split chapter folder
				const chapterDir = path.join(partDir, entry.name)
				const sectionFiles = fs
					.readdirSync(chapterDir)
					.filter((f) => f.endsWith('.md'))
					.sort(naturalSort)

				if (sectionFiles.length === 0) continue

				const slug = `${partName}--${entry.name}`
				const filesKey = sectionFiles.join('|')
				const curMax = maxMtime(chapterDir, sectionFiles)
				const cached = prevChapters[slug]

				if (
					cached &&
					cached.maxMtime === curMax &&
					cached.files === filesKey &&
					cached.count > 0 &&
					outputsExist(slug, cached.count)
				) {
					pushChapter(chapters, partName, slug, cached.title, cached.sections)
					for (let j = 0; j < cached.count; j++) writtenOutputs.add(`${slug}/${j}.js`)
					nextChapters[slug] = cached
					totalSections += cached.count
					skippedChapters++
					continue
				}

				let chapterTitle = null
				const sectionTitles = []
				const mergedContents = []

				for (let i = 0; i < sectionFiles.length; i++) {
					const content = withoutBom(
						fs.readFileSync(path.join(chapterDir, sectionFiles[i]), 'utf-8')
					)

					let sectionTitle
					if (sectionFiles[i].startsWith('00-')) {
						const title = extractTitle(content)
						if (title) chapterTitle = title
						sectionTitle = 'Introduction'
					} else {
						sectionTitle = resolveSectionTitle(content, sectionFiles[i])
					}

					const prevTitle = sectionTitles[sectionTitles.length - 1]
					if (prevTitle !== undefined && prevTitle === sectionTitle) {
						mergedContents[mergedContents.length - 1] += '\n\n' + content
					} else {
						sectionTitles.push(sectionTitle)
						mergedContents.push(content)
					}
				}

				for (let j = 0; j < mergedContents.length; j++) {
					if (writeSection(slug, j, mergedContents[j])) writtenFiles++
					totalSections++
				}

				if (!chapterTitle) {
					chapterTitle = entry.name
						.replace(/-/g, ' ')
						.replace(/^\w/, (c) => c.toUpperCase())
				}

				pushChapter(chapters, partName, slug, chapterTitle, sectionTitles)
				nextChapters[slug] = {
					title: chapterTitle,
					part: partName,
					sections: sectionTitles,
					maxMtime: curMax,
					count: mergedContents.length,
					files: filesKey,
				}

				console.log(`  ${slug} (${sectionFiles.length} sections)`)
			} else if (entry.name.endsWith('.md')) {
				// Unsplit single file - split by ## and write each as JSON
				const srcPath = path.join(partDir, entry.name)
				const basename = entry.name.replace('.md', '')
				const slug = `${partName}--${basename}`
				let srcMtime = 0
				try {
					srcMtime = fs.statSync(srcPath).mtimeMs
				} catch {
					continue
				}
				const cached = prevChapters[slug]

				if (
					cached &&
					cached.maxMtime === srcMtime &&
					cached.files === entry.name &&
					cached.count > 0 &&
					outputsExist(slug, cached.count)
				) {
					pushChapter(chapters, partName, slug, cached.title, cached.sections)
					for (let j = 0; j < cached.count; j++) writtenOutputs.add(`${slug}/${j}.js`)
					nextChapters[slug] = cached
					totalSections += cached.count
					skippedChapters++
					continue
				}

				const content = withoutBom(fs.readFileSync(srcPath, 'utf-8'))
				const title =
					extractTitle(content) || entry.name.replace('.md', '').replace(/-/g, ' ')

				const lines = content.split('\n')
				const sections = []
				let currentLines = []
				let currentTitle = null

				for (const line of lines) {
					if (line.startsWith('## ')) {
						if (currentLines.length > 0 || currentTitle !== null) {
							sections.push({
								title: currentTitle || 'Introduction',
								content: currentLines.join('\n').trim(),
							})
						}
						currentTitle = line.slice(3).trim()
						currentLines = [line]
					} else {
						currentLines.push(line)
					}
				}
				if (currentLines.length > 0 || currentTitle !== null) {
					sections.push({
						title: currentTitle || 'Introduction',
						content: currentLines.join('\n').trim(),
					})
				}

				if (sections.length === 0) {
					sections.push({ title: 'Introduction', content: content.trim() })
				}

				const sectionTitles = sections.map((s) => s.title)
				for (let i = 0; i < sections.length; i++) {
					if (writeSection(slug, i, sections[i].content)) writtenFiles++
					totalSections++
				}

				pushChapter(chapters, partName, slug, title, sectionTitles)
				nextChapters[slug] = {
					title,
					part: partName,
					sections: sectionTitles,
					maxMtime: srcMtime,
					count: sections.length,
					files: entry.name,
				}

				console.log(`  ${slug} (${sections.length} sections, single file)`)
			}
		}
	}

	// Write index (last, so readers never see sections without an index)
	const indexJson = JSON.stringify(chapters, null, 2)
	if (writeIfChanged(path.join(OUTPUT_DIR, 'index.json'), indexJson)) writtenFiles++
	writeIfChanged(path.join(DIST_OUTPUT_DIR, 'index.json'), indexJson)
	writtenOutputs.add('index.json')

	// Delete stale outputs from removed/renamed chapters. Normally zero files,
	// so the watcher barely notices. Mirrored into dist, which builds preserve.
	let removed = 0
	for (const rel of prevOutputs) {
		if (rel === MANIFEST_FILE || writtenOutputs.has(rel)) continue
		for (const outDir of OUTPUT_DIRS) {
			try {
				fs.rmSync(path.join(outDir, ...rel.split('/')))
				removed++
				let dir = path.dirname(path.join(outDir, ...rel.split('/')))
				const stopDir = outDir
				while (dir !== stopDir && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
					fs.rmdirSync(dir)
					dir = path.dirname(dir)
				}
			} catch {
				// Already gone, nothing to do.
			}
		}
	}
	if (removed > 0) console.log(`  removed ${removed} stale file(s)`)

	// Manifest for the next run.
	const manifest = JSON.stringify(
		{
			version: MANIFEST_VERSION,
			outputs: [...writtenOutputs, MANIFEST_FILE],
			chapters: nextChapters,
		},
		null,
		2
	)
	writeIfChanged(path.join(OUTPUT_DIR, MANIFEST_FILE), manifest)

	const secs = ((Date.now() - start) / 1000).toFixed(1)
	console.log(
		`\nDone: ${chapters.length} chapters, ${totalSections} section files (${skippedChapters} chapters unchanged, ${writtenFiles} files written) in ${secs}s`
	)
}

processChapters()
