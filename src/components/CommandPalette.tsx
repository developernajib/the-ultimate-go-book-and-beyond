import {
    createContext,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChapterWithSections } from '@/lib/chapters'

// ─── Context ───────────────────────────────────────────────────────────────────

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

// ─── Types ─────────────────────────────────────────────────────────────────────

type CommandIcon = 'chapter' | 'home' | 'github' | 'theme' | 'random' | 'page'

interface Command {
    id: string
    label: string
    subtitle?: string
    icon: CommandIcon
    action: () => void
}

// ─── Provider ──────────────────────────────────────────────────────────────────

interface CommandPaletteProviderProps {
    chapters?: ChapterWithSections[]
    children: ReactNode
}

export function CommandPaletteProvider({ chapters = [], children }: CommandPaletteProviderProps) {
    const navigate = useNavigate()
    const [isOpen, setIsOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [activeIndex, setActiveIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)

    const open = () => setIsOpen(true)
    const close = () => { setIsOpen(false); setQuery('') }
    const toggle = () => setIsOpen((p) => !p)

    // Focus on open
    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [isOpen])

    // Keyboard shortcut: Ctrl/Cmd+K
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
            return {
                id: `chapter:${ch.slug}`,
                label: ch.title,
                subtitle: `${ch.partLabel} · ${ch.sections.length} sections`,
                icon: 'chapter' as const,
                action: () => { navigate(href); close() },
            }
        })

        return [
            {
                id: 'utility:theme',
                label: 'Toggle theme',
                subtitle: 'Dark · Light',
                icon: 'theme',
                action: () => { toggleTheme(); close() },
            },
            {
                id: 'page:home',
                label: 'Home',
                subtitle: '/',
                icon: 'home',
                action: () => { navigate('/'); close() },
            },
            {
                id: 'utility:random',
                label: 'Random chapter',
                subtitle: chapters.length ? `${chapters.filter(c => /^Chapter \d+:/.test(c.title)).length} chapters` : undefined,
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
                label: 'View on GitHub',
                subtitle: 'github.com/developernajib/the-ultimate-go-book',
                icon: 'github',
                action: () => {
                    window.open('https://github.com/developernajib/the-ultimate-go-book', '_blank', 'noopener,noreferrer')
                    close()
                },
            },
            ...chapterCmds,
        ]
    }, [chapters, navigate])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return commands
        return commands.filter((cmd) =>
            `${cmd.label} ${cmd.subtitle || ''}`.toLowerCase().includes(q),
        )
    }, [commands, query])

    useEffect(() => { setActiveIndex(0) }, [filtered.length, isOpen])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!filtered.length) return
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((p) => (p + 1) % filtered.length) }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((p) => (p - 1 + filtered.length) % filtered.length) }
        else if (e.key === 'Enter') { e.preventDefault(); filtered[activeIndex]?.action() }
    }

    const ctx = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen])

    const ICON_LABELS: Record<CommandIcon, string> = {
        chapter: 'Ch', home: 'H', github: 'GH', theme: 'Th', random: '?', page: 'Pg',
    }

    return (
        <CommandPaletteContext.Provider value={ctx}>
            {children}
            {isOpen && (
                <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
                    {/* Backdrop */}
                    <button
                        type="button"
                        className="absolute inset-0 bg-base-300/50 backdrop-blur-sm"
                        aria-label="Close command palette"
                        onClick={close}
                    />

                    {/* Panel */}
                    <div className="relative z-10 w-full max-w-xl mx-4 rounded-2xl border border-base-300/60 bg-base-100/90 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-xl">
                        {/* Search */}
                        <div className="flex items-center gap-2 border-b border-base-300/60 px-3 py-2.5">
                            <svg className="h-4 w-4 text-base-content/60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                                ref={inputRef}
                                type="text"
                                className="flex-1 bg-transparent text-sm outline-none placeholder:text-base-content/50"
                                placeholder="Search chapters, pages, or commands… · Ctrl/⌘K"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                            />
                        </div>

                        {/* Results */}
                        <div className="max-h-80 overflow-y-auto px-2 py-2 text-sm">
                            {filtered.length === 0 ? (
                                <div className="px-3 py-6 text-xs text-base-content/60">
                                    No results for &ldquo;{query}&rdquo;.
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
                                                            <span className="text-xs sm:text-sm font-medium leading-tight">{cmd.label}</span>
                                                            {cmd.subtitle && (
                                                                <span className="text-[0.7rem] text-base-content/60 leading-tight">{cmd.subtitle}</span>
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

                        {/* Footer */}
                        <div className="flex items-center justify-between border-t border-base-300/60 px-3 py-2 text-[0.7rem] text-base-content/60">
                            <span>↑↓ navigate · Enter select · Esc close</span>
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
