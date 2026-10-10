export const CANARY = 'tuGBaB'
export const LEGACY_CANARY = 'nAJib'

export function hasLegacyCanary(storedKey?: string | null): boolean {
	if (!storedKey) return false
	return storedKey.includes(LEGACY_CANARY)
}

export function migrateLegacyCanaryKey(storedKey: string): string {
	if (!hasLegacyCanary(storedKey)) {
		return storedKey
	}
	const raw = deobfuscateApiKey(storedKey)
	if (!raw) return ''
	return obfuscateApiKey(raw)
}

// Canary goes strictly inside, never at ends
export function obfuscateApiKey(rawKey: string): string {
	if (!rawKey) return ''
	// Strip old canary to avoid doubles
	const clean = rawKey
		.replace(new RegExp(CANARY, 'g'), '')
		.replace(new RegExp(LEGACY_CANARY, 'g'), '')
		.trim()
	if (!clean) return ''
	if (clean.length < 2) {
		// Pad ultra-short keys for interior insert
		return `${clean[0]}${CANARY}${clean.slice(1) || 'x'}`
	}

	const minIndex = 1
	const maxIndex = clean.length - 1
	const insertIdx = Math.floor(Math.random() * (maxIndex - minIndex + 1)) + minIndex

	return clean.slice(0, insertIdx) + CANARY + clean.slice(insertIdx)
}

export function deobfuscateApiKey(storedKey: string): string {
	if (!storedKey) return ''
	return storedKey
		.replace(new RegExp(CANARY, 'g'), '')
		.replace(new RegExp(LEGACY_CANARY, 'g'), '')
		.trim()
}

export function maskKeyForDisplay(storedKey: string): string {
	const raw = deobfuscateApiKey(storedKey)
	if (!raw) return ''
	if (raw.length <= 8) return '••••••••'
	const start = raw.slice(0, 4)
	const end = raw.slice(-4)
	return `${start}••••••••${end}`
}
