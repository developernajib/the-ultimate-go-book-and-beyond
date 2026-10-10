import type { ProviderId, TranslationSettings } from './types'

const DEFAULT_ORDER: ProviderId[] = ['deepl', 'google_cloud', 'azure', 'libretranslate', 'free_web']

export interface Language {
	code: string
	name: string
	nativeName: string
	rtl?: boolean
}

export const ALL_LANGUAGES: Language[] = [
	{ code: 'en', name: 'English', nativeName: 'English' },
	{ code: 'es', name: 'Spanish', nativeName: 'Español' },
	{ code: 'zh', name: 'Chinese (Simplified)', nativeName: '中文 (简体)' },
	{ code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '中文 (繁體)' },
	{ code: 'ja', name: 'Japanese', nativeName: '日本語' },
	{ code: 'de', name: 'German', nativeName: 'Deutsch' },
	{ code: 'fr', name: 'French', nativeName: 'Français' },
	{ code: 'pt', name: 'Portuguese', nativeName: 'Português' },
	{ code: 'ru', name: 'Russian', nativeName: 'Русский' },
	{ code: 'ko', name: 'Korean', nativeName: '한국어' },
	{ code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
	{ code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
	{ code: 'it', name: 'Italian', nativeName: 'Italiano' },
	{ code: 'ar', name: 'Arabic', nativeName: 'العربية', rtl: true },
	{ code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
	{ code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
	{ code: 'pl', name: 'Polish', nativeName: 'Polski' },
	{ code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
	{ code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
	{ code: 'fa', name: 'Persian (Farsi)', nativeName: 'فارسی', rtl: true },
	{ code: 'ur', name: 'Urdu', nativeName: 'اردو', rtl: true },
	{ code: 'th', name: 'Thai', nativeName: 'ไทย' },
	{ code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
	{ code: 'ro', name: 'Romanian', nativeName: 'Română' },
	{ code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
	{ code: 'cs', name: 'Czech', nativeName: 'Čeština' },
	{ code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
	{ code: 'da', name: 'Danish', nativeName: 'Dansk' },
	{ code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
	{ code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
	{ code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
	{ code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
	{ code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
	{ code: 'sr', name: 'Serbian', nativeName: 'Српски' },
	{ code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
	{ code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
	{ code: 'et', name: 'Estonian', nativeName: 'Eesti' },
	{ code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
	{ code: 'tl', name: 'Filipino (Tagalog)', nativeName: 'Tagalog' },
	{ code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
	{ code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
	{ code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
	{ code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
	{ code: 'mr', name: 'Marathi', nativeName: 'मराठी' },
	{ code: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
	{ code: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
	{ code: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
	{ code: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
	{ code: 'my', name: 'Myanmar (Burmese)', nativeName: 'မြန်မာစာ' },
	{ code: 'km', name: 'Khmer', nativeName: 'ភាសាខ្មែរ' },
	{ code: 'am', name: 'Amharic', nativeName: 'አማርኛ' },
	{ code: 'ne', name: 'Nepali', nativeName: 'नेपाली' },
	{ code: 'si', name: 'Sinhala', nativeName: 'සිංහල' },
	{ code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
	{ code: 'sq', name: 'Albanian', nativeName: 'Shqip' },
	{ code: 'hy', name: 'Armenian', nativeName: 'Հայերեն' },
	{ code: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan dili' },
	{ code: 'eu', name: 'Basque', nativeName: 'Euskara' },
	{ code: 'be', name: 'Belarusian', nativeName: 'Беларуская' },
	{ code: 'bs', name: 'Bosnian', nativeName: 'Bosanski' },
	{ code: 'ca', name: 'Catalan', nativeName: 'Català' },
	{ code: 'ceb', name: 'Cebuano', nativeName: 'Cebuano' },
	{ code: 'eo', name: 'Esperanto', nativeName: 'Esperanto' },
	{ code: 'gl', name: 'Galician', nativeName: 'Galego' },
	{ code: 'ka', name: 'Georgian', nativeName: 'ქართული' },
	{ code: 'ht', name: 'Haitian Creole', nativeName: 'Kreyòl ayisyen' },
	{ code: 'ha', name: 'Hausa', nativeName: 'Hausa' },
	{ code: 'haw', name: 'Hawaiian', nativeName: 'ʻŌlelo Hawaiʻi' },
	{ code: 'is', name: 'Icelandic', nativeName: 'Íslenska' },
	{ code: 'ig', name: 'Igbo', nativeName: 'Ásụ̀sụ́ Ìgbò' },
	{ code: 'ga', name: 'Irish', nativeName: 'Gaeilge' },
	{ code: 'jv', name: 'Javanese', nativeName: 'Basa Jawa' },
	{ code: 'kk', name: 'Kazakh', nativeName: 'Қазақ тілі' },
	{ code: 'ku', name: 'Kurdish (Kurmanji)', nativeName: 'Kurdî' },
	{ code: 'ckb', name: 'Kurdish (Sorani)', nativeName: 'کوردی', rtl: true },
	{ code: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча' },
	{ code: 'lo', name: 'Lao', nativeName: 'ພາສາລາວ' },
	{ code: 'la', name: 'Latin', nativeName: 'Latina' },
	{ code: 'lb', name: 'Luxembourgish', nativeName: 'Lëtzebuergesch' },
	{ code: 'mk', name: 'Macedonian', nativeName: 'Македонски' },
	{ code: 'mg', name: 'Malagasy', nativeName: 'Malagasy' },
	{ code: 'mt', name: 'Maltese', nativeName: 'Malti' },
	{ code: 'mi', name: 'Maori', nativeName: 'Te Reo Māori' },
	{ code: 'mn', name: 'Mongolian', nativeName: 'Монгол' },
	{ code: 'ps', name: 'Pashto', nativeName: 'پښتو', rtl: true },
	{ code: 'sd', name: 'Sindhi', nativeName: 'سنڌي', rtl: true },
	{ code: 'so', name: 'Somali', nativeName: 'Soomaaliga' },
	{ code: 'su', name: 'Sundanese', nativeName: 'Basa Sunda' },
	{ code: 'tg', name: 'Tajik', nativeName: 'Тоҷикӣ' },
	{ code: 'tt', name: 'Tatar', nativeName: 'Татарча' },
	{ code: 'tk', name: 'Turkmen', nativeName: 'Türkmençe' },
	{ code: 'ug', name: 'Uyghur', nativeName: 'ئۇيغۇرچە', rtl: true },
	{ code: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha' },
	{ code: 'cy', name: 'Welsh', nativeName: 'Cymraeg' },
	{ code: 'xh', name: 'Xhosa', nativeName: 'isiXhosa' },
	{ code: 'yi', name: 'Yiddish', nativeName: 'ייִדיש', rtl: true },
	{ code: 'yo', name: 'Yoruba', nativeName: 'Èdè Yorùbá' },
	{ code: 'zu', name: 'Zulu', nativeName: 'isiZulu' },
	{ code: 'as', name: 'Assamese', nativeName: 'অসমীয়া' },
	{ code: 'ay', name: 'Aymara', nativeName: 'Aymar aru' },
	{ code: 'bm', name: 'Bambara', nativeName: 'Bamanankan' },
	{ code: 'bho', name: 'Bhojpuri', nativeName: 'भोजपुरी' },
	{ code: 'co', name: 'Corsican', nativeName: 'Corsu' },
	{ code: 'dv', name: 'Dhivehi', nativeName: 'ދިވެހި', rtl: true },
	{ code: 'doi', name: 'Dogri', nativeName: 'डोगरी' },
	{ code: 'ee', name: 'Ewe', nativeName: 'Eʋegbe' },
	{ code: 'fy', name: 'Frisian', nativeName: 'Frysk' },
	{ code: 'gn', name: 'Guarani', nativeName: "Avañe'ẽ" },
	{ code: 'hmn', name: 'Hmong', nativeName: 'Hmoob' },
	{ code: 'ilo', name: 'Ilocano', nativeName: 'Ilokano' },
	{ code: 'rw', name: 'Kinyarwanda', nativeName: 'Ikinyarwanda' },
	{ code: 'gom', name: 'Konkani', nativeName: 'कोंकणी' },
	{ code: 'kri', name: 'Krio', nativeName: 'Krio' },
	{ code: 'ln', name: 'Lingala', nativeName: 'Lingála' },
	{ code: 'lg', name: 'Luganda', nativeName: 'Oluganda' },
	{ code: 'mai', name: 'Maithili', nativeName: 'मैथिली' },
	{ code: 'mni-Mtei', name: 'Meiteilon (Manipuri)', nativeName: 'মৈতৈলোন্' },
	{ code: 'lus', name: 'Mizo', nativeName: 'Mizo ṭawng' },
	{ code: 'or', name: 'Odia (Oriya)', nativeName: 'ଓଡ଼ିଆ' },
	{ code: 'om', name: 'Oromo', nativeName: 'Oromoo' },
	{ code: 'qu', name: 'Quechua', nativeName: 'Runasimi' },
	{ code: 'sa', name: 'Sanskrit', nativeName: 'संस्कृतम्' },
	{ code: 'gd', name: 'Scots Gaelic', nativeName: 'Gàidhlig' },
	{ code: 'nso', name: 'Sepedi', nativeName: 'Sesotho sa Leboa' },
	{ code: 'st', name: 'Sesotho', nativeName: 'Sesotho' },
	{ code: 'sn', name: 'Shona', nativeName: 'ChiShona' },
	{ code: 'ti', name: 'Tigrinya', nativeName: 'ትግርኛ' },
	{ code: 'ts', name: 'Tsonga', nativeName: 'Xitsonga' },
	{ code: 'ak', name: 'Twi (Akan)', nativeName: 'Twi' },
	// Hebrew, Hindi sort last
	{ code: 'he', name: 'Hebrew', nativeName: 'עברית', rtl: true },
	{ code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
]

export const SUPPORTED_LANGUAGES: Language[] = ALL_LANGUAGES

export const DEEPL_LANG_CODES = new Set([
	'ar',
	'bg',
	'cs',
	'da',
	'de',
	'el',
	'en',
	'es',
	'et',
	'fi',
	'fr',
	'hu',
	'id',
	'it',
	'ja',
	'ko',
	'lt',
	'lv',
	'nb',
	'no',
	'nl',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sv',
	'tr',
	'uk',
	'zh',
	'zh-TW',
])

export const LIBRE_LANG_CODES = new Set([
	'en',
	'ar',
	'az',
	'bg',
	'ca',
	'cs',
	'da',
	'de',
	'el',
	'eo',
	'es',
	'fa',
	'fi',
	'fr',
	'ga',
	'he',
	'hi',
	'hu',
	'id',
	'it',
	'ja',
	'ko',
	'nl',
	'no',
	'pl',
	'pt',
	'ro',
	'ru',
	'sk',
	'sl',
	'sq',
	'sr',
	'sv',
	'th',
	'tl',
	'tr',
	'uk',
	'vi',
	'zh',
	'zh-TW',
])

export const AZURE_LANG_CODES = new Set([
	'af',
	'am',
	'ar',
	'as',
	'az',
	'ba',
	'bg',
	'bho',
	'bn',
	'bo',
	'brx',
	'bs',
	'ca',
	'cs',
	'cy',
	'da',
	'de',
	'doi',
	'dsb',
	'dv',
	'el',
	'en',
	'es',
	'et',
	'eu',
	'fa',
	'fi',
	'fil',
	'tl',
	'fo',
	'fr',
	'ga',
	'gl',
	'gom',
	'gu',
	'ha',
	'he',
	'hi',
	'hr',
	'hsb',
	'ht',
	'hu',
	'hy',
	'id',
	'ig',
	'is',
	'it',
	'iu',
	'ja',
	'ka',
	'kk',
	'km',
	'kn',
	'ko',
	'ks',
	'ku',
	'ky',
	'ln',
	'lo',
	'lt',
	'lug',
	'lv',
	'mai',
	'mg',
	'mi',
	'mk',
	'ml',
	'mn',
	'mni-Mtei',
	'mr',
	'ms',
	'mt',
	'my',
	'nb',
	'no',
	'ne',
	'nl',
	'nso',
	'or',
	'pa',
	'pl',
	'ps',
	'pt',
	'ro',
	'ru',
	'rw',
	'sd',
	'si',
	'sk',
	'sl',
	'so',
	'sq',
	'sr',
	'st',
	'sv',
	'sw',
	'ta',
	'te',
	'th',
	'ti',
	'tk',
	'tr',
	'tt',
	'ug',
	'uk',
	'ur',
	'uz',
	'vi',
	'xh',
	'yo',
	'yue',
	'zh',
	'zh-TW',
	'zu',
])

export function getEffectiveActiveProvider(settings: TranslationSettings): ProviderId {
	const order = settings.order && settings.order.length > 0 ? settings.order : DEFAULT_ORDER
	for (const id of order) {
		const conf = settings.providers[id]
		if (!conf || !conf.enabled) continue
		if (id === 'deepl' && conf.key?.trim()) return 'deepl'
		if (id === 'google_cloud' && conf.key?.trim()) return 'google_cloud'
		if (id === 'azure' && conf.key?.trim()) return 'azure'
		if (id === 'libretranslate') {
			const isLocal =
				conf.endpoint?.includes('localhost') || conf.endpoint?.includes('127.0.0.1')
			if (isLocal || conf.key?.trim()) return 'libretranslate'
		}
		if (id === 'free_web') return 'free_web'
	}
	return 'free_web'
}

export function moveHebrewAndHindiToEnd(languages: Language[]): Language[] {
	const main: Language[] = []
	const hebrew: Language[] = []
	const hindi: Language[] = []

	for (const lang of languages) {
		if (lang.code === 'he' || lang.code === 'iw') {
			hebrew.push(lang)
		} else if (lang.code === 'hi') {
			hindi.push(lang)
		} else {
			main.push(lang)
		}
	}

	return [...main, ...hebrew, ...hindi]
}

export function getLanguagesForProvider(providerId: ProviderId): Language[] {
	let list: Language[]
	switch (providerId) {
		case 'deepl':
			list = ALL_LANGUAGES.filter((l) => DEEPL_LANG_CODES.has(l.code))
			break
		case 'libretranslate':
			list = ALL_LANGUAGES.filter((l) => LIBRE_LANG_CODES.has(l.code))
			break
		case 'azure':
			list = ALL_LANGUAGES.filter((l) => AZURE_LANG_CODES.has(l.code))
			break
		case 'google_cloud':
		case 'free_web':
		default:
			list = ALL_LANGUAGES
			break
	}
	return moveHebrewAndHindiToEnd(list)
}
