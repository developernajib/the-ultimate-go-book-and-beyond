export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.trim()
		.slice(0, 60)
}

export function cn(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(' ')
}
