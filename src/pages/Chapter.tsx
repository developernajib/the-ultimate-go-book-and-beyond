import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router'
import Navbar from '@/components/Navbar'
import Sidebar from '@/components/Sidebar'
import ChapterRenderer from '@/components/ChapterRenderer'
import SectionNav from '@/components/SectionNav'
import ReadingProgress from '@/components/ReadingProgress'
import Tooltip from '@/components/Tooltip'
import ContributeCallout from '@/components/ContributeCallout'
import {
	getAllChapters,
	getSectionContent,
	getAllSectionsFlat,
	type ChapterWithSections,
} from '@/lib/chapters'
import { parseMarkdown } from '@/lib/markdown'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import { useTranslation, useTranslatedChapters } from '@/lib/translation/TranslationContext'
import { translateSection } from '@/lib/translation/engine'
import { getCachedTranslation, deleteCachedTranslation } from '@/lib/translation/cache'
import { isCoverSection } from '@/lib/translation/masker'
import { ALL_LANGUAGES } from '@/lib/translation/languages'
import { PROVIDER_METAS, type ProviderId } from '@/lib/translation/types'

export default function ChapterPage() {
	const { slug, section: sectionSlug } = useParams<{ slug: string; section: string }>()
	const navigate = useNavigate()

	const [rawChapters, setChapters] = useState<ChapterWithSections[]>([])
	const chapters = useTranslatedChapters(rawChapters)
	const [sidebarOpen, setSidebarOpen] = useState(false)
	const {
		language,
		setLanguage,
		settings,
		openSettings,
		setActiveProvider,
		refreshCacheStats,
		t,
		ensureChapterSectionsTranslated,
	} = useTranslation()

	const currentChapter = chapters.find((c) => c.slug === slug) || null
	const currentSection = currentChapter?.sections.find((s) => s.slug === sectionSlug) || null

	useDocumentMeta(
		currentChapter && currentSection
			? `${currentSection.title} | ${currentChapter.title} | Go Book & Beyond`
			: 'Go Book & Beyond',
		currentChapter
			? `Read ${currentSection?.title ?? currentChapter.title} from ${currentChapter.title} in The Ultimate Go Book & Beyond.`
			: undefined
	)

	useEffect(() => {
		if (currentChapter && language !== 'en') {
			ensureChapterSectionsTranslated(currentChapter.sections)
		}
	}, [currentChapter, language, ensureChapterSectionsTranslated])

	const [html, setHtml] = useState('')
	const [contentLoading, setContentLoading] = useState(true)
	const [initialLoading, setInitialLoading] = useState(true)
	const [flatSections, setFlatSections] = useState<
		Awaited<ReturnType<typeof getAllSectionsFlat>>
	>([])

	const [translatingMsg, setTranslatingMsg] = useState('')
	const [translationError, setTranslationError] = useState<string | null>(null)
	const [usedProvider, setUsedProvider] = useState<ProviderId | null>(null)
	const [fromCache, setFromCache] = useState(false)
	const [retryCount, setRetryCount] = useState(0)

	const prevSlugSection = useRef('')
	const rawContentRef = useRef<string>('')
	const prevKey = useRef('')
	const activeLoadIdRef = useRef(0)

	// Reset scroll on mount before browser can restore position
	useEffect(() => {
		const scroller = document.getElementById('main-scroll')
		if (scroller) scroller.scrollTop = 0
		window.scrollTo(0, 0)
	}, [])

	// Load chapters list once
	useEffect(() => {
		Promise.all([getAllChapters(), getAllSectionsFlat()]).then(([all, flat]) => {
			setChapters(all)
			setFlatSections(flat)
			setInitialLoading(false)
		})
	}, [])

	// Arrow key navigation between sections
	useEffect(() => {
		if (!slug || !sectionSlug || flatSections.length === 0) return

		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			if (
				target.tagName === 'INPUT' ||
				target.tagName === 'TEXTAREA' ||
				target.isContentEditable ||
				e.ctrlKey ||
				e.metaKey ||
				e.altKey
			)
				return

			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

			const idx = flatSections.findIndex(
				(s) => s.chapterSlug === slug && s.slug === sectionSlug
			)
			if (idx === -1) return

			if (e.key === 'ArrowLeft' && idx > 0) {
				e.preventDefault()
				const prev = flatSections[idx - 1]
				navigate(`/chapters/${prev.chapterSlug}/${prev.slug}`)
			} else if (e.key === 'ArrowRight' && idx < flatSections.length - 1) {
				e.preventDefault()
				const next = flatSections[idx + 1]
				navigate(`/chapters/${next.chapterSlug}/${next.slug}`)
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [slug, sectionSlug, flatSections, navigate])

	// Load section content and handle translation
	useEffect(() => {
		if (!slug || !sectionSlug || rawChapters.length === 0) return

		const fullKey = `${slug}/${sectionSlug}:${language}:${retryCount}`
		if (prevKey.current === fullKey && !contentLoading) return
		prevKey.current = fullKey

		const sectionNavKey = `${slug}/${sectionSlug}`
		const isNewSection = prevSlugSection.current !== sectionNavKey
		prevSlugSection.current = sectionNavKey

		if (isNewSection) {
			const scroller = document.getElementById('main-scroll')
			if (scroller) scroller.scrollTop = 0

			const chapter = rawChapters.find((c) => c.slug === slug)
			if (!chapter) {
				navigate('/', { replace: true })
				return
			}

			const sec = chapter.sections.find((s) => s.slug === sectionSlug)
			if (!sec) {
				const first = chapter.sections[0]
				if (first) navigate(`/chapters/${slug}/${first.slug}`, { replace: true })
				return
			}
		}

		const loadId = ++activeLoadIdRef.current
		setContentLoading(true)
		setTranslatingMsg('')
		setTranslationError(null)
		setFromCache(false)

		const runLoad = async () => {
			try {
				const isCoverSlug = slug === '00-front-matter--cover'

				// 1. Instant Cache Check: If translation is already cached, render in <10ms without fetching raw markdown
				if (language !== 'en' && !isCoverSlug) {
					const cached = await getCachedTranslation(slug, sectionSlug, language)
					if (activeLoadIdRef.current !== loadId) return
					if (cached && cached.content) {
						const { html: rendered } = parseMarkdown(cached.content)
						setHtml(rendered)
						setUsedProvider(cached.provider)
						setActiveProvider(cached.provider)
						setFromCache(true)
						setTranslationError(null)
						setTranslatingMsg('')
						setContentLoading(false)
						return
					}
				}

				// 2. Fetch raw markdown
				let raw = rawContentRef.current
				if (isNewSection || !raw) {
					raw = await getSectionContent(slug, sectionSlug)
					if (activeLoadIdRef.current !== loadId) return
					rawContentRef.current = raw
				}

				const isCover = isCoverSection(slug, sectionSlug, raw)
				if (isCover) {
					// Purge any corrupted translation of cover from earlier sessions
					deleteCachedTranslation(slug, sectionSlug, language).catch(() => {})
				}

				// If English or Book Cover, bypass translation completely
				if (language === 'en' || isCover) {
					const { html: rendered } = parseMarkdown(raw)
					if (activeLoadIdRef.current !== loadId) return
					setHtml(rendered)
					setUsedProvider(null)
					setActiveProvider(null)
					setTranslationError(null)
					setTranslatingMsg('')
					setContentLoading(false)
					return
				}

				// 3. Translate with configured cascade & strict 30-second timeout
				setTranslatingMsg('Translating...')

				const TRANSLATION_TIMEOUT_MS = 30000
				const timeoutPromise = new Promise<never>((_, reject) => {
					setTimeout(() => {
						reject(new Error('Translation timed out after 30 seconds.'))
					}, TRANSLATION_TIMEOUT_MS)
				})

				const res = await Promise.race([
					translateSection({
						chapterSlug: slug,
						sectionSlug,
						targetLang: language,
						rawMarkdown: raw,
						settings,
						onProgress: (msg) => {
							if (activeLoadIdRef.current === loadId) setTranslatingMsg(msg)
						},
					}),
					timeoutPromise,
				])

				if (activeLoadIdRef.current !== loadId) return
				const { html: rendered } = parseMarkdown(res.translatedMarkdown)
				setHtml(rendered)
				setUsedProvider(res.provider)
				setActiveProvider(res.provider)
				setFromCache(res.fromCache)
				setTranslationError(null)
				setTranslatingMsg('')
				setContentLoading(false)
				refreshCacheStats()
			} catch (err: unknown) {
				if (activeLoadIdRef.current !== loadId) return
				const msg = err instanceof Error ? err.message : String(err)
				setTranslationError(msg)
				setTranslatingMsg('')
				// Fall back to original English content so reading is uninterrupted
				if (rawContentRef.current) {
					const { html: rendered } = parseMarkdown(rawContentRef.current)
					setHtml(rendered)
				}
				setContentLoading(false)
			}
		}

		runLoad()

		return () => {
			// eslint-disable-next-line react-hooks/exhaustive-deps
			activeLoadIdRef.current++
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		slug,
		sectionSlug,
		rawChapters,
		language,
		retryCount,
		settings,
		navigate,
		setActiveProvider,
		refreshCacheStats,
	])

	const currentLangMeta = ALL_LANGUAGES.find((l) => l.code === language) || {
		code: language,
		name: language,
		nativeName: language,
	}

	// Read during render only for display banners; content itself loads via effect above
	// eslint-disable-next-line react-hooks/refs
	const isCover = isCoverSection(slug, sectionSlug, rawContentRef.current)

	const [scrollbarWidth, setScrollbarWidth] = useState(0)

	const mainScrollCallbackRef = useCallback((el: HTMLDivElement | null) => {
		if (!el) return
		const update = () => {
			const sw = el.offsetWidth - el.clientWidth
			if (sw > 0) setScrollbarWidth(sw)
		}
		update()
		const ro = new ResizeObserver(update)
		ro.observe(el)
	}, [])

	if (initialLoading) {
		return (
			<div className="min-h-screen bg-base-200 flex items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<svg
						aria-hidden="true"
						className="h-10 w-10 animate-spin text-primary"
						viewBox="0 0 24 24"
						fill="none"
					>
						<circle
							className="opacity-20"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="3"
						/>
						<path
							className="opacity-90"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						/>
					</svg>
					<p className="text-base-content/60 text-sm">{t('loading')}</p>
				</div>
			</div>
		)
	}

	return (
		<div className="flex flex-col h-screen overflow-hidden bg-base-200 w-full">
			<div className="shrink-0 z-30">
				<Navbar
					chapters={chapters}
					currentSlug={slug}
					currentSection={currentSection?.title}
					onOpenSidebar={() => setSidebarOpen(true)}
					sidebarOpen={sidebarOpen}
				/>
				<ReadingProgress
					scrollContainerId="main-scroll"
					resetKey={`${slug}/${sectionSlug}`}
				/>
			</div>

			<div className="flex flex-1 min-h-0 w-full">
				<Sidebar
					chapters={rawChapters}
					currentSlug={slug}
					currentSectionSlug={sectionSlug}
					mobileOpen={sidebarOpen}
					setMobileOpen={setSidebarOpen}
				/>

				<div className="flex-1 min-w-0 flex flex-col min-h-0">
					<div
						id="main-scroll"
						ref={mainScrollCallbackRef}
						className="flex-1 min-h-0 overflow-y-scroll"
					>
						<main id="main-content" className="px-4 sm:px-6 lg:px-10 py-6 lg:py-10">
							<div className="mx-auto w-full max-w-4xl space-y-4">
								<nav className="text-xs sm:text-sm text-base-content/70">
									<ol className="flex flex-wrap items-center gap-y-1">
										<li className="flex items-center">
											<Link
												to="/"
												className="hover:text-base-content transition-colors"
											>
												{t('home')}
											</Link>
											<span className="mx-1.5 text-base-content/30">/</span>
										</li>
										{currentChapter && (
											<>
												<li className="flex items-center">
													<Tooltip
														content={currentChapter.partLabel}
														position="bottom"
													>
														<span className="text-base-content/60 truncate max-w-[160px] cursor-arrow">
															{currentChapter.partLabel}
														</span>
													</Tooltip>
													<span className="mx-1.5 text-base-content/30">
														/
													</span>
												</li>
												<li className="flex items-center">
													<Tooltip
														content={currentChapter.title}
														position="bottom"
													>
														<span className="text-base-content/70 font-medium truncate max-w-[180px] cursor-arrow">
															{currentChapter.title}
														</span>
													</Tooltip>
													{currentSection &&
														currentSection.title !== 'Introduction' && (
															<>
																<span className="mx-1.5 text-base-content/30">
																	/
																</span>
																<Tooltip
																	content={currentSection.title}
																	position="bottom"
																>
																	<span className="text-base-content/80 font-medium truncate max-w-[140px] cursor-arrow">
																		{currentSection.title}
																	</span>
																</Tooltip>
															</>
														)}
												</li>
											</>
										)}
									</ol>
								</nav>

								{currentChapter && (
									<div className="flex items-center gap-2 flex-wrap">
										<span className="badge badge-neutral badge-sm px-3 py-3">
											{currentChapter.partLabel}
										</span>
										{currentSection && currentChapter.sections.length > 1 && (
											<span className="badge badge-neutral badge-sm px-3 py-3">
												{t('section')} {currentSection.index + 1} /{' '}
												{currentChapter.sections.length}
											</span>
										)}
									</div>
								)}

								{translationError && (
									<div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-base-content flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
										<div className="flex items-center gap-2">
											<span className="text-warning text-base shrink-0">
												⚠️
											</span>
											<span className="text-base-content/80 leading-relaxed">
												{t('translationWarning')}: {translationError}.{' '}
												{t('showingEnglishOriginal')}
											</span>
										</div>
										<div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
											<button
												type="button"
												onClick={() => setRetryCount((c) => c + 1)}
												className="btn btn-xs btn-ghost border border-base-300"
											>
												{t('retry')}
											</button>
											<button
												type="button"
												onClick={() => setLanguage('en')}
												className="btn btn-xs btn-ghost border border-base-300"
											>
												{t('english')}
											</button>
											<button
												type="button"
												onClick={openSettings}
												className="btn btn-xs btn-primary"
											>
												{t('settings')}
											</button>
										</div>
									</div>
								)}

								{isCover && language !== 'en' && !contentLoading && (
									<div className="flex items-center justify-between text-[11px] text-base-content/60 bg-base-100/60 rounded-xl px-3 py-1.5 border border-base-300/40">
										<div className="flex items-center gap-2">
											<span>{t('coverPreserved')}</span>
											<span className="py-2 badge badge-xs badge-neutral">
												{t('originalArt')}
											</span>
										</div>
									</div>
								)}

								{!isCover &&
									!translationError &&
									language !== 'en' &&
									!contentLoading && (
										<div className="flex items-center justify-between text-[11px] text-base-content/60 bg-base-100/60 rounded-xl px-3 py-1.5 border border-base-300/40">
											<div className="flex items-center gap-2">
												<span>
													{t('translatedTo')}{' '}
													<strong className="text-base-content/80">
														{currentLangMeta.nativeName}
													</strong>
												</span>
												<span className="py-2 badge badge-xs badge-neutral">
													{fromCache
														? t('cachedOffline')
														: PROVIDER_METAS[usedProvider as ProviderId]
																?.name ||
															usedProvider ||
															'Free Web'}
												</span>
											</div>
											<button
												type="button"
												onClick={openSettings}
												className="link link-hover text-[11px] text-primary font-medium"
											>
												{t('settingsAndKeys')}
											</button>
										</div>
									)}

								{contentLoading ? (
									<div className="flex flex-col items-center justify-center py-24 gap-3">
										<svg
											aria-hidden="true"
											className="h-8 w-8 animate-spin text-primary"
											viewBox="0 0 24 24"
											fill="none"
										>
											<circle
												className="opacity-20"
												cx="12"
												cy="12"
												r="10"
												stroke="currentColor"
												strokeWidth="3"
											/>
											<path
												className="opacity-90"
												fill="currentColor"
												d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
											/>
										</svg>
										<p className="text-xs text-base-content/60 font-medium">
											{translatingMsg || t('loadingSection')}
										</p>
									</div>
								) : (
									<article
										id="chapter-content"
										dir={currentLangMeta.rtl ? 'rtl' : 'ltr'}
									>
										<ChapterRenderer html={html} />
									</article>
								)}
							</div>
						</main>
					</div>

					{flatSections.length > 0 && slug && sectionSlug && (
						<div
							className="shrink-0 bg-base-200 border-t border-base-300/40 z-20"
							style={{
								paddingRight:
									scrollbarWidth > 0 ? `${scrollbarWidth}px` : undefined,
							}}
						>
							<div className="px-4 sm:px-6 lg:px-10 py-1.5">
								<div className="mx-auto w-full max-w-4xl relative">
									<ContributeCallout
										chapterTitle={currentChapter?.title}
										sectionTitle={currentSection?.title}
									/>
									<div className="rounded-xl border border-base-300/60 bg-base-100/90 backdrop-blur-sm px-2 py-1 [html[data-theme=gobook]_&]:border-primary/30">
										<SectionNav
											flatSections={flatSections}
											currentChapterSlug={slug}
											currentSectionSlug={sectionSlug}
										/>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
