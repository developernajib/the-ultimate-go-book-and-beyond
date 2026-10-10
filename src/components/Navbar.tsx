import { Link, useNavigate } from 'react-router'
import ThemeToggle from './ThemeToggle'
import LanguageSelector from './LanguageSelector'
import Tooltip from './Tooltip'
import { useCommandPalette } from './CommandPalette'
import type { ChapterWithSections } from '@/lib/chapters'
import { GITHUB_REPO_URL } from '@/lib/constants'
import { useTranslation } from '@/lib/translation/TranslationContext'

interface NavbarProps {
	chapters?: ChapterWithSections[]
	currentSlug?: string
	currentSection?: string
	onOpenSidebar?: () => void
	sidebarOpen?: boolean
}

export default function Navbar({
	chapters = [],
	currentSlug,
	currentSection,
	onOpenSidebar,
	sidebarOpen = false,
}: NavbarProps) {
	const navigate = useNavigate()
	const { open: openPalette } = useCommandPalette()
	const { t, titleTranslations } = useTranslation()

	const currentChapter = chapters.find((c) => c.slug === currentSlug)

	const displayChapterTitle = currentChapter
		? titleTranslations[currentChapter.title] || currentChapter.title
		: ''
	const displaySection = currentSection ? titleTranslations[currentSection] || currentSection : ''

	const handleRandom = () => {
		if (!chapters.length) return
		const ch = chapters[Math.floor(Math.random() * chapters.length)]
		const first = ch.sections[0]
		navigate(first ? `/chapters/${ch.slug}/${first.slug}` : `/chapters/${ch.slug}`)
	}

	return (
		<>
			<div className="navbar bg-base-100 shadow-lg sticky top-0 z-50 px-2 sm:px-4 w-full">
				<a
					href="#main-content"
					className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[60] focus:rounded-lg focus:bg-base-100 focus:px-4 focus:py-2 focus:text-sm"
				>
					Skip to content
				</a>
				{onOpenSidebar && (
					<div className="flex-none lg:hidden">
						<button
							onClick={onOpenSidebar}
							className="btn btn-ghost btn-sm btn-circle"
							aria-label={t('tableOfContents')}
							aria-expanded={sidebarOpen}
							aria-controls="mobile-sidebar"
						>
							<svg
								aria-hidden="true"
								className="w-5 h-5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M4 6h16M4 12h16M4 18h16"
								/>
							</svg>
						</button>
					</div>
				)}

				<div className="flex-1 min-w-0 flex items-center gap-3">
					<Link
						to="/"
						className="btn btn-ghost text-base sm:text-lg font-bold px-2 sm:px-4 shrink-0 brand-gopher"
					>
						<span className="text-primary font-mono">ʕ◔ϖ◔ʔ</span>
						<span className="hidden sm:inline ml-1">Go Book & Beyond</span>
					</Link>
					{currentChapter && (
						<Tooltip
							content={
								displaySection && displaySection !== 'Introduction'
									? `${currentChapter.number} · ${displaySection}`
									: `${currentChapter.number} · ${displayChapterTitle}`
							}
							position="bottom"
						>
							<div className="hidden md:inline-flex max-w-sm items-center gap-2 rounded-full border border-base-300/60 bg-base-100/40 px-3 py-1 text-xs text-base-content/80 cursor-arrow">
								<span className="truncate">
									{displaySection && displaySection !== 'Introduction'
										? displaySection
										: displayChapterTitle}
								</span>
							</div>
						</Tooltip>
					)}
				</div>

				<div className="flex-none flex items-center gap-1 sm:gap-2">
					<Tooltip content={`${t('search')} (Ctrl+K)`} position="bottom">
						<button
							type="button"
							onClick={openPalette}
							className="btn btn-ghost btn-sm gap-2 hidden sm:inline-flex border border-base-300/60"
							aria-label={t('openCommandPalette')}
						>
							<svg
								aria-hidden="true"
								className="h-4 w-4 text-base-content/70"
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
							<span className="text-xs text-base-content/70">{t('search')}</span>
							<span className="hidden md:inline-flex items-center gap-0.5 rounded border border-base-300/80 px-1.5 py-0.5 text-[0.65rem] text-base-content/60">
								{t('ctrlK')}
							</span>
						</button>
					</Tooltip>

					<Tooltip content={t('search')} position="bottom">
						<button
							type="button"
							onClick={openPalette}
							className="btn btn-ghost btn-circle sm:hidden"
							aria-label={t('search')}
						>
							<svg
								aria-hidden="true"
								className="h-5 w-5 text-base-content/70"
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
						</button>
					</Tooltip>

					<LanguageSelector />
					<ThemeToggle />

					<div className="dropdown dropdown-end">
						<Tooltip content={t('moreOptions')} position="bottom">
							<label
								tabIndex={0}
								className="btn btn-ghost btn-circle cursor-pointer"
								aria-label={t('moreOptions')}
							>
								<svg
									aria-hidden="true"
									className="w-5 h-5"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z"
									/>
								</svg>
							</label>
						</Tooltip>
						<ul
							tabIndex={0}
							className="dropdown-content menu bg-base-100 rounded-box z-50 w-52 p-2 shadow-lg border border-base-300"
						>
							<li>
								<Link to="/">{t('home')}</Link>
							</li>
							<li>
								<Link to="/chapters/">{t('chaptersList')}</Link>
							</li>
							{chapters.length > 0 && chapters[0] && (
								<li>
									<Link to={`/chapters/${chapters[0].slug}`}>
										{t('firstChapter')}
									</Link>
								</li>
							)}
							{chapters.length > 0 && (
								<li>
									<button type="button" onClick={handleRandom}>
										{t('randomChapter')}
									</button>
								</li>
							)}
							<li className="menu-title mt-1">
								<span>{t('links')}</span>
							</li>
							<li>
								<a href={GITHUB_REPO_URL} target="_blank" rel="noopener noreferrer">
									GitHub
								</a>
							</li>
						</ul>
					</div>
				</div>
			</div>
		</>
	)
}
