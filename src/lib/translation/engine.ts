import { getCachedTranslation, setCachedTranslation } from './cache'
import { maskContent, unmaskContent, rebuildAsciiBox, isCoverSection } from './masker'
import { PROVIDERS_REGISTRY } from './providers'
import { deobfuscateApiKey } from './obfuscation'
import { DEEPL_LANG_CODES, LIBRE_LANG_CODES, AZURE_LANG_CODES } from './languages'
import type { ProviderId, TranslationSettings } from './types'

export interface TranslateSectionParams {
	chapterSlug: string
	sectionSlug: string
	targetLang: string
	rawMarkdown: string
	settings: TranslationSettings
	onProgress?: (msg: string) => void
}

export interface TranslateSectionResult {
	translatedMarkdown: string
	provider: ProviderId
	fromCache: boolean
}

// Chunks fit API limits via sentence splits
function createChunks(text: string, maxChars = 1400): string[] {
	const rawParagraphs = text.split('\n\n')
	const chunks: string[] = []

	for (const paragraph of rawParagraphs) {
		if (paragraph.length <= maxChars) {
			chunks.push(paragraph)
			continue
		}

		const sentences = paragraph.split(/(?<=[.?!])\s+|\n/)
		let current = ''

		for (const sentence of sentences) {
			if ((current + ' ' + sentence).trim().length > maxChars) {
				if (current.trim()) chunks.push(current.trim())
				current = sentence
			} else {
				current = current ? `${current} ${sentence}` : sentence
			}
		}

		if (current.trim()) {
			chunks.push(current.trim())
		}
	}

	return chunks
}

// Skip pure token chunks to save API calls
function isPureProtectedToken(chunk: string): boolean {
	const trimmed = chunk.trim()
	return /^⟦⟦(CB|MATH|HTML|BOX)_\d+⟧⟧$/.test(trimmed)
}

export async function translateSection({
	chapterSlug,
	sectionSlug,
	targetLang,
	rawMarkdown,
	settings,
	onProgress,
}: TranslateSectionParams): Promise<TranslateSectionResult> {
	// 1. English bypass
	if (
		!targetLang ||
		targetLang === 'en' ||
		isCoverSection(chapterSlug, sectionSlug, rawMarkdown)
	) {
		return {
			translatedMarkdown: rawMarkdown,
			provider: 'free_web',
			fromCache: false,
		}
	}

	// 2. Cache lookup
	onProgress?.('Checking local translation cache...')
	const cached = await getCachedTranslation(chapterSlug, sectionSlug, targetLang)
	if (cached && cached.content) {
		return {
			translatedMarkdown: cached.content,
			provider: cached.provider,
			fromCache: true,
		}
	}

	// 3. Mask content
	onProgress?.('Preserving Go code and preparing diagrams...')
	const { maskedText, tokenMap, boxMap } = maskContent(rawMarkdown)

	// 4. Split chunks
	const chunks = createChunks(maskedText, 1400)
	const proseIndices: number[] = []
	const proseChunks: string[] = []

	for (let i = 0; i < chunks.length; i++) {
		if (!isPureProtectedToken(chunks[i])) {
			proseIndices.push(i)
			proseChunks.push(chunks[i])
		}
	}

	const boxKeys = Array.from(boxMap.keys())
	const boxTextsList: string[] = []
	const boxIndexRanges: Array<{ key: string; start: number; count: number }> = []

	for (const key of boxKeys) {
		const meta = boxMap.get(key)!
		const start = boxTextsList.length
		boxTextsList.push(...meta.texts)
		boxIndexRanges.push({ key, start, count: meta.texts.length })
	}

	const allChunksToTranslate = [...proseChunks, ...boxTextsList]

	// 5. Provider fallback order
	const order =
		settings.order && settings.order.length > 0
			? settings.order
			: (['deepl', 'google_cloud', 'azure', 'libretranslate', 'free_web'] as ProviderId[])

	let successfulProvider: ProviderId | null = null
	let allTranslated: string[] = []
	const errors: string[] = []

	for (const providerId of order) {
		const config = settings.providers[providerId]
		const translator = PROVIDERS_REGISTRY[providerId]

		if (!translator) continue
		if (providerId === 'deepl' || providerId === 'google_cloud' || providerId === 'azure') {
			if (!config?.enabled || !config?.key?.trim()) {
				continue
			}
		} else if (providerId === 'libretranslate') {
			if (!config?.enabled) {
				continue
			}
			const rawKey = deobfuscateApiKey(config?.key || '').trim()
			const endpoint = (config?.endpoint || '').trim()
			const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1')
			if (!isLocal && !rawKey) {
				continue
			}
		}

		if (providerId === 'deepl' && !DEEPL_LANG_CODES.has(targetLang)) {
			continue
		}
		if (providerId === 'libretranslate' && !LIBRE_LANG_CODES.has(targetLang)) {
			continue
		}
		if (providerId === 'azure' && !AZURE_LANG_CODES.has(targetLang)) {
			continue
		}
		// free_web, google_cloud cover all langs

		try {
			onProgress?.(
				`Translating with ${providerId === 'free_web' ? 'Free Web' : providerId.toUpperCase()}...`
			)
			allTranslated = await translator.translate(
				allChunksToTranslate,
				targetLang,
				config || { enabled: true }
			)
			successfulProvider = providerId
			break
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err)
			console.warn(`[TranslationEngine] Provider ${providerId} failed:`, errorMsg)
			errors.push(`${providerId}: ${errorMsg}`)
		}
	}
	if (!successfulProvider) {
		throw new Error(`All translation providers failed.\n${errors.join('\n')}`)
	}

	// 6. Split prose, boxes
	const translatedProse = allTranslated.slice(0, proseChunks.length)
	const translatedBoxPart = allTranslated.slice(proseChunks.length)

	for (const range of boxIndexRanges) {
		const meta = boxMap.get(range.key)!
		const boxTranslations = translatedBoxPart.slice(range.start, range.start + range.count)
		const rebuiltBox = rebuildAsciiBox(meta, boxTranslations)
		tokenMap.set(range.key, `\`\`\`\n${rebuiltBox}\n\`\`\``)
	}

	const combinedChunks = [...chunks]
	for (let j = 0; j < proseIndices.length; j++) {
		const origIdx = proseIndices[j]
		combinedChunks[origIdx] = translatedProse[j] ?? chunks[origIdx]
	}

	const translatedMaskedText = combinedChunks.join('\n\n')

	// 7. Unmask tokens
	onProgress?.('Restoring code blocks and diagrams...')
	const finalMarkdown = unmaskContent(translatedMaskedText, tokenMap)

	// 8. Cache result
	await setCachedTranslation(
		chapterSlug,
		sectionSlug,
		targetLang,
		finalMarkdown,
		successfulProvider
	)

	return {
		translatedMarkdown: finalMarkdown,
		provider: successfulProvider,
		fromCache: false,
	}
}
