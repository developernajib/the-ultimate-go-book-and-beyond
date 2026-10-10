import React, {
	createContext,
	useContext,
	useEffect,
	useState,
	useCallback,
	useMemo,
	useRef,
} from 'react'
import type { ProviderId, TranslationSettings } from './types'
import { DEFAULT_PROVIDER_ORDER } from './types'
import { obfuscateApiKey, hasLegacyCanary, migrateLegacyCanaryKey } from './obfuscation'
import { clearTranslationCache, getCacheStats } from './cache'
import {
	loadCachedTitles,
	saveCachedTitles,
	loadCachedUI,
	saveCachedUI,
	STATIC_UI_STRINGS,
	translateTitlesBatch,
	type UIStrings,
} from './uiTranslations'
import type { ChapterWithSections } from '@/lib/chapters'

const STORAGE_KEY_LANG = 'gobook_lang'
const STORAGE_KEY_SETTINGS = 'gobook_translation_settings'

const defaultSettings: TranslationSettings = {
	order: [...DEFAULT_PROVIDER_ORDER],
	providers: {
		deepl: { enabled: true, key: '' },
		google_cloud: { enabled: true, key: '' },
		azure: { enabled: true, key: '', region: 'global' },
		libretranslate: { enabled: false, key: '', endpoint: 'https://libretranslate.com' },
		free_web: { enabled: true },
	},
}

function loadInitialSettings(): TranslationSettings {
	if (typeof window === 'undefined') return defaultSettings
	try {
		const stored = localStorage.getItem(STORAGE_KEY_SETTINGS)
		if (!stored) return defaultSettings
		const parsed = JSON.parse(stored)

		const storedEndpoint = parsed.providers?.libretranslate?.endpoint
		const sanitizedEndpoint =
			!storedEndpoint ||
			storedEndpoint.includes('argosopentech.com') ||
			storedEndpoint.includes('disroot.org')
				? 'https://libretranslate.com'
				: storedEndpoint

		const providersConfig: TranslationSettings['providers'] = {
			...defaultSettings.providers,
			...(parsed.providers || {}),
			libretranslate: {
				...defaultSettings.providers.libretranslate,
				...(parsed.providers?.libretranslate || {}),
				endpoint: sanitizedEndpoint,
			},
		}

		let migratedAny = false
		for (const pid of Object.keys(providersConfig) as ProviderId[]) {
			const p = providersConfig[pid]
			if (p && p.key && hasLegacyCanary(p.key)) {
				p.key = migrateLegacyCanaryKey(p.key)
				migratedAny = true
			}
		}

		const resolved: TranslationSettings = {
			order: Array.isArray(parsed.order) ? parsed.order : defaultSettings.order,
			providers: providersConfig,
		}

		// Persist migrated canary immediately
		if (migratedAny) {
			try {
				localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(resolved))
			} catch {}
		}

		return resolved
	} catch {
		return defaultSettings
	}
}

function loadInitialLang(): string {
	if (typeof window === 'undefined') return 'en'
	try {
		return localStorage.getItem(STORAGE_KEY_LANG) || 'en'
	} catch {
		return 'en'
	}
}

interface TranslationContextType {
	language: string
	setLanguage: (lang: string) => void
	settings: TranslationSettings
	setProviderKey: (id: ProviderId, rawKey: string) => void
	setProviderEnabled: (id: ProviderId, enabled: boolean) => void
	setProviderRegion: (region: string) => void
	setProviderEndpoint: (endpoint: string) => void
	setProviderOrder: (newOrder: ProviderId[]) => void
	isSettingsOpen: boolean
	openSettings: () => void
	closeSettings: () => void
	activeProvider: ProviderId | null
	setActiveProvider: (p: ProviderId | null) => void
	isTranslating: boolean
	setIsTranslating: (loading: boolean) => void
	translationStatus: string
	setTranslationStatus: (status: string) => void
	translationError: string | null
	setTranslationError: (err: string | null) => void
	cacheStats: { count: number; estimatedSizeKb: number }
	refreshCacheStats: () => Promise<void>
	clearCache: (lang?: string) => Promise<void>
	t: (key: keyof UIStrings) => string
	titleTranslations: Record<string, string>
	ensureTitlesTranslated: (titles: string[]) => Promise<void>
	ensureChapterSectionsTranslated: (sections: Array<{ title: string }>) => Promise<void>
}

const TranslationContext = createContext<TranslationContextType | undefined>(undefined)

export function TranslationProvider({ children }: { children: React.ReactNode }) {
	const [language, setLanguageState] = useState<string>(loadInitialLang)
	const [settings, setSettings] = useState<TranslationSettings>(loadInitialSettings)
	const [isSettingsOpen, setIsSettingsOpen] = useState(false)
	const [activeProvider, setActiveProvider] = useState<ProviderId | null>(null)
	const [isTranslating, setIsTranslating] = useState(false)
	const [translationStatus, setTranslationStatus] = useState('')
	const [translationError, setTranslationError] = useState<string | null>(null)
	const [cacheStats, setCacheStats] = useState({ count: 0, estimatedSizeKb: 0 })
	const [titleTranslations, setTitleTranslations] = useState<Record<string, string>>(() =>
		loadCachedTitles(loadInitialLang())
	)

	useEffect(() => {
		if (language === 'en') {
			setTitleTranslations({})
		} else {
			setTitleTranslations(loadCachedTitles(language))
		}
	}, [language])

	const setLanguage = useCallback((lang: string) => {
		setLanguageState(lang)
		setTranslationError(null)
		try {
			localStorage.setItem(STORAGE_KEY_LANG, lang)
		} catch {}
	}, [])

	const persistSettings = useCallback((updated: TranslationSettings) => {
		setSettings(updated)
		try {
			localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(updated))
		} catch {}
	}, [])

	const setProviderKey = useCallback(
		(id: ProviderId, rawKey: string) => {
			const obfuscated = obfuscateApiKey(rawKey)
			persistSettings({
				...settings,
				providers: {
					...settings.providers,
					[id]: {
						...settings.providers[id],
						key: obfuscated,
					},
				},
			})
		},
		[settings, persistSettings]
	)

	const setProviderEnabled = useCallback(
		(id: ProviderId, enabled: boolean) => {
			persistSettings({
				...settings,
				providers: {
					...settings.providers,
					[id]: {
						...settings.providers[id],
						enabled,
					},
				},
			})
		},
		[settings, persistSettings]
	)

	const setProviderRegion = useCallback(
		(region: string) => {
			persistSettings({
				...settings,
				providers: {
					...settings.providers,
					azure: {
						...settings.providers.azure,
						region,
					},
				},
			})
		},
		[settings, persistSettings]
	)

	const setProviderEndpoint = useCallback(
		(endpoint: string) => {
			persistSettings({
				...settings,
				providers: {
					...settings.providers,
					libretranslate: {
						...settings.providers.libretranslate,
						endpoint,
					},
				},
			})
		},
		[settings, persistSettings]
	)

	const setProviderOrder = useCallback(
		(newOrder: ProviderId[]) => {
			persistSettings({
				...settings,
				order: newOrder,
			})
		},
		[settings, persistSettings]
	)

	const refreshCacheStats = useCallback(async () => {
		const stats = await getCacheStats()
		setCacheStats(stats)
	}, [])

	const clearCache = useCallback(
		async (lang?: string) => {
			await clearTranslationCache(lang)
			await refreshCacheStats()
		},
		[refreshCacheStats]
	)

	useEffect(() => {
		refreshCacheStats()
	}, [refreshCacheStats])

	const [cachedUI, setCachedUI] = useState<Record<string, string>>(() =>
		loadCachedUI(loadInitialLang())
	)

	useEffect(() => {
		setCachedUI(loadCachedUI(language))
	}, [language])

	// Backfill missing UI strings
	useEffect(() => {
		if (language === 'en') return
		const staticDict = (STATIC_UI_STRINGS[language] || {}) as unknown as Record<string, string>
		const enDict = STATIC_UI_STRINGS.en as unknown as Record<string, string>
		const currentCached = loadCachedUI(language)

		const missingKeys = Object.keys(enDict).filter((key) => {
			return !staticDict[key] && !currentCached[key]
		})

		if (missingKeys.length === 0) return

		const missingTexts = missingKeys.map((k) => enDict[k])
		translateTitlesBatch(missingTexts, language)
			.then((translated) => {
				const updates: Record<string, string> = {}
				missingKeys.forEach((key, idx) => {
					if (translated[idx]) updates[key] = translated[idx]
				})
				if (Object.keys(updates).length > 0) {
					saveCachedUI(language, updates)
					setCachedUI((prev) => ({ ...prev, ...updates }))
				}
			})
			.catch(() => {})
	}, [language])

	// Static, cached, then English
	const t = useCallback(
		(key: keyof UIStrings): string => {
			return (
				STATIC_UI_STRINGS[language]?.[key] ||
				cachedUI[key] ||
				STATIC_UI_STRINGS.en[key] ||
				''
			)
		},
		[language, cachedUI]
	)

	const inFlightTitles = useRef<Set<string>>(new Set())

	const ensureTitlesTranslated = useCallback(
		async (titlesToTranslate: string[]) => {
			if (language === 'en' || titlesToTranslate.length === 0) return
			const cached = loadCachedTitles(language)
			const missing = titlesToTranslate.filter(
				(t) => t && !cached[t] && !inFlightTitles.current.has(`${language}:${t}`)
			)
			if (missing.length === 0) return

			for (const t of missing) inFlightTitles.current.add(`${language}:${t}`)

			try {
				const translated = await translateTitlesBatch(missing, language)
				const updates: Record<string, string> = {}
				missing.forEach((orig, idx) => {
					if (translated[idx]) updates[orig] = translated[idx]
				})
				saveCachedTitles(language, updates)
				setTitleTranslations((prev) => ({ ...prev, ...updates }))
			} catch {
				// Keep originals on network failure
			} finally {
				for (const t of missing) inFlightTitles.current.delete(`${language}:${t}`)
			}
		},
		[language]
	)

	const ensureChapterSectionsTranslated = useCallback(
		async (sections: Array<{ title: string }>) => {
			if (language === 'en' || !sections.length) return
			await ensureTitlesTranslated(sections.map((s) => s.title))
		},
		[language, ensureTitlesTranslated]
	)

	return (
		<TranslationContext.Provider
			value={{
				language,
				setLanguage,
				settings,
				setProviderKey,
				setProviderEnabled,
				setProviderRegion,
				setProviderEndpoint,
				setProviderOrder,
				isSettingsOpen,
				openSettings: () => setIsSettingsOpen(true),
				closeSettings: () => setIsSettingsOpen(false),
				activeProvider,
				setActiveProvider,
				isTranslating,
				setIsTranslating,
				translationStatus,
				setTranslationStatus,
				translationError,
				setTranslationError,
				cacheStats,
				refreshCacheStats,
				clearCache,
				t,
				titleTranslations,
				ensureTitlesTranslated,
				ensureChapterSectionsTranslated,
			}}
		>
			{children}
		</TranslationContext.Provider>
	)
}

export function useTranslation() {
	const ctx = useContext(TranslationContext)
	if (!ctx) {
		throw new Error('useTranslation must be used within a TranslationProvider')
	}
	return ctx
}

export function useTranslatedChapters(rawChapters: ChapterWithSections[]): ChapterWithSections[] {
	const { language, titleTranslations, ensureTitlesTranslated } = useTranslation()
	useEffect(() => {
		if (language === 'en' || !rawChapters.length) return

		const partLabels = Array.from(
			new Set(rawChapters.map((c) => c.rawPartLabel || c.partLabel))
		)
		const chapterTitles = rawChapters.map((c) => c.rawTitle || c.title)

		ensureTitlesTranslated([...partLabels, ...chapterTitles])
	}, [language, rawChapters, ensureTitlesTranslated])

	return useMemo(() => {
		if (language === 'en' || !rawChapters.length) return rawChapters

		return rawChapters.map((ch) => {
			const rawChTitle = ch.rawTitle || ch.title
			const rawPart = ch.rawPartLabel || ch.partLabel
			const transTitle = titleTranslations[rawChTitle] || ch.title
			const transPart = titleTranslations[rawPart] || ch.partLabel
			const transSections = ch.sections.map((sec) => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const rawSecTitle = (sec as any).rawTitle || sec.title
				return {
					...sec,
					title: titleTranslations[rawSecTitle] || sec.title,
					rawTitle: rawSecTitle,
				}
			})

			return {
				...ch,
				title: transTitle,
				rawTitle: rawChTitle,
				partLabel: transPart,
				rawPartLabel: rawPart,
				sections: transSections,
			}
		})
	}, [rawChapters, language, titleTranslations])
}

export function useTranslatedTexts(texts: string[]): Record<string, string> {
	const { language, titleTranslations, ensureTitlesTranslated } = useTranslation()
	const serialized = texts.join('\u0000')

	useEffect(() => {
		if (language === 'en' || !texts.length) return
		ensureTitlesTranslated(texts)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [language, serialized, ensureTitlesTranslated])

	return useMemo(() => {
		const result: Record<string, string> = {}
		for (const text of texts) {
			result[text] = language === 'en' ? text : titleTranslations[text] || text
		}
		return result
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [serialized, language, titleTranslations])
}
