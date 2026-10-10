import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import Navbar from '@/components/Navbar'
import { getAllChapters, type ChapterWithSections } from '@/lib/chapters'
import { useTranslation, useTranslatedChapters } from '@/lib/translation/TranslationContext'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'

// Splits "Chapter 1: Title" into label and rest, across supported languages.
function splitChapterTitle(title: string): { label: string; rest: string } {
	const match = title.match(
		/^(Chapter\s+[\w.]+[A-Z]*:|Capítulo\s+[\w.]+[A-Z]*:|Kapitel\s+[\w.]+[A-Z]*:|Chapitre\s+[\w.]+[A-Z]*:|第\s*[\w.]+\s*章:|Appendix\s+\w+:|Apéndice\s+\w+:|Capstone\s+Project\s+\d+:|Proyecto\s+final\s+\d+:|System\s+Design:|Diseño\s+de\s+sistemas:)\s*(.*)$/i
	)
	if (match) return { label: match[1], rest: match[2] }
	return { label: '', rest: title }
}

export default function ChapterList() {
	const [rawChapters, setChapters] = useState<ChapterWithSections[]>([])
	const chapters = useTranslatedChapters(rawChapters)
	const { t } = useTranslation()
	const [query, setQuery] = useState('')

	useDocumentMeta(
		'All Chapters | The Ultimate Go Book & Beyond',
		'Browse every chapter and section of The Ultimate Go Book & Beyond.'
	)

	useEffect(() => {
		getAllChapters().then(setChapters)
	}, [])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return chapters
		return chapters.filter((c) =>
			`${c.number} ${c.title} ${c.partLabel} ${c.rawTitle || ''} ${c.rawPartLabel || ''}`
				.toLowerCase()
				.includes(q)
		)
	}, [chapters, query])

	const grouped = useMemo(() => {
		const map = new Map<string, ChapterWithSections[]>()
		for (const ch of filtered) {
			const list = map.get(ch.partLabel) || []
			list.push(ch)
			map.set(ch.partLabel, list)
		}
		return map
	}, [filtered])

	const mainChaptersCount = (rawChapters || chapters).filter((c) =>
		/^Chapter \d+:/i.test(c.rawTitle || c.title)
	).length
	const subChaptersCount = (rawChapters || chapters).filter((c) =>
		/^Chapter \d+[a-z]+:/i.test(c.rawTitle || c.title)
	).length
	const partsCount = new Set(
		(rawChapters || chapters).map((c) => (c.part.match(/part-(\d+)/) || [])[1]).filter(Boolean)
	).size

	return (
		<div className="min-h-screen bg-base-200 w-full">
			<Navbar chapters={chapters} />

			<main id="main-content" className="px-4 sm:px-6 lg:px-10 py-8 lg:py-12">
				<div className="mx-auto w-full max-w-4xl">
					<h1 className="text-2xl sm:text-3xl font-bold text-base-content mb-2">
						{t('allChapters')}
					</h1>
					<p className="text-base-content/60 text-sm mb-6">
						{mainChaptersCount} {t('chapters')}
						{' · '}
						{subChaptersCount} {t('subChapters')}
						{' · '}
						{partsCount} {t('parts')}
					</p>

					<label className="input input-bordered flex items-center gap-2 w-full max-w-md mb-8">
						<svg
							aria-hidden="true"
							className="h-4 w-4 opacity-60"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
						<input
							type="text"
							className="grow bg-transparent outline-none"
							placeholder={t('filterPlaceholder')}
							aria-label={t('filterPlaceholder')}
							value={query}
							onChange={(e) => setQuery(e.target.value)}
						/>
						{query && (
							<button
								type="button"
								onClick={() => setQuery('')}
								className="text-base-content/40 hover:text-base-content/70"
								aria-label={t('clearSearch')}
							>
								✕
							</button>
						)}
					</label>

					{Array.from(grouped.entries()).map(([partLabel, chs]) => (
						<div key={partLabel} className="mb-8">
							<h2 className="text-sm font-semibold uppercase tracking-wider text-base-content/50 mb-3 px-1">
								{partLabel}
							</h2>
							<div className="grid gap-2">
								{chs.map((ch) => {
									const first = ch.sections[0]
									const href = first
										? `/chapters/${ch.slug}/${first.slug}`
										: `/chapters/${ch.slug}`
									const { label, rest } = splitChapterTitle(ch.title)
									return (
										<Link
											key={ch.slug}
											to={href}
											className="flex items-center gap-3 rounded-lg border border-base-300/60 bg-base-100 px-4 py-3 transition-all hover:border-primary/40 hover:bg-base-200/50 hover:shadow-sm overflow-hidden"
										>
											<span className="flex-1 min-w-0 text-sm text-base-content truncate">
												{label ? (
													<>
														<span className="font-semibold text-primary">
															{label}
														</span>{' '}
														{rest}
													</>
												) : (
													<span className="font-medium">{rest}</span>
												)}
											</span>
											<span className="text-xs text-base-content/40 shrink-0">
												{ch.sections.length}{' '}
												{ch.sections.length === 1
													? t('section')
													: t('sections')}
											</span>
										</Link>
									)
								})}
							</div>
						</div>
					))}

					{query && filtered.length === 0 && (
						<p className="text-base-content/60 text-sm">{t('noResults')}</p>
					)}
				</div>
			</main>
		</div>
	)
}
