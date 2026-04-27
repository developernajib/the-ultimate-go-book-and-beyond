import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import ThemeToggle from './ThemeToggle'
import { useCommandPalette } from './CommandPalette'
import type { ChapterWithSections } from '@/lib/chapters'

interface NavbarProps {
    chapters?: ChapterWithSections[]
    currentSlug?: string
    currentSection?: string
}

export default function Navbar({ chapters = [], currentSlug, currentSection }: NavbarProps) {
    const [drawerQuery, setDrawerQuery] = useState('')
    const navigate = useNavigate()
    const { open: openPalette } = useCommandPalette()

    const currentChapter = chapters.find((c) => c.slug === currentSlug)

    const filteredDrawer = useMemo(() => {
        const q = drawerQuery.trim().toLowerCase()
        if (!q) return chapters
        return chapters.filter((c) =>
            `${c.number} ${c.title} ${c.partLabel}`.toLowerCase().includes(q),
        )
    }, [chapters, drawerQuery])

    const handleRandom = () => {
        if (!chapters.length) return
        const ch = chapters[Math.floor(Math.random() * chapters.length)]
        const first = ch.sections[0]
        navigate(first ? `/chapters/${ch.slug}/${first.slug}` : `/chapters/${ch.slug}`)
    }

    return (
        <>
            {/* ── Main Navbar ─────────────────────────────────────────────── */}
            <div className="navbar bg-base-100 shadow-lg sticky top-0 z-50 px-2 sm:px-4 w-full">
                {/* Mobile hamburger */}
                <div className="flex-none lg:hidden">
                    <label
                        htmlFor="nav-drawer"
                        className="btn btn-ghost btn-sm btn-circle"
                        aria-label="Open menu"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                    </label>
                </div>

                {/* Brand */}
                <div className="flex-1 min-w-0 flex items-center gap-3">
                    <Link to="/" className="btn btn-ghost text-base sm:text-lg font-bold px-2 sm:px-4 shrink-0">
                        <span className="text-primary font-mono">ʕ◔ϖ◔ʔ</span>
                        <span className="hidden sm:inline ml-1">Go Book & Beyond</span>
                    </Link>
                    {currentChapter && (
                        <div
                            className="hidden md:inline-flex max-w-sm items-center gap-2 rounded-full border border-base-300/60 bg-base-100/40 px-3 py-1 text-xs text-base-content/80"
                            title={currentSection || currentChapter.title}
                        >
                            <span className="truncate">
                                {currentSection && currentSection !== 'Introduction'
                                    ? currentSection
                                    : currentChapter.title}
                            </span>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex-none flex items-center gap-1 sm:gap-2">
                    {/* Search — desktop */}
                    <button
                        type="button"
                        onClick={openPalette}
                        className="btn btn-ghost btn-sm gap-2 hidden sm:inline-flex"
                        aria-label="Open command palette"
                    >
                        <svg className="h-4 w-4 text-base-content/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <span className="text-xs text-base-content/70">Search</span>
                        <span className="hidden md:inline-flex items-center gap-0.5 rounded border border-base-300/80 px-1.5 py-0.5 text-[0.65rem] text-base-content/60">
                            Ctrl K
                        </span>
                    </button>

                    {/* Search — mobile */}
                    <button
                        type="button"
                        onClick={openPalette}
                        className="btn btn-ghost btn-circle sm:hidden"
                        aria-label="Search"
                    >
                        <svg className="h-5 w-5 text-base-content/70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                    </button>

                    <ThemeToggle />

                    {/* Overflow menu */}
                    <div className="dropdown dropdown-end">
                        <label tabIndex={0} className="btn btn-ghost btn-circle" aria-label="More options">
                            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                            </svg>
                        </label>
                        <ul tabIndex={0} className="dropdown-content menu bg-base-100 rounded-box z-50 w-52 p-2 shadow-lg border border-base-300">
                            <li><Link to="/">Home</Link></li>
                            {chapters.length > 0 && chapters[0] && (
                                <li><Link to={`/chapters/${chapters[0].slug}`}>First Chapter</Link></li>
                            )}
                            {chapters.length > 0 && (
                                <li><button type="button" onClick={handleRandom}>Random chapter</button></li>
                            )}
                            <li className="menu-title mt-1"><span>Links</span></li>
                            <li>
                                <a href="https://github.com/developernajib/the-ultimate-go-book" target="_blank" rel="noopener noreferrer">
                                    GitHub
                                </a>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* ── Mobile Drawer ────────────────────────────────────────────── */}
            <div className="drawer lg:hidden">
                <input id="nav-drawer" type="checkbox" className="drawer-toggle" />
                <div className="drawer-side z-40">
                    <label htmlFor="nav-drawer" aria-label="close sidebar" className="drawer-overlay" />
                    <aside className="menu bg-base-100 min-h-full w-[85vw] max-w-sm p-4 overflow-y-auto">
                        <div className="mb-4 flex justify-between items-center">
                            <Link to="/" className="text-lg font-bold flex items-center gap-2">
                                <span className="text-primary font-mono">ʕ◔ϖ◔ʔ</span>
                                Go Book & Beyond
                            </Link>
                            <label htmlFor="nav-drawer" className="btn btn-ghost btn-sm btn-circle">✕</label>
                        </div>

                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-xs uppercase tracking-wider text-base-content/70">Chapters</span>
                            <span className="text-[0.65rem] text-base-content/50">{chapters.filter(c => /^Chapter \d+:/.test(c.title)).length} chapters</span>
                        </div>
                        <label className="input input-sm input-bordered flex items-center gap-2 w-full mb-3">
                            <svg className="h-4 w-4 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                            </svg>
                            <input
                                type="text"
                                className="grow bg-transparent text-xs outline-none"
                                placeholder="Filter chapters…"
                                value={drawerQuery}
                                onChange={(e) => setDrawerQuery(e.target.value)}
                            />
                        </label>

                        <ul className="space-y-0.5 overflow-y-auto">
                            {filteredDrawer.map((ch) => {
                                const isActive = ch.slug === currentSlug
                                const first = ch.sections[0]
                                return (
                                    <li key={ch.slug}>
                                        <Link
                                            to={first ? `/chapters/${ch.slug}/${first.slug}` : `/chapters/${ch.slug}`}
                                            onClick={() => {
                                                const drawer = document.getElementById('nav-drawer') as HTMLInputElement
                                                if (drawer) drawer.checked = false
                                            }}
                                            className={`flex items-center gap-2 rounded-lg px-2 py-2 text-xs transition-all border ${
                                                isActive
                                                    ? 'bg-base-200/80 border-primary/60'
                                                    : 'border-transparent hover:bg-base-200/60'
                                            }`}
                                        >
                                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isActive ? 'bg-primary' : 'bg-base-300'}`} />
                                            <span className="truncate text-base-content">{ch.title}</span>
                                            <span className="ml-auto text-[0.6rem] text-base-content/40 shrink-0">
                                                {ch.sections.length}§
                                            </span>
                                        </Link>
                                    </li>
                                )
                            })}
                            {drawerQuery && filteredDrawer.length === 0 && (
                                <li className="text-xs text-base-content/60 px-2 py-3">No chapters match.</li>
                            )}
                        </ul>
                    </aside>
                </div>
            </div>
        </>
    )
}
