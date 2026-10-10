export type ProviderId = 'deepl' | 'google_cloud' | 'azure' | 'libretranslate' | 'free_web'

export type { Language } from './languages'
export {
	ALL_LANGUAGES,
	SUPPORTED_LANGUAGES,
	getLanguagesForProvider,
	getEffectiveActiveProvider,
	moveHebrewAndHindiToEnd,
	DEEPL_LANG_CODES,
	LIBRE_LANG_CODES,
	AZURE_LANG_CODES,
} from './languages'

export interface ProviderMeta {
	id: ProviderId
	name: string
	description: string
	requiresKey: boolean
	keyPlaceholder?: string
	badge?: string
	docsUrl?: string
}

export const PROVIDER_METAS: Record<ProviderId, ProviderMeta> = {
	deepl: {
		id: 'deepl',
		name: 'DeepL API',
		description:
			'High-accuracy translation for technical prose. Supports both Free (:fx) and Pro keys.',
		requiresKey: true,
		keyPlaceholder: 'e.g. 12345678-abcd-...:fx',
		badge: 'Recommended BYOK',
		docsUrl: 'https://www.deepl.com/pro-api',
	},
	google_cloud: {
		id: 'google_cloud',
		name: 'Google Cloud Translation',
		description:
			'Google Cloud Translation v2 API with broad language coverage and fast responses.',
		requiresKey: true,
		keyPlaceholder: 'e.g. AIzaSy...',
		badge: 'BYOK',
		docsUrl: 'https://cloud.google.com/translate/docs/setup',
	},
	azure: {
		id: 'azure',
		name: 'Microsoft Azure Translator',
		description: 'Azure AI Translator service with multi-region support.',
		requiresKey: true,
		keyPlaceholder: 'e.g. 32-character Azure secret key',
		badge: 'BYOK',
		docsUrl: 'https://azure.microsoft.com/products/cognitive-services/translator',
	},
	libretranslate: {
		id: 'libretranslate',
		name: 'LibreTranslate',
		description:
			'Connect to your self-hosted Docker instance (http://localhost:5000) or official libretranslate.com (API key required).',
		requiresKey: true,
		keyPlaceholder: 'API key (required for libretranslate.com)',
		badge: 'Self-Hosted / BYOK',
		docsUrl: 'https://libretranslate.com',
	},
	free_web: {
		id: 'free_web',
		name: 'Free Web Translator',
		description:
			'100% free default engine. Works instantly with zero configuration or API keys.',
		requiresKey: false,
		badge: 'Default (Free)',
	},
}

export const DEFAULT_PROVIDER_ORDER: ProviderId[] = [
	'deepl',
	'google_cloud',
	'azure',
	'libretranslate',
	'free_web',
]

export interface ProviderConfig {
	key?: string // Obfuscated key with "tuGBaB" marker
	region?: string // For Azure (e.g. 'global' or 'eastus')
	endpoint?: string // For LibreTranslate (default https://translate.argosopentech.com)
	enabled: boolean
}

export type UserProvidersConfig = Record<ProviderId, ProviderConfig>

export interface TranslationSettings {
	order: ProviderId[]
	providers: UserProvidersConfig
}

export interface CachedTranslationRecord {
	id: string // `${chapterSlug}:${sectionSlug}:${lang}`
	chapterSlug: string
	sectionSlug: string
	lang: string
	content: string
	provider: ProviderId
	timestamp: number
}
