import type { ProviderConfig, ProviderId } from './types'
import { deobfuscateApiKey } from './obfuscation'

export interface ProviderTranslator {
	id: ProviderId
	translate(chunks: string[], targetLang: string, config: ProviderConfig): Promise<string[]>
	test(config: ProviderConfig): Promise<{ success: boolean; message: string }>
}

async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs = 8000
): Promise<Response> {
	const controller = new AbortController()
	const id = setTimeout(() => controller.abort(), timeoutMs)
	try {
		return await fetch(url, {
			...options,
			signal: options.signal || controller.signal,
		})
	} finally {
		clearTimeout(id)
	}
}

// 1. DeepL
export const deeplProvider: ProviderTranslator = {
	id: 'deepl',
	async translate(chunks, targetLang, config) {
		const rawKey = deobfuscateApiKey(config.key || '')
		if (!rawKey) throw new Error('DeepL API key is missing')

		// :fx keys use api-free host
		const isFreeTier = rawKey.endsWith(':fx')
		const baseUrl = isFreeTier
			? 'https://api-free.deepl.com/v2/translate'
			: 'https://api.deepl.com/v2/translate'

		let deeplLang = targetLang.toUpperCase()
		if (deeplLang === 'ZH') deeplLang = 'ZH-HANS'
		if (deeplLang === 'ZH-TW') deeplLang = 'ZH-HANT'
		if (deeplLang === 'PT') deeplLang = 'PT-BR'
		if (deeplLang === 'EN') deeplLang = 'EN-US'

		const body = new URLSearchParams()
		for (const chunk of chunks) {
			body.append('text', chunk)
		}
		body.append('target_lang', deeplLang)
		body.append('source_lang', 'EN')
		body.append('tag_handling', 'xml')

		const res = await fetchWithTimeout(
			baseUrl,
			{
				method: 'POST',
				headers: {
					Authorization: `DeepL-Auth-Key ${rawKey}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: body.toString(),
			},
			10000
		)

		if (!res.ok) {
			const errText = await res.text().catch(() => '')
			throw new Error(`DeepL API error (${res.status}): ${errText || res.statusText}`)
		}

		const data = await res.json()
		if (!data.translations || !Array.isArray(data.translations)) {
			throw new Error('DeepL API returned unexpected format')
		}

		return data.translations.map((t: { text: string }) => t.text)
	},
	async test(config) {
		try {
			const res = await this.translate(['Hello'], 'es', config)
			return { success: true, message: `Connected! Sample: "${res[0]}"` }
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			return { success: false, message: msg }
		}
	},
}

// 2. Google Cloud
export const googleCloudProvider: ProviderTranslator = {
	id: 'google_cloud',
	async translate(chunks, targetLang, config) {
		const rawKey = deobfuscateApiKey(config.key || '')
		if (!rawKey) throw new Error('Google Cloud API key is missing')

		const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(rawKey)}`

		const res = await fetchWithTimeout(
			url,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					q: chunks,
					source: 'en',
					target: targetLang,
					format: 'text',
				}),
			},
			10000
		)

		if (!res.ok) {
			const errData = await res.json().catch(() => null)
			const msg = errData?.error?.message || res.statusText
			throw new Error(`Google Cloud Translation error (${res.status}): ${msg}`)
		}

		const data = await res.json()
		const list = data?.data?.translations
		if (!Array.isArray(list)) {
			throw new Error('Google Cloud returned unexpected format')
		}

		return list.map((item: { translatedText: string }) => item.translatedText)
	},
	async test(config) {
		try {
			const res = await this.translate(['Hello'], 'es', config)
			return { success: true, message: `Connected! Sample: "${res[0]}"` }
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			return { success: false, message: msg }
		}
	},
}

// 3. Azure
export const azureProvider: ProviderTranslator = {
	id: 'azure',
	async translate(chunks, targetLang, config) {
		const rawKey = deobfuscateApiKey(config.key || '')
		if (!rawKey) throw new Error('Azure Translator key is missing')
		const region = config.region?.trim() || 'global'

		const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=${encodeURIComponent(targetLang)}`

		const body = chunks.map((chunk) => ({ Text: chunk }))

		const res = await fetchWithTimeout(
			url,
			{
				method: 'POST',
				headers: {
					'Ocp-Apim-Subscription-Key': rawKey,
					'Ocp-Apim-Subscription-Region': region,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
			},
			10000
		)

		if (!res.ok) {
			const errText = await res.text().catch(() => '')
			throw new Error(`Azure Translator error (${res.status}): ${errText || res.statusText}`)
		}

		const data = await res.json()
		if (!Array.isArray(data)) {
			throw new Error('Azure Translator returned unexpected format')
		}

		return data.map((item: { translations?: Array<{ text: string }> }) => {
			return item.translations?.[0]?.text || ''
		})
	},
	async test(config) {
		try {
			const res = await this.translate(['Hello'], 'es', config)
			return { success: true, message: `Connected! Sample: "${res[0]}"` }
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			return { success: false, message: msg }
		}
	},
}

// 4. LibreTranslate
export const libreTranslateProvider: ProviderTranslator = {
	id: 'libretranslate',
	async translate(chunks, targetLang, config) {
		let endpoint = (config.endpoint || 'https://libretranslate.com').trim()
		if (
			!endpoint ||
			endpoint.includes('argosopentech.com') ||
			endpoint.includes('disroot.org')
		) {
			endpoint = 'https://libretranslate.com'
		}
		if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)
		if (!endpoint.endsWith('/translate')) endpoint = `${endpoint}/translate`

		const rawKey = deobfuscateApiKey(config.key || '').trim()
		const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1')

		if (!isLocal && !rawKey) {
			throw new Error(
				`LibreTranslate (${endpoint}) requires an API key. For 100% free translation without an API key, use the default Free Web Translator.`
			)
		}

		const results: string[] = []
		for (const chunk of chunks) {
			const payload: Record<string, string> = {
				q: chunk,
				source: 'en',
				target: targetLang,
				format: 'text',
			}
			if (rawKey) payload.api_key = rawKey

			let res: Response
			try {
				res = await fetchWithTimeout(
					endpoint,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
					},
					10000
				)
			} catch {
				throw new Error(
					`Cannot reach LibreTranslate server at "${endpoint}". Ensure the instance is running and allows CORS.`
				)
			}

			if (!res.ok) {
				const errData = await res.json().catch(() => null)
				const errorDetail = errData?.error || res.statusText
				if (
					res.status === 400 &&
					(!rawKey || errorDetail.toLowerCase().includes('api key'))
				) {
					throw new Error(
						`LibreTranslate (${endpoint}) requires an API key. For 100% free translation without an API key, use the default Free Web Translator.`
					)
				}
				throw new Error(`LibreTranslate error (${res.status}): ${errorDetail}`)
			}

			const data = await res.json()
			results.push(data.translatedText || chunk)
		}

		return results
	},
	async test(config) {
		const endpoint = (config.endpoint || 'https://libretranslate.com').trim()
		const rawKey = deobfuscateApiKey(config.key || '').trim()
		const isLocal = endpoint.includes('localhost') || endpoint.includes('127.0.0.1')

		if (!isLocal && !rawKey) {
			return {
				success: false,
				message: `LibreTranslate (${endpoint}) requires an API key. For 100% free translation without an API key, use the default Free Web Translator below.`,
			}
		}

		try {
			const res = await this.translate(['Hello'], 'es', config)
			return { success: true, message: `Connected! Sample: "${res[0]}"` }
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			return { success: false, message: msg }
		}
	},
}

// Free Google clients5 endpoint
async function translateWithGoogleClients5(
	text: string,
	targetLang: string,
	timeoutMs = 8000
): Promise<string> {
	let googleLang = targetLang
	if (googleLang === 'zh') googleLang = 'zh-CN'
	if (googleLang === 'zh-TW') googleLang = 'zh-TW'

	const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=${encodeURIComponent(googleLang)}`

	// POST first for large payloads
	try {
		const res = await fetchWithTimeout(
			url,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `q=${encodeURIComponent(text)}`,
			},
			timeoutMs
		)
		if (res.ok) {
			const data = await res.json()
			if (Array.isArray(data)) {
				return typeof data[0] === 'string' ? data.join('') : JSON.stringify(data)
			}
			return String(data)
		}
	} catch {}
	const getUrl = `${url}&q=${encodeURIComponent(text.slice(0, 1500))}`
	const res = await fetchWithTimeout(getUrl, {}, timeoutMs)
	if (!res.ok) {
		throw new Error(`Google clients5 error (${res.status})`)
	}
	const data = await res.json()
	if (Array.isArray(data)) {
		return typeof data[0] === 'string' ? data.join('') : JSON.stringify(data)
	}
	return String(data)
}
// Free Google GTX endpoint, fallback on clients5 429
async function translateWithGoogleGtx(
	text: string,
	targetLang: string,
	timeoutMs = 8000
): Promise<string> {
	let googleLang = targetLang
	if (googleLang === 'zh') googleLang = 'zh-CN'
	if (googleLang === 'zh-TW') googleLang = 'zh-TW'

	const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(googleLang)}&dt=t`

	try {
		const res = await fetchWithTimeout(
			url,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: `q=${encodeURIComponent(text)}`,
			},
			timeoutMs
		)
		if (res.ok) {
			const data = await res.json()
			if (Array.isArray(data) && Array.isArray(data[0])) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return data[0].map((item: any) => item[0] || '').join('')
			}
		}
	} catch {}
	const getUrl = `${url}&q=${encodeURIComponent(text.slice(0, 1500))}`
	const res = await fetchWithTimeout(getUrl, {}, timeoutMs)
	if (!res.ok) {
		throw new Error(`Google GTX error (${res.status})`)
	}
	const data = await res.json()
	if (Array.isArray(data) && Array.isArray(data[0])) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return data[0].map((item: any) => item[0] || '').join('')
	}
	throw new Error('Google GTX returned unexpected structure')
}

async function translateWithFreeGoogle(
	text: string,
	targetLang: string,
	timeoutMs = 8000
): Promise<string> {
	try {
		return await translateWithGoogleClients5(text, targetLang, timeoutMs)
	} catch {
		return await translateWithGoogleGtx(text, targetLang, timeoutMs)
	}
}

// MyMemory fallback, CORS enabled
async function translateWithMyMemory(
	chunk: string,
	targetLang: string,
	timeoutMs = 4000
): Promise<string> {
	const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk.slice(0, 500))}&langpair=en|${encodeURIComponent(targetLang)}`
	const res = await fetchWithTimeout(url, {}, timeoutMs)
	if (!res.ok) {
		throw new Error(`MyMemory API status ${res.status}`)
	}
	const data = await res.json()
	if (data?.responseData?.translatedText) {
		return data.responseData.translatedText
	}
	throw new Error('MyMemory returned empty translation')
}

// 5. Free web, delimiter batches, dual fallback
export const freeWebProvider: ProviderTranslator = {
	id: 'free_web',
	async translate(chunks, targetLang) {
		if (chunks.length === 0) return []

		const DELIMITER = '\n\n⟦§⟧\n\n'
		const results: string[] = []
		let successCount = 0
		const batches: string[][] = []
		let currentBatch: string[] = []
		let currentLength = 0

		for (const chunk of chunks) {
			if (currentBatch.length > 0 && currentLength + chunk.length > 2500) {
				batches.push(currentBatch)
				currentBatch = [chunk]
				currentLength = chunk.length
			} else {
				currentBatch.push(chunk)
				currentLength += chunk.length
			}
		}
		if (currentBatch.length > 0) {
			batches.push(currentBatch)
		}

		for (let b = 0; b < batches.length; b++) {
			const batch = batches[b]
			const joinedText = batch.join(DELIMITER)

			let batchSuccess = false

			// 1. Batched Google
			try {
				const translatedJoined = await translateWithFreeGoogle(
					joinedText,
					targetLang,
					10000
				)
				const parts = translatedJoined.split(/\s*⟦\s*§\s*⟧\s*/)

				if (parts.length === batch.length) {
					results.push(...parts)
					successCount += batch.length
					batchSuccess = true
				}
			} catch (err) {
				console.warn(
					'[FreeWebTranslator] Batched translation failed, falling back to itemized:',
					err
				)
			}

			// 2. Per-item fallback
			if (!batchSuccess) {
				for (const chunk of batch) {
					if (!chunk.trim()) {
						results.push(chunk)
						continue
					}

					let translatedChunk: string | null = null
					try {
						translatedChunk = await translateWithFreeGoogle(chunk, targetLang, 4000)
						successCount++
					} catch {
						try {
							translatedChunk = await translateWithMyMemory(chunk, targetLang, 3000)
							successCount++
						} catch {
							translatedChunk = chunk
						}
					}

					results.push(translatedChunk || chunk)
					await new Promise((r) => setTimeout(r, 40))
				}
			}

			// Pause to avoid rate limits
			if (b + 1 < batches.length) {
				await new Promise((r) => setTimeout(r, 60))
			}
		}

		if (chunks.length > 0 && successCount === 0) {
			throw new Error('All free web translation engines were unreachable')
		}

		return results
	},
	async test() {
		try {
			const res = await this.translate(['Hello world'], 'es', { enabled: true })
			return { success: true, message: `Connected! Sample: "${res[0]}"` }
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			return { success: false, message: msg }
		}
	},
}

export const PROVIDERS_REGISTRY: Record<ProviderId, ProviderTranslator> = {
	deepl: deeplProvider,
	google_cloud: googleCloudProvider,
	azure: azureProvider,
	libretranslate: libreTranslateProvider,
	free_web: freeWebProvider,
}
