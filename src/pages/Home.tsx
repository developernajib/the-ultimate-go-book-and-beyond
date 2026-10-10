import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import AnimatedTerminal from '@/components/AnimatedTerminal'
import Navbar from '@/components/Navbar'
import GoLogo from '@/components/GoLogo'
import HeroBackground from '@/components/HeroBackground'
import Tooltip from '@/components/Tooltip'
import { getAllChapters, type ChapterWithSections } from '@/lib/chapters'
import { GITHUB_REPO_URL } from '@/lib/constants'
import { useDocumentMeta } from '@/hooks/useDocumentMeta'
import {
	useTranslation,
	useTranslatedChapters,
	useTranslatedTexts,
} from '@/lib/translation/TranslationContext'
import type { UIStrings } from '@/lib/translation/uiTranslations'

const BOOK_STATS: Array<{ labelKey?: keyof UIStrings; fallback: string; value: string }> = [
	{ labelKey: 'chapters', fallback: 'Chapters', value: '165+' },
	{ labelKey: 'subChapters', fallback: 'Sub-Chapters', value: '100+' },
	{ labelKey: 'parts', fallback: 'Parts', value: '22' },
	{ fallback: 'Est. Pages', value: '28,000+' },
]

interface BookStats {
	files?: number | string
	contentLines?: number | string
	codeLines?: number | string
	totalWords?: number | string
	totalCharsRaw?: number | string
	estimatedPages?: number | string
}

const PART_HIGHLIGHTS = [
	{
		icon: '⚙️',
		title: 'Go 1.27 Mastery',
		desc: 'Green Tea GC, Swiss Tables, iterators, generics, internals',
	},
	{
		icon: '🔀',
		title: 'Concurrency',
		desc: 'Goroutines, channels, patterns, lock-free, anti-patterns',
	},
	{
		icon: '🏗️',
		title: 'System Design',
		desc: '39 problems across X-A to X-D + distributed consensus & multi-region DR',
	},
	{
		icon: '🎯',
		title: 'Interview Mastery',
		desc: 'DSA, system design mocks, SQL, LLD, behavioral, negotiation',
	},
	{
		icon: '☁️',
		title: 'Cloud & Platform',
		desc: 'Kubernetes, Terraform, GitOps, observability, security, compliance',
	},
	{
		icon: '🤖',
		title: 'AI Engineering',
		desc: 'LLM integration, AI agents, MCP/A2A, vector DBs, RAG - mandatory track',
	},
]

const STATS_DESCRIPTIONS = ['Characters', 'Words', 'Content Lines', 'Code Lines', 'Est. Pages']

export default function Home() {
	const [rawChapters, setChapters] = useState<ChapterWithSections[]>([])
	const chapters = useTranslatedChapters(rawChapters)
	const { t, language } = useTranslation()
	const [bookStats, setBookStats] = useState<BookStats | null>(null)

	useEffect(() => {
		getAllChapters().then(setChapters)
		fetch('/book-stats.json')
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (data) setBookStats(data)
			})
			.catch(() => {})
	}, [])

	const chapterCount = useMemo(() => {
		const list = rawChapters.length ? rawChapters : chapters
		return list.filter((c) => /^Chapter \d+:/i.test(c.rawTitle || c.title)).length || 165
	}, [rawChapters, chapters])

	const firstChapter = chapters[0] || null

	const startHref = useMemo(() => {
		if (!firstChapter) return '/chapters/00-front-matter--cover/intro'
		const first = firstChapter.sections[0]
		return first
			? `/chapters/${firstChapter.slug}/${first.slug}`
			: `/chapters/${firstChapter.slug}`
	}, [firstChapter])

	const heroDesc = `The most comprehensive Go engineering book ever written - ${chapterCount} chapters covering everything from your very first line of Go to building production systems at scale.`

	useDocumentMeta('The Ultimate Go Book & Beyond', heroDesc)

	const homeTexts = useMemo(
		() => [
			'Go 1.27 · Updated Oct 2026',
			'Your complete path from',
			'Beginner to Senior Engineer',
			heroDesc,
			'You came for the simplicity.',
			"You'll stay for the concurrency.",
			'Click to copy email',
			'✓ Copied!',
			'Content licensed under CC BY 4.0',
			'Est. Pages',
			...STATS_DESCRIPTIONS,
			...PART_HIGHLIGHTS.map((p) => p.title),
			...PART_HIGHLIGHTS.map((p) => p.desc),
		],
		[heroDesc]
	)

	const tr = useTranslatedTexts(homeTexts)
	const txt = (str: string) => (language === 'en' ? str : tr[str] || str)

	return (
		<div className="min-h-screen bg-base-200 relative w-full">
			<HeroBackground />

			<Navbar chapters={chapters} />

			<main id="main-content" className="relative z-10">
				<section className="hero min-h-[calc(100vh-4rem)] py-6 sm:py-10">
					<div className="hero-content w-full max-w-6xl px-3 sm:px-4 md:px-6 lg:px-8">
						<div className="flex w-full flex-col items-center gap-8 sm:gap-10 lg:flex-row lg:items-stretch lg:gap-16">
							<div className="flex-1 w-full max-w-xl text-left px-2">
								<div className="space-y-6 md:space-y-8">
									<GoLogo />

									<div className="space-y-3">
										<div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary cursor-ibeam">
											<span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
											{txt('Go 1.27 · Updated Oct 2026')}
										</div>
										<h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight tracking-tight">
											{txt('Your complete path from')}{' '}
											<span className="text-primary">
												{txt('Beginner to Senior Engineer')}
											</span>
										</h1>
										<p className="text-base sm:text-lg text-base-content/70 leading-relaxed">
											{txt(heroDesc)}
										</p>
									</div>

									<div className="flex max-w-xl items-start gap-3 rounded-xl border border-base-300/50 bg-base-100/5 px-3 sm:px-4 py-3 text-left shadow-sm">
										<div className="mt-1 h-10 w-px shrink-0 bg-gradient-to-b from-primary/70 via-primary/20 to-transparent" />
										<div className="space-y-1 min-w-0">
											<p className="text-sm sm:text-base italic text-base-content/80 font-light">
												&ldquo;{txt('You came for the simplicity.')}
											</p>
											<p className="text-sm sm:text-base italic text-primary font-medium">
												{txt("You'll stay for the concurrency.")}&rdquo;
											</p>
										</div>
									</div>

									<div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
										{BOOK_STATS.map((s) => (
											<div
												key={s.fallback}
												className="rounded-lg border border-base-300/50 bg-base-100/20 px-3 py-2 text-center cursor-ibeam"
											>
												<div className="text-lg font-bold text-primary">
													{s.value}
												</div>
												<div className="text-[0.7rem] text-base-content/60">
													{s.labelKey ? t(s.labelKey) : txt(s.fallback)}
												</div>
											</div>
										))}
									</div>

									<div className="flex flex-wrap gap-3 justify-start pt-2">
										<Link
											to={startHref}
											className="btn btn-primary btn-sm sm:btn-md"
										>
											{t('startReading')}
											<svg
												aria-hidden="true"
												className="h-4 w-4"
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
										</Link>
										<a
											href={GITHUB_REPO_URL}
											target="_blank"
											rel="noopener noreferrer"
											className="btn btn-sm sm:btn-md bg-transparent border border-primary/60 text-primary hover:bg-primary/10 hover:border-primary"
										>
											<svg
												aria-hidden="true"
												className="h-4 w-4"
												fill="currentColor"
												viewBox="0 0 24 24"
											>
												<path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
											</svg>
											GitHub
										</a>
									</div>

									<p className="text-xs text-base-content/50 pt-2 flex flex-wrap items-center gap-1.5">
										<span>{t('bookStartedBy')}</span>
										<Tooltip
											content={txt('Click to copy email')}
											position="bottom"
										>
											<button
												onClick={() => {
													navigator.clipboard.writeText(
														'developernajib@pm.me'
													)
													const btn =
														document.getElementById('copy-email-toast')
													if (btn) {
														btn.classList.remove('hidden')
														setTimeout(
															() => btn.classList.add('hidden'),
															2000
														)
													}
												}}
												className="group badge badge-primary badge-sm font-semibold cursor-pointer px-3 py-2.5 hover:scale-105 hover:shadow-md hover:shadow-primary/30 transition-all duration-200"
												aria-label="Copy email address"
											>
												<span className="group-hover:hidden">
													Md. Najib Islam
												</span>
												<span className="hidden group-hover:inline">
													developernajib@pm.me
												</span>
											</button>
										</Tooltip>
										<span>• {txt('Content licensed under CC BY 4.0')}</span>
										<span
											id="copy-email-toast"
											className="hidden text-xs text-success animate-pulse"
										>
											✓ {txt('Copied!')}
										</span>
									</p>
								</div>
							</div>

							<div className="flex-1 max-w-xl w-full">
								<AnimatedTerminal />
							</div>
						</div>
					</div>
				</section>

				{/* Human + AI starter notice */}
				<section className="relative z-10 px-4 pb-8">
					<div className="max-w-6xl mx-auto">
						<div className="flex items-start gap-4 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/5 via-base-100/10 to-warning/5 px-5 py-4 shadow-sm">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-lg">
								✦
							</div>
							<div className="space-y-1 min-w-0">
								<p className="text-sm font-semibold text-base-content">
									{txt(
										'Started, Written, Brainstormed, and Verified by both Human and AI'
									)}
								</p>
								<p className="text-xs sm:text-sm text-base-content/65 leading-relaxed">
									{txt('This book was started by')}{' '}
									<span className="font-medium text-base-content/80">
										Md. Najib Islam
									</span>{' '}
									{txt(
										'in genuine collaboration with AI, with both contributing to the writing, research, content, and verification throughout.'
									)}{' '}
									<span className="text-primary font-medium">
										{txt(
											'A new kind of technical book where Human expertise and AI work together.'
										)}
									</span>
								</p>
							</div>
						</div>
					</div>
				</section>

				<section className="relative z-10 pb-8 px-4">
					<div className="max-w-6xl mx-auto">
						<div className="text-center mb-8">
							<h2 className="text-xl sm:text-2xl font-bold">{t('whatsInside')}</h2>
							<p className="text-base-content/60 text-sm mt-1">
								{t('whatsInsideDesc')}
							</p>
						</div>
						<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
							{PART_HIGHLIGHTS.map((p) => (
								<div
									key={p.title}
									className="rounded-xl border border-base-300/50 bg-base-100/20 backdrop-blur p-4 text-center hover:border-primary/40 hover:bg-base-100/30 transition-all cursor-ibeam"
								>
									<div className="text-2xl mb-2">{p.icon}</div>
									<div className="text-sm font-semibold">{txt(p.title)}</div>
									<div className="text-[0.65rem] text-base-content/50 mt-1 leading-snug">
										{txt(p.desc)}
									</div>
								</div>
							))}
						</div>

						{bookStats && (
							<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-3">
								{[
									{
										icon: '🔤',
										title:
											typeof bookStats.totalCharsRaw === 'number'
												? `${(bookStats.totalCharsRaw / 1000000).toFixed(1)}M+`
												: bookStats.totalCharsRaw,
										desc: 'Characters',
									},
									{
										icon: '✍️',
										title:
											typeof bookStats.totalWords === 'number'
												? `${(bookStats.totalWords / 1000000).toFixed(1)}M+`
												: bookStats.totalWords,
										desc: 'Words',
									},
									{
										icon: '📝',
										title:
											typeof bookStats.contentLines === 'number'
												? `${Math.round(bookStats.contentLines / 1000)}K+`
												: bookStats.contentLines,
										desc: 'Content Lines',
									},
									{
										icon: '💻',
										title:
											typeof bookStats.codeLines === 'number'
												? `${Math.round(bookStats.codeLines / 1000)}K+`
												: bookStats.codeLines,
										desc: 'Code Lines',
									},
									{
										icon: '📄',
										title:
											typeof bookStats.estimatedPages === 'number'
												? bookStats.estimatedPages.toLocaleString('en-US')
												: bookStats.estimatedPages,
										desc: 'Est. Pages',
									},
								].map((s) => (
									<div
										key={s.desc}
										className="rounded-xl border border-base-300/50 bg-base-100/20 backdrop-blur p-4 text-center hover:border-primary/40 hover:bg-base-100/30 transition-all cursor-ibeam"
									>
										<div className="text-2xl mb-2">{s.icon}</div>
										<div className="text-sm font-semibold">{s.title}</div>
										<div className="text-[0.65rem] text-base-content/50 mt-1 leading-snug">
											{txt(s.desc)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</section>
			</main>
		</div>
	)
}
