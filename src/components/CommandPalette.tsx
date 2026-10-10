import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { useNavigate } from 'react-router'
import type { ChapterWithSections } from '@/lib/chapters'
import { GITHUB_REPO_URL, GITHUB_REPO_HANDLE } from '@/lib/constants'
import { useTranslation, useTranslatedChapters } from '@/lib/translation/TranslationContext'

interface CommandPaletteContextValue {
	isOpen: boolean
	open: () => void
	close: () => void
	toggle: () => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue>({
	isOpen: false,
	open: () => {},
	close: () => {},
	toggle: () => {},
})

export function useCommandPalette() {
	return useContext(CommandPaletteContext)
}

type CommandIcon = 'chapter' | 'home' | 'github' | 'theme' | 'random' | 'page'

interface Command {
	id: string
	label: string
	rawLabel?: string
	subtitle?: string
	rawSubtitle?: string
	icon: CommandIcon
	action: () => void
}

interface CommandPaletteProviderProps {
	chapters?: ChapterWithSections[]
	children: ReactNode
}

export function CommandPaletteProvider({
	chapters: rawChapters = [],
	children,
}: CommandPaletteProviderProps) {
	const navigate = useNavigate()
	const { t, ensureChapterSectionsTranslated } = useTranslation()
	const chapters = useTranslatedChapters(rawChapters)
	const [isOpen, setIsOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [activeIndex, setActiveIndex] = useState(0)
	const inputRef = useRef<HTMLInputElement>(null)

	const open = () => setIsOpen(true)
	const close = () => {
		setIsOpen(false)
		setQuery('')
	}
	const toggle = () => setIsOpen((p) => !p)

	useEffect(() => {
		if (isOpen && inputRef.current) {
			inputRef.current.focus()
			inputRef.current.select()
		}
	}, [isOpen])

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
				e.preventDefault()
				toggle()
			} else if (e.key === 'Escape' && isOpen) {
				e.preventDefault()
				close()
			}
		}
		window.addEventListener('keydown', handler)
		return () => window.removeEventListener('keydown', handler)
	}, [isOpen])

	const toggleTheme = () => {
		const root = document.documentElement
		const current = root.getAttribute('data-theme') || localStorage.getItem('theme') || 'gobook'
		const next = current === 'gobook' ? 'gobooklight' : 'gobook'
		root.setAttribute('data-theme', next)
		localStorage.setItem('theme', next)
	}

	const commands: Command[] = useMemo(() => {
		const chapterCmds: Command[] = chapters.map((ch) => {
			const first = ch.sections[0]
			const href = first ? `/chapters/${ch.slug}/${first.slug}` : `/chapters/${ch.slug}`
			const rawTitle = ch.rawTitle || ch.title
			const rawPart = ch.rawPartLabel || ch.partLabel
			const secCount = ch.sections.length
			return {
				id: `chapter:${ch.slug}`,
				label: ch.title,
				rawLabel: rawTitle,
				subtitle: `${ch.partLabel} · ${secCount} ${secCount === 1 ? t('section') : t('sections')}`,
				rawSubtitle: `${rawPart} · ${secCount} sections`,
				icon: 'chapter' as const,
				action: () => {
					navigate(href)
					close()
				},
			}
		})

		const mainCount = (rawChapters || chapters).filter((c) =>
			/^Chapter \d+:/i.test(c.rawTitle || c.title)
		).length

		return [
			{
				id: 'utility:theme',
				label: t('toggleTheme') || 'Toggle theme',
				subtitle: t('themeSubtitle') || 'Dark · Light',
				icon: 'theme',
				action: () => {
					toggleTheme()
					close()
				},
			},
			{
				id: 'page:home',
				label: t('home') || 'Home',
				subtitle: '/',
				icon: 'home',
				action: () => {
					navigate('/')
					close()
				},
			},
			{
				id: 'page:chapters',
				label: t('chaptersList') || 'Chapters List',
				subtitle: '/chapters',
				icon: 'chapter',
				action: () => {
					navigate('/chapters')
					close()
				},
			},
			{
				id: 'page:firstChapter',
				label: t('firstChapter') || 'First Chapter',
				subtitle: chapters[0]?.title,
				icon: 'chapter',
				action: () => {
					if (chapters[0]) {
						const f = chapters[0].sections[0]
						navigate(
							f
								? `/chapters/${chapters[0].slug}/${f.slug}`
								: `/chapters/${chapters[0].slug}`
						)
						close()
					}
				},
			},
			{
				id: 'utility:random',
				label: t('randomChapter') || 'Random chapter',
				subtitle: mainCount ? `${mainCount} ${t('chapters')}` : undefined,
				icon: 'random',
				action: () => {
					if (!chapters.length) return
					const ch = chapters[Math.floor(Math.random() * chapters.length)]
					const first = ch.sections[0]
					navigate(first ? `/chapters/${ch.slug}/${first.slug}` : `/chapters/${ch.slug}`)
					close()
				},
			},
			{
				id: 'external:github',
				label: t('viewOnGitHub') || 'View on GitHub',
				subtitle: GITHUB_REPO_HANDLE,
				icon: 'github',
				action: () => {
					window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer')
					close()
				},
			},
			...chapterCmds,
		]
	}, [chapters, rawChapters, navigate, t])

	const sectionCmds: Command[] = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return []
		const list: Command[] = []
		for (const ch of chapters) {
			for (const sec of ch.sections) {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const secRaw = (sec as any).rawTitle || sec.title
				if (sec.title.toLowerCase().includes(q) || secRaw.toLowerCase().includes(q)) {
					list.push({
						id: `section:${ch.slug}:${sec.slug}`,
						label: sec.title,
						rawLabel: secRaw,
						subtitle: `${ch.title} · ${t('section')}`,
						rawSubtitle: `${ch.rawTitle || ch.title} · Section`,
						icon: 'page',
						action: () => {
							navigate(`/chapters/${ch.slug}/${sec.slug}`)
							close()
						},
					})
				}
			}
		}
		return list.slice(0, 30)
	}, [chapters, query, navigate, t])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return commands
		const matchedCommands = commands.filter((cmd) => {
			const haystack =
				`${cmd.label} ${cmd.rawLabel || ''} ${cmd.subtitle || ''} ${cmd.rawSubtitle || ''}`.toLowerCase()
			return haystack.includes(q)
		})
		return [...matchedCommands, ...sectionCmds]
	}, [commands, sectionCmds, query])

	useEffect(() => {
		if (!query.trim() || !filtered.length) return
		const toTranslate: Array<{ title: string }> = []
		for (const cmd of filtered) {
			if (cmd.id.startsWith('section:') && cmd.rawLabel) {
				toTranslate.push({ title: cmd.rawLabel })
			}
		}
		if (toTranslate.length > 0) {
			ensureChapterSectionsTranslated(toTranslate.slice(0, 30))
		}
	}, [query, filtered, ensureChapterSectionsTranslated])

	useEffect(() => {
		setActiveIndex(0)
	}, [filtered.length, isOpen])

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (!filtered.length) return
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setActiveIndex((p) => (p + 1) % filtered.length)
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setActiveIndex((p) => (p - 1 + filtered.length) % filtered.length)
		} else if (e.key === 'Enter') {
			e.preventDefault()
			filtered[activeIndex]?.action()
		}
	}

	const ctx = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen])

	const ICON_LABELS: Record<CommandIcon, string> = {
		chapter: 'Ch',
		home: 'H',
		github: 'GH',
		theme: 'Th',
		random: '?',
		page: 'Pg',
	}

	return (
		<CommandPaletteContext.Provider value={ctx}>
			{children}
			{isOpen && (
				<div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
					<button
						type="button"
						className="absolute inset-0 bg-base-300/50 backdrop-blur-sm"
						aria-label="Close command palette"
						onClick={close}
					/>

					<div className="relative z-10 w-full max-w-xl mx-4 rounded-2xl border border-base-300/60 bg-base-100/90 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-xl">
						<div className="flex items-center gap-2 border-b border-base-300/60 px-3 py-2.5">
							<svg
								aria-hidden="true"
								className="h-4 w-4 text-base-content/60"
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
								ref={inputRef}
								type="text"
								className="flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/50"
								placeholder={`${t('search')} ${t('chapters').toLowerCase()}… · Ctrl/⌘K`}
								aria-label={t('search')}
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								onKeyDown={handleKeyDown}
							/>
						</div>

						<div className="max-h-80 overflow-y-auto px-2 py-2 text-sm">
							{filtered.length === 0 ? (
								<div className="px-3 py-6 text-xs text-base-content/60">
									{t('noResults')} &ldquo;{query}&rdquo;.
								</div>
							) : (
								<ul className="space-y-1">
									{filtered.map((cmd, i) => {
										const active = i === activeIndex
										return (
											<li key={cmd.id}>
												<button
													type="button"
													onClick={() => cmd.action()}
													onMouseEnter={() => setActiveIndex(i)}
													className={`w-full flex items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer border transition-all duration-150 ${
														active
															? 'bg-base-200/80 border-primary/70 text-base-content shadow-md'
															: 'border-transparent text-base-content/80 hover:bg-base-200/60 hover:border-base-300/80'
													}`}
												>
													<div className="flex items-center gap-2">
														<span className="flex h-6 w-6 items-center justify-center rounded-md bg-base-300/80 text-[0.7rem] font-mono shrink-0">
															{ICON_LABELS[cmd.icon]}
														</span>
														<div className="flex flex-col items-start text-left">
															<span className="text-xs sm:text-sm font-medium leading-tight">
																{cmd.label}
															</span>
															{cmd.subtitle && (
																<span className="text-[0.7rem] text-base-content/60 leading-tight">
																	{cmd.subtitle}
																</span>
															)}
														</div>
													</div>
												</button>
											</li>
										)
									})}
								</ul>
							)}
						</div>

						<div className="flex items-center justify-between border-t border-base-300/60 px-3 py-2 text-[0.7rem] text-base-content/60">
							<span>
								{t('navigateHelp') || '↑↓ navigate · Enter select · Esc close'}
							</span>
							<span className="hidden sm:flex items-center gap-1">
								<kbd className="kbd kbd-xs">Ctrl</kbd>
								<kbd className="kbd kbd-xs">K</kbd>
							</span>
						</div>
					</div>
				</div>
			)}
		</CommandPaletteContext.Provider>
	)
}
