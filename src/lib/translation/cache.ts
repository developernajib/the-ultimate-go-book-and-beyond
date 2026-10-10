import type { CachedTranslationRecord, ProviderId } from './types'

const DB_NAME = 'gobook_translation_cache'
const DB_VERSION = 1
const STORE_NAME = 'translations'

const memoryFallback = new Map<string, CachedTranslationRecord>()

function getDb(): Promise<IDBDatabase | null> {
	if (typeof window === 'undefined' || !window.indexedDB) {
		return Promise.resolve(null)
	}

	return new Promise((resolve) => {
		try {
			const request = window.indexedDB.open(DB_NAME, DB_VERSION)

			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result
				if (!db.objectStoreNames.contains(STORE_NAME)) {
					const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
					store.createIndex('lang', 'lang', { unique: false })
					store.createIndex('chapterSlug', 'chapterSlug', { unique: false })
				}
			}

			request.onsuccess = () => resolve(request.result)
			request.onerror = () => {
				console.warn('[TranslationCache] IndexedDB open error, using memory fallback')
				resolve(null)
			}
		} catch (err) {
			console.warn('[TranslationCache] IndexedDB not accessible', err)
			resolve(null)
		}
	})
}

export function buildCacheKey(chapterSlug: string, sectionSlug: string, lang: string): string {
	return `${chapterSlug}:${sectionSlug}:${lang}`
}

export async function getCachedTranslation(
	chapterSlug: string,
	sectionSlug: string,
	lang: string
): Promise<CachedTranslationRecord | null> {
	// Cover ASCII art stays uncached
	if (
		chapterSlug === '00-front-matter--cover' &&
		(sectionSlug === 'from-developer-to-faang-engineer-and-beyond' || sectionSlug === '1')
	) {
		return null
	}

	const id = buildCacheKey(chapterSlug, sectionSlug, lang)

	const db = await getDb()
	if (!db) {
		return memoryFallback.get(id) || null
	}

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readonly')
			const store = tx.objectStore(STORE_NAME)
			const req = store.get(id)

			req.onsuccess = () => {
				resolve((req.result as CachedTranslationRecord) || null)
			}
			req.onerror = () => resolve(null)
		} catch {
			resolve(null)
		}
	})
}

export async function setCachedTranslation(
	chapterSlug: string,
	sectionSlug: string,
	lang: string,
	content: string,
	provider: ProviderId
): Promise<void> {
	// Cover ASCII art stays uncached
	if (
		chapterSlug === '00-front-matter--cover' &&
		(sectionSlug === 'from-developer-to-faang-engineer-and-beyond' || sectionSlug === '1')
	) {
		return
	}

	const record: CachedTranslationRecord = {
		id: buildCacheKey(chapterSlug, sectionSlug, lang),
		chapterSlug,
		sectionSlug,
		lang,
		content,
		provider,
		timestamp: Date.now(),
	}

	const db = await getDb()
	if (!db) {
		memoryFallback.set(record.id, record)
		return
	}

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			const store = tx.objectStore(STORE_NAME)
			store.put(record)
			tx.oncomplete = () => resolve()
			tx.onerror = () => resolve()
		} catch {
			resolve()
		}
	})
}

export async function deleteCachedTranslation(
	chapterSlug: string,
	sectionSlug: string,
	lang: string
): Promise<void> {
	const id = buildCacheKey(chapterSlug, sectionSlug, lang)
	memoryFallback.delete(id)
	const db = await getDb()
	if (!db) return

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			const store = tx.objectStore(STORE_NAME)
			store.delete(id)
			tx.oncomplete = () => resolve()
			tx.onerror = () => resolve()
		} catch {
			resolve()
		}
	})
}

export async function clearTranslationCache(lang?: string): Promise<void> {
	if (!lang) {
		memoryFallback.clear()
	} else {
		for (const [key, val] of memoryFallback.entries()) {
			if (val.lang === lang) memoryFallback.delete(key)
		}
	}

	const db = await getDb()
	if (!db) return

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readwrite')
			const store = tx.objectStore(STORE_NAME)

			if (!lang) {
				store.clear()
				tx.oncomplete = () => resolve()
				tx.onerror = () => resolve()
			} else {
				const index = store.index('lang')
				const req = index.openCursor(IDBKeyRange.only(lang))
				req.onsuccess = () => {
					const cursor = req.result
					if (cursor) {
						cursor.delete()
						cursor.continue()
					}
				}
				tx.oncomplete = () => resolve()
				tx.onerror = () => resolve()
			}
		} catch {
			resolve()
		}
	})
}

export async function getCacheStats(): Promise<{ count: number; estimatedSizeKb: number }> {
	const db = await getDb()
	if (!db) {
		let size = 0
		for (const r of memoryFallback.values()) {
			size += (r.content?.length || 0) * 2
		}
		return { count: memoryFallback.size, estimatedSizeKb: Math.round(size / 1024) }
	}

	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE_NAME, 'readonly')
			const store = tx.objectStore(STORE_NAME)
			const req = store.getAll()

			req.onsuccess = () => {
				const all = (req.result as CachedTranslationRecord[]) || []
				let size = 0
				for (const r of all) {
					size += (r.content?.length || 0) * 2
				}
				resolve({ count: all.length, estimatedSizeKb: Math.round(size / 1024) })
			}
			req.onerror = () => resolve({ count: 0, estimatedSizeKb: 0 })
		} catch {
			resolve({ count: 0, estimatedSizeKb: 0 })
		}
	})
}
