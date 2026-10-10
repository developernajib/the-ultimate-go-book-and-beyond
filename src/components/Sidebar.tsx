import { useMemo, useState, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import Tooltip from './Tooltip'
import type { ChapterWithSections } from '@/lib/chapters'
import { useTranslation, useTranslatedChapters } from '@/lib/translation/TranslationContext'

interface SidebarProps {
	chapters: ChapterWithSections[]
	currentSlug?: string
	currentSectionSlug?: string
	mobileOpen?: boolean
	setMobileOpen?: (open: boolean) => void
}

function scrollToActiveChapter(chapterEl: HTMLElement, container: HTMLElement, smooth: boolean) {
	const targetRect = chapterEl.getBoundingClientRect()
	const containerRect = container.getBoundingClientRect()

	// Prefer the part header when it sits right above the chapter
	const partHeader = chapterEl
		.closest('.mb-5')
		?.querySelector('.text-\\[0\\.65rem\\]') as HTMLElement | null
	if (partHeader) {
		const partRect = partHeader.getBoundingClientRect()
		if (partRect.top < targetRect.top && targetRect.top - partRect.top < 60) {
			const relPartTop = partRect.top - containerRect.top
			container.scrollTo({
				top: Math.max(0, container.scrollTop + relPartTop - 12),
				behavior: smooth ? 'smooth' : 'auto',
			})
			return
		}
	}

	const relativeTop = targetRect.top - containerRect.top
	const targetScrollTop = container.scrollTop + relativeTop - 16

	container.scrollTo({
		top: Math.max(0, targetScrollTop),
		behavior: smooth ? 'smooth' : 'auto',
	})
}

function ensureSectionVisible(sectionEl: HTMLElement, container: HTMLElement, smooth: boolean) {
	const sRect = sectionEl.getBoundingClientRect()
	const cRect = container.getBoundingClientRect()
	const margin = 40

	if (sRect.top < cRect.top + margin) {
		container.scrollTo({
			top: Math.max(0, container.scrollTop + (sRect.top - cRect.top) - margin),
			behavior: smooth ? 'smooth' : 'auto',
		})
	} else if (sRect.bottom > cRect.bottom - margin) {
		container.scrollTo({
			top: container.scrollTop + (sRect.bottom - cRect.bottom) + margin,
			behavior: smooth ? 'smooth' : 'auto',
		})
	}
}

export default function Sidebar({
	chapters: rawChapters,
	currentSlug,
	currentSectionSlug,
	mobileOpen = false,
	setMobileOpen,
}: SidebarProps) {
	const { t, ensureChapterSectionsTranslated } = useTranslation()
	const chapters = useTranslatedChapters(rawChapters)

	const [query, setQuery] = useState('')
	const desktopAsideRef = useRef<HTMLElement>(null)
	const mobileAsideRef = useRef<HTMLElement>(null)
	const desktopActiveSectionRef = useRef<HTMLAnchorElement>(null)
	const mobileActiveSectionRef = useRef<HTMLAnchorElement>(null)
	const desktopActiveChapterRef = useRef<HTMLButtonElement>(null)
	const mobileActiveChapterRef = useRef<HTMLButtonElement>(null)
	const isFirstRender = useRef(true)

	// Collapse to the new chapter on navigation, accordion clicks manage the rest
	const [prevSlug, setPrevSlug] = useState(currentSlug)
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set(currentSlug ? [currentSlug] : [])
	)

	if (currentSlug !== prevSlug) {
		setPrevSlug(currentSlug)
		setExpanded(new Set(currentSlug ? [currentSlug] : []))
	}

	useEffect(() => {
		if (currentSlug) {
			const ch = rawChapters.find((c) => c.slug === currentSlug)
			if (ch) {
				ensureChapterSectionsTranslated(ch.sections)
			}
		}
	}, [currentSlug, rawChapters, ensureChapterSectionsTranslated])

	const lastScrolledSlugRef = useRef<string | undefined>(undefined)
	const lastScrolledSectionRef = useRef<string | undefined>(undefined)

	// Scroll on navigation only, accordion clicks leave position alone
	useEffect(() => {
		if (query.trim()) return

		const chapterChanged = lastScrolledSlugRef.current !== currentSlug
		const sectionChanged = lastScrolledSectionRef.current !== currentSectionSlug

		if (!chapterChanged && !sectionChanged) return

		lastScrolledSlugRef.current = currentSlug
		lastScrolledSectionRef.current = currentSectionSlug

		const isSmooth = !isFirstRender.current
		isFirstRender.current = false

		const rafId = requestAnimationFrame(() => {
			if (desktopAsideRef.current) {
				if (chapterChanged && desktopActiveChapterRef.current) {
					scrollToActiveChapter(
						desktopActiveChapterRef.current,
						desktopAsideRef.current,
						isSmooth
					)
				} else if (desktopActiveSectionRef.current) {
					ensureSectionVisible(
						desktopActiveSectionRef.current,
						desktopAsideRef.current,
						isSmooth
					)
				}
			}

			// Mobile (drawer may be closed, guard it)
			if (mobileAsideRef.current && mobileOpen) {
				if (chapterChanged && mobileActiveChapterRef.current) {
					scrollToActiveChapter(
						mobileActiveChapterRef.current,
						mobileAsideRef.current,
						isSmooth
					)
				} else if (mobileActiveSectionRef.current) {
					ensureSectionVisible(
						mobileActiveSectionRef.current,
						mobileAsideRef.current,
						isSmooth
					)
				}
			}
		})

		return () => cancelAnimationFrame(rafId)
	}, [currentSlug, currentSectionSlug, mobileOpen, query])

	// Open where the user left off if the active item is already visible,
	// otherwise center it. Focus the close button and let Escape dismiss.
	useEffect(() => {
		if (!mobileOpen || !mobileAsideRef.current) return
		const container = mobileAsideRef.current
		const target = mobileActiveSectionRef.current || mobileActiveChapterRef.current
		if (target) {
			const tRect = target.getBoundingClientRect()
			const cRect = container.getBoundingClientRect()
			if (tRect.top < cRect.top || tRect.bottom > cRect.bottom) {
				container.scrollTop = Math.max(
					0,
					container.scrollTop +
						(tRect.top - cRect.top) -
						(container.clientHeight - tRect.height) / 2
				)
			}
		} else {
			container.scrollTop = 0
		}
		container.querySelector<HTMLButtonElement>('[data-drawer-close]')?.focus({
			preventScroll: true,
		})
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setMobileOpen?.(false)
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [mobileOpen, setMobileOpen])

	useEffect(() => {
		setMobileOpen?.(false)
	}, [currentSlug, currentSectionSlug, setMobileOpen])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return chapters

		return chapters
			.map((ch) => {
				const rawCh =
					`${ch.number} ${ch.title} ${ch.partLabel} ${ch.rawTitle || ''} ${ch.rawPartLabel || ''}`.toLowerCase()
				const chMatch = rawCh.includes(q)
				const matchedSections = ch.sections.filter((s) => {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const rawSec = `${s.title} ${(s as any).rawTitle || ''}`.toLowerCase()
					return rawSec.includes(q)
				})
				if (chMatch || matchedSections.length > 0) {
					return { ...ch, sections: chMatch ? ch.sections : matchedSections }
				}
				return null
			})
			.filter(Boolean) as ChapterWithSections[]
	}, [chapters, query])

	// Prefetch translated titles for search hits
	useEffect(() => {
		if (!query.trim() || !filtered.length) return
		const toTranslate: Array<{ title: string }> = []
		for (const ch of filtered) {
			for (const s of ch.sections) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const raw = (s as any).rawTitle || s.title
				toTranslate.push({ title: raw })
			}
		}
		if (toTranslate.length > 0) {
			ensureChapterSectionsTranslated(toTranslate.slice(0, 100))
		}
	}, [query, filtered, ensureChapterSectionsTranslated])

	const grouped = useMemo(() => {
		const map = new Map<string, ChapterWithSections[]>()
		for (const ch of filtered) {
			const list = map.get(ch.partLabel) || []
			list.push(ch)
			map.set(ch.partLabel, list)
		}
		return map
	}, [filtered])

	const toggleChapter = (slug: string) => {
		setExpanded((prev) => {
			const next = new Set(prev)
			if (next.has(slug)) {
				next.delete(slug)
			} else {
				next.add(slug)
			}
			return next
		})
		const ch = rawChapters.find((c) => c.slug === slug)
		if (ch) {
			ensureChapterSectionsTranslated(ch.sections)
		}
	}

	const renderSidebarContent = (isMobile: boolean) => (
		<div className="p-4">
			<div className="mb-3 flex items-center justify-between">
				<span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
					{t('contents')}
				</span>
				<span className="text-[0.65rem] text-base-content/50">
					{query
						? `${filtered.length} / ${(rawChapters || chapters).filter((c) => /^Chapter \d+:/i.test(c.rawTitle || c.title)).length}`
						: (rawChapters || chapters).filter((c) =>
								/^Chapter \d+:/i.test(c.rawTitle || c.title)
							).length}{' '}
					{t('chapters')}
				</span>
			</div>

			<label className="input input-sm input-bordered flex items-center gap-2 w-full mb-4">
				<svg
					aria-hidden="true"
					className="h-3.5 w-3.5 opacity-60"
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
					className="grow bg-transparent text-xs outline-none"
					placeholder={t('filterPlaceholder')}
					aria-label={t('filterPlaceholder')}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				{query && (
					<Tooltip content={t('clearSearch')} position="bottom">
						<button
							type="button"
							onClick={() => setQuery('')}
							aria-label={t('clearSearch')}
							className="text-base-content/40 hover:text-base-content/70 transition-colors p-0.5"
						>
							✕
						</button>
					</Tooltip>
				)}
			</label>

			{Array.from(grouped.entries()).map(([partLabel, chs]) => (
				<div key={partLabel} className="mb-5">
					<div className="mb-1.5 px-1 text-[0.65rem] font-semibold uppercase tracking-wider text-base-content/40 truncate">
						{partLabel}
					</div>
					<ul className="space-y-0.5">
						{chs.map((ch) => {
							const isCurrentChapter = ch.slug === currentSlug
							const isOpen = expanded.has(ch.slug) || !!query

							return (
								<li key={ch.slug}>
									<button
										ref={
											isCurrentChapter
												? isMobile
													? mobileActiveChapterRef
													: desktopActiveChapterRef
												: undefined
										}
										type="button"
										onClick={() => toggleChapter(ch.slug)}
										className={`w-full min-w-0 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-all duration-150 border text-left overflow-hidden ${
											isCurrentChapter
												? 'bg-base-200/80 border-primary/40'
												: 'border-transparent hover:bg-base-200/50 hover:border-base-300/60'
										}`}
									>
										<span
											className={`h-1.5 w-1.5 rounded-full shrink-0 ${isCurrentChapter ? 'bg-primary' : 'bg-base-300'}`}
										/>
										<span className="flex-1 min-w-0 truncate pr-2 text-sm font-medium text-base-content text-left">
											{ch.title}
										</span>
										<span
											className={`shrink-0 text-base-content/40 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
										>
											<svg
												aria-hidden="true"
												className="h-3 w-3"
												fill="none"
												viewBox="0 0 24 24"
												stroke="currentColor"
											>
												<path
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth={2}
													d="M9 5l7 7-7 7"
												/>
											</svg>
										</span>
									</button>

									{isOpen && (
										<ul className="mt-0.5 ml-3 pl-3 border-l border-base-300/40 space-y-0.5 pb-1">
											{ch.sections.map((sec) => {
												const isActiveSection =
													isCurrentChapter &&
													sec.slug === currentSectionSlug
												return (
													<li key={sec.slug}>
														<Link
															ref={
																isActiveSection
																	? isMobile
																		? mobileActiveSectionRef
																		: desktopActiveSectionRef
																	: undefined
															}
															to={`/chapters/${ch.slug}/${sec.slug}`}
															onClick={() => {
																const s =
																	document.getElementById(
																		'main-scroll'
																	)
																if (s) s.scrollTop = 0
															}}
															className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all duration-150 ${
																isActiveSection
																	? 'bg-primary/10 text-primary font-medium border-l-2 border-primary -ml-px pl-[7px]'
																	: 'text-base-content/70 hover:text-base-content hover:bg-base-200/60'
															}`}
														>
															<span
																className={`h-1 w-1 rounded-full shrink-0 ${isActiveSection ? 'bg-primary' : 'bg-base-300'}`}
															/>
															<span className="min-w-0 truncate pr-2">
																{sec.title}
															</span>
														</Link>
													</li>
												)
											})}
										</ul>
									)}
								</li>
							)
						})}
					</ul>
				</div>
			))}

			{query && filtered.length === 0 && (
				<p className="text-xs text-base-content/60 px-1">{t('noResults')}</p>
			)}
		</div>
	)

	return (
		<>
			<aside
				ref={desktopAsideRef}
				aria-label={t('contents')}
				className="hidden h-full w-72 xl:w-80 overflow-y-auto border-r border-base-300/60 bg-base-100 lg:block shrink-0"
			>
				{renderSidebarContent(false)}
			</aside>

			{mobileOpen && (
				<div
					className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
					onClick={() => setMobileOpen?.(false)}
				/>
			)}

			<aside
				ref={mobileAsideRef}
				id="mobile-sidebar"
				role="dialog"
				aria-modal="true"
				aria-label={t('contents')}
				className={`fixed top-0 bottom-0 left-0 z-50 w-72 sm:w-80 bg-base-100 border-r border-base-300/60 overflow-y-auto transition-transform duration-200 ease-in-out lg:hidden ${
					mobileOpen ? 'translate-x-0' : '-translate-x-full'
				}`}
			>
				<div className="flex items-center justify-between p-4 border-b border-base-300/60">
					<span className="font-semibold text-sm">{t('contents')}</span>
					<button
						type="button"
						data-drawer-close
						onClick={() => setMobileOpen?.(false)}
						className="btn btn-ghost btn-xs btn-circle"
						aria-label={t('closeSidebar')}
					>
						✕
					</button>
				</div>
				{renderSidebarContent(true)}
			</aside>
		</>
	)
}
