export interface AsciiBoxLine {
	type: 'top' | 'mid' | 'bot' | 'empty' | 'text' | 'raw'
	indent?: number
	textIndex?: number
	orig?: string
	line?: string
}

export interface AsciiBoxMeta {
	items: AsciiBoxLine[]
	texts: string[]
	origWidth: number
}

export interface MaskResult {
	maskedText: string
	tokenMap: Map<string, string>
	boxMap: Map<string, AsciiBoxMeta>
}

const CODE_LANGS = new Set([
	'go',
	'golang',
	'bash',
	'sh',
	'shell',
	'zsh',
	'json',
	'yaml',
	'yml',
	'toml',
	'sql',
	'proto',
	'protobuf',
	'c',
	'cpp',
	'rust',
	'python',
	'py',
	'js',
	'javascript',
	'ts',
	'typescript',
	'html',
	'css',
	'dockerfile',
	'makefile',
	'asm',
	'diff',
	'graphql',
])

const GO_SYNTAX_RE =
	/(package\s+[a-zA-Z0-9_]+|func\s+(\([^)]+\)\s*)?[a-zA-Z0-9_]+\s*\(|import\s*\(|type\s+[a-zA-Z0-9_]+\s+(struct|interface)|var\s+[a-zA-Z0-9_]+\s+=)/

export function getDisplayWidth(str: string): number {
	let width = 0
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		// Wide CJK chars count double
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0xff01 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6)
		) {
			width += 2
		} else {
			width += 1
		}
	}
	return width
}

export function isCoverSection(
	chapterSlug?: string,
	sectionSlug?: string,
	content?: string
): boolean {
	if (
		chapterSlug === '00-front-matter--cover' &&
		(sectionSlug === 'from-developer-to-faang-engineer-and-beyond' || sectionSlug === '1')
	) {
		return true
	}
	if (
		content &&
		(content.includes('Go Gopher') || content.includes('22 Parts · 12 Appendices')) &&
		content.includes('┌')
	) {
		return true
	}
	return false
}

// Complex diagrams stay verbatim, simple boxes translate
export function isSimpleAsciiBox(code: string): boolean {
	if (/[\u2580-\u259F]/.test(code)) return false
	if (/[▼▲►◄┼┬┴║═╗╔╝╚╠╣╦╩╬→←↑↓]/.test(code)) return false
	if (/-->|<--|──>|<──/.test(code)) return false

	const lines = code.split(/\r?\n/).filter((l) => l.trim().length > 0)
	if (lines.length < 3) return false

	let hasTop = false
	let hasBot = false

	for (const line of lines) {
		const trimmed = line.trim()
		if (/^[┌╭]─+[┐╮]$/.test(trimmed)) {
			hasTop = true
			continue
		}
		if (/^[└╰]─+[┘╯]$/.test(trimmed)) {
			hasBot = true
			continue
		}
		if (/^[├]─+[┤]$/.test(trimmed)) {
			continue
		}
		if (trimmed.startsWith('│') && trimmed.endsWith('│')) {
			const inner = trimmed.slice(1, -1)
			if (/[│┌┐└┘├┤╭╮╰╯]/.test(inner)) return false
			continue
		}
		return false
	}

	return hasTop && hasBot
}

export function parseAsciiBox(code: string): AsciiBoxMeta {
	const lines = code.split(/\r?\n/)
	const items: AsciiBoxLine[] = []
	const texts: string[] = []
	let origWidth = 60

	for (const line of lines) {
		const trimmed = line.trim()
		if (/^[┌╭]─+[┐╮]$/.test(trimmed)) {
			items.push({ type: 'top' })
			origWidth = Math.max(origWidth, getDisplayWidth(trimmed) - 2)
		} else if (/^[├]─+[┤]$/.test(trimmed)) {
			items.push({ type: 'mid' })
		} else if (/^[└╰]─+[┘╯]$/.test(trimmed)) {
			items.push({ type: 'bot' })
		} else if (trimmed.startsWith('│') && trimmed.endsWith('│') && trimmed.length >= 2) {
			const inner = trimmed.slice(1, -1)
			origWidth = Math.max(origWidth, getDisplayWidth(inner))
			if (!inner.trim()) {
				items.push({ type: 'empty' })
			} else {
				const leading = inner.match(/^\s*/)?.[0].length || 0
				items.push({
					type: 'text',
					indent: leading,
					textIndex: texts.length,
					orig: inner.trim(),
				})
				texts.push(inner.trim())
			}
		} else {
			items.push({ type: 'raw', line })
		}
	}

	return { items, texts, origWidth }
}

export function rebuildAsciiBox(meta: AsciiBoxMeta, translatedTexts: string[]): string {
	let maxContentWidth = 0
	for (const t of translatedTexts) {
		const w = getDisplayWidth(t)
		if (w > maxContentWidth) maxContentWidth = w
	}

	const innerWidth = Math.max(meta.origWidth, maxContentWidth + 4)
	const border = '─'.repeat(innerWidth)

	const out: string[] = []
	for (const item of meta.items) {
		if (item.type === 'top') {
			out.push(`┌${border}┐`)
		} else if (item.type === 'mid') {
			out.push(`├${border}┤`)
		} else if (item.type === 'bot') {
			out.push(`└${border}┘`)
		} else if (item.type === 'empty') {
			out.push(`│${' '.repeat(innerWidth)}│`)
		} else if (item.type === 'text') {
			const trans =
				(item.textIndex !== undefined ? translatedTexts[item.textIndex] : undefined) ||
				item.orig ||
				''
			const ind = Math.min(item.indent || 2, 8)
			const textWidth = getDisplayWidth(trans)
			const rightPad = Math.max(0, innerWidth - ind - textWidth)
			out.push(`│${' '.repeat(ind)}${trans}${' '.repeat(rightPad)}│`)
		} else {
			out.push(item.line || '')
		}
	}
	return out.join('\n')
}

export function maskContent(text: string): MaskResult {
	const tokenMap = new Map<string, string>()
	const boxMap = new Map<string, AsciiBoxMeta>()
	let tokenIndex = 0

	const createToken = (
		type: 'CB' | 'IC' | 'HTML' | 'URL' | 'MATH' | 'BOX',
		value: string
	): string => {
		const key = `${type}_${tokenIndex++}`
		const token = `⟦⟦${key}⟧⟧`
		tokenMap.set(key, value)
		return token
	}

	let result = text

	// 0. Unfenced ASCII art
	result = result.replace(
		/(?:^|\n)([┌╭][─═]{10,}[┐╮]?(?:\r?\n[^\r\n]*)*?\r?\n[└╰][─═]{10,}[┘╯]?)/g,
		(_match, box) => {
			return '\n' + createToken('CB', box)
		}
	)

	// 1. Fenced code blocks
	result = result.replace(
		/(```|~~~)([^\r\n]*)\r?\n([\s\S]*?)\r?\n?\1/g,
		(match, _fence, rawLang, code) => {
			const lang = (rawLang || '').trim().toLowerCase()
			const isProgrammingCode = CODE_LANGS.has(lang) || GO_SYNTAX_RE.test(code)

			if (isProgrammingCode) {
				return createToken('CB', match)
			}
			if (/[┌└├│─╭╮╰╯]/.test(code)) {
				// Simple boxes translate, complex stay verbatim
				if (isSimpleAsciiBox(code)) {
					const meta = parseAsciiBox(code)
					if (meta.texts.length > 0) {
						const boxKey = `BOX_${tokenIndex++}`
						boxMap.set(boxKey, meta)
						return `⟦⟦${boxKey}⟧⟧`
					}
				}
				return createToken('CB', match)
			}
			return createToken('CB', match)
		}
	)

	// 2. Math blocks
	result = result.replace(/(\$\$[\s\S]*?\$\$)/g, (match) => {
		return createToken('MATH', match)
	})

	// 3. HTML tags
	result = result.replace(/(<!--[\s\S]*?-->)/g, (match) => {
		return createToken('HTML', match)
	})
	result = result.replace(/(<\/?[a-zA-Z][^>]*>)/g, (match) => {
		return createToken('HTML', match)
	})

	// Shield URLs from translation
	result = result.replace(/(!?\[[^\]]*\])\(([^)\s]+)([^)]*)\)/g, (_match, label, url, rest) => {
		const token = createToken('URL', url)
		return `${label}(${token}${rest})`
	})

	// 5. Inline code
	result = result.replace(/(`+[^`\r\n]+?`+)/g, (match) => {
		return createToken('IC', match)
	})

	// 6. Inline math
	result = result.replace(/(\$[^$\r\n]+\$)/g, (match) => {
		return createToken('MATH', match)
	})

	return {
		maskedText: result,
		tokenMap,
		boxMap,
	}
}

export function unmaskContent(text: string, tokenMap: Map<string, string>): string {
	if (!tokenMap || tokenMap.size === 0) return text

	// Tolerates variant bracket spellings of tokens
	const tokenRegex =
		/[⟦\[]{1,2}\s*(CB_\d+|IC_\d+|HTML_\d+|URL_\d+|MATH_\d+|BOX_\d+)\s*[⟧\]]{1,2}/g

	return text.replace(tokenRegex, (fullMatch, key) => {
		const original = tokenMap.get(key)
		return original !== undefined ? original : fullMatch
	})
}
