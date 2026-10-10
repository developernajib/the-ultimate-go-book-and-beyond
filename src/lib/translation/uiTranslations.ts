/**
 * Static UI dictionary and dynamic title/text translations
 * for sidebar, navbar, home page, chapter list, and navigation controls.
 * Cached in localStorage per language for instant rendering on language switch.
 */

export interface UIStrings {
	contents: string
	chapters: string
	filterPlaceholder: string
	home: string
	previous: string
	next: string
	section: string
	sections: string
	allChapters: string
	subChapters: string
	parts: string
	startReading: string
	bookStartedBy: string
	whatsInside: string
	whatsInsideDesc: string
	search: string
	clearSearch: string
	noResults: string
	tableOfContents: string
	ctrlK: string
	toggleTheme?: string
	themeSubtitle?: string
	randomChapter?: string
	viewOnGitHub?: string
	navigateHelp?: string
	chaptersList?: string
	firstChapter?: string
	links?: string
	moreOptions?: string
	openCommandPalette?: string
	switchToLight?: string
	switchToDark?: string
	selectLanguage?: string
	translateBookLanguage?: string
	language?: string
	languages?: string
	searchLanguagesPlaceholder?: string
	noLanguageMatches?: string
	translationKeysAndOrder?: string
	closeSidebar?: string
	chapterShort?: string
	loading?: string
	translationWarning?: string
	showingEnglishOriginal?: string
	retry?: string
	english?: string
	settings?: string
	settingsAndKeys?: string
	coverPreserved?: string
	originalArt?: string
	translatedTo?: string
	cachedOffline?: string
	loadingSection?: string
}

export const STATIC_UI_STRINGS: Record<string, UIStrings> = {
	en: {
		contents: 'Contents',
		chapters: 'chapters',
		filterPlaceholder: 'Filter chapters & sections…',
		home: 'Home',
		previous: 'Previous',
		next: 'Next',
		section: 'Section',
		sections: 'sections',
		allChapters: 'All Chapters',
		subChapters: 'sub chapters',
		parts: 'parts',
		startReading: 'Start Reading',
		bookStartedBy: 'Project started by',
		whatsInside: "What's Inside",
		whatsInsideDesc: '22 parts covering the full engineering journey',
		search: 'Search',
		clearSearch: 'Clear search',
		noResults: 'No results.',
		tableOfContents: 'Table of contents',
		ctrlK: 'Ctrl K',
		toggleTheme: 'Toggle theme',
		themeSubtitle: 'Dark · Light',
		randomChapter: 'Random chapter',
		viewOnGitHub: 'View on GitHub',
		navigateHelp: '↑↓ navigate · Enter select · Esc close',
		chaptersList: 'Chapters List',
		firstChapter: 'First Chapter',
		links: 'Links',
		moreOptions: 'More options',
		openCommandPalette: 'Open command palette',
		switchToLight: 'Switch to light theme',
		switchToDark: 'Switch to dark theme',
		selectLanguage: 'Select language',
		translateBookLanguage: 'Translate book language',
		language: 'language',
		languages: 'languages',
		searchLanguagesPlaceholder: 'Search 130+ languages...',
		noLanguageMatches: 'No language matches',
		translationKeysAndOrder: 'Translation Keys & Order',
		closeSidebar: 'Close sidebar',
		chapterShort: 'Ch',
		loading: 'Loading…',
		translationWarning: 'Translation warning',
		showingEnglishOriginal: 'Showing English original.',
		retry: 'Retry',
		english: 'English',
		settings: 'Settings',
		settingsAndKeys: 'Settings & Keys',
		coverPreserved: 'ASCII Art Book Cover (Preserved)',
		originalArt: 'Original Art',
		translatedTo: 'Translated to',
		cachedOffline: 'Cached (Offline Ready)',
		loadingSection: 'Loading section...',
	},
}

export function getStaticUI(lang: string): UIStrings {
	return STATIC_UI_STRINGS[lang] || STATIC_UI_STRINGS.en
}

export function loadCachedUI(lang: string): Record<string, string> {
	if (typeof window === 'undefined' || !lang || lang === 'en') return {}
	try {
		const raw = localStorage.getItem(`gobook_ui_${lang}`)
		return raw ? JSON.parse(raw) : {}
	} catch {
		return {}
	}
}

export function saveCachedUI(lang: string, ui: Record<string, string>): void {
	if (typeof window === 'undefined' || !lang || lang === 'en') return
	try {
		const existing = loadCachedUI(lang)
		const updated = { ...existing, ...ui }
		localStorage.setItem(`gobook_ui_${lang}`, JSON.stringify(updated))
	} catch {
		// Ignore quota limits
	}
}

export function loadCachedTitles(lang: string): Record<string, string> {
	if (typeof window === 'undefined' || !lang || lang === 'en') return {}
	try {
		const raw = localStorage.getItem(`gobook_titles_${lang}`)
		return raw ? JSON.parse(raw) : {}
	} catch {
		return {}
	}
}

export function saveCachedTitles(lang: string, titles: Record<string, string>): void {
	if (typeof window === 'undefined' || !lang || lang === 'en') return
	try {
		const existing = loadCachedTitles(lang)
		const updated = { ...existing, ...titles }
		localStorage.setItem(`gobook_titles_${lang}`, JSON.stringify(updated))
	} catch {
		// Ignore quota limits
	}
}

/**
 * Translates a list of title/text strings in batches using Google translation APIs with timeout and fallback.
 */
export async function translateTitlesBatch(
	titles: string[],
	targetLang: string
): Promise<string[]> {
	if (titles.length === 0 || !targetLang || targetLang === 'en') return titles

	const DELIMITER = '\n\n⟦§⟧\n\n'
	let googleLang = targetLang
	if (googleLang === 'zh') googleLang = 'zh-CN'
	if (googleLang === 'zh-TW') googleLang = 'zh-TW'

	const clients5Url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(googleLang)}`
	const gtxUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(googleLang)}&dt=t`

	const postWithTimeout = async (url: string, text: string, timeoutMs = 6000) => {
		const controller = new AbortController()
		const id = setTimeout(() => controller.abort(), timeoutMs)
		try {
			return await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `q=${encodeURIComponent(text)}`,
				signal: controller.signal,
			})
		} finally {
			clearTimeout(id)
		}
	}

	const batchSize = 40
	const results: string[] = []

	for (let i = 0; i < titles.length; i += batchSize) {
		const batch = titles.slice(i, i + batchSize)
		const joined = batch.join(DELIMITER)
		let batchTranslated = false

		// 1. Try clients5
		try {
			const res = await postWithTimeout(clients5Url, joined, 6000)
			if (res.ok) {
				const data = await res.json()
				const text = Array.isArray(data)
					? typeof data[0] === 'string'
						? data[0]
						: JSON.stringify(data[0])
					: String(data)
				const parts = text.split(/\s*⟦\s*§\s*⟧\s*/)
				if (parts.length === batch.length) {
					results.push(...parts.map((p) => p.trim()))
					batchTranslated = true
				}
			}
		} catch {
			// Fall through to GTX fallback
		}

		// 2. Try GTX fallback if clients5 failed
		if (!batchTranslated) {
			try {
				const res = await postWithTimeout(gtxUrl, joined, 6000)
				if (res.ok) {
					const data = await res.json()
					if (Array.isArray(data) && Array.isArray(data[0])) {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const fullText = data[0].map((item: any) => item[0] || '').join('')
						const parts = fullText.split(/\s*⟦\s*§\s*⟧\s*/)
						if (parts.length === batch.length) {
							results.push(...parts.map((p) => p.trim()))
							batchTranslated = true
						}
					}
				}
			} catch {
				// Keep original
			}
		}

		// Fallback: keep original titles for this failed batch
		if (!batchTranslated) {
			results.push(...batch)
		}
	}

	return results
}
