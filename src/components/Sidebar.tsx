import { useMemo, useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { ChapterWithSections } from '@/lib/chapters'

interface SidebarProps {
    chapters: ChapterWithSections[]
    currentSlug?: string
    currentSectionSlug?: string
}

export default function Sidebar({ chapters, currentSlug, currentSectionSlug }: SidebarProps) {
    const [query, setQuery] = useState('')
    const activeSectionRef = useRef<HTMLAnchorElement>(null)
    const isFirstRender = useRef(true)
    // Track which chapters are expanded (default: current chapter open)
    const [expanded, setExpanded] = useState<Set<string>>(
        new Set(currentSlug ? [currentSlug] : []),
    )

    // Auto-expand current chapter
    useEffect(() => {
        if (currentSlug) {
            setExpanded((prev) => new Set([...prev, currentSlug]))
        }
    }, [currentSlug])

    // Scroll active section into view
    useEffect(() => {
        const timer = setTimeout(() => {
            if (!activeSectionRef.current) return
            // On first render (page load/refresh), center the active item
            // On subsequent navigations, use nearest to avoid jarring jumps
            const block = isFirstRender.current ? 'center' : 'nearest'
            activeSectionRef.current.scrollIntoView({ block, behavior: isFirstRender.current ? 'auto' : 'smooth' })
            isFirstRender.current = false
        }, 50)
        return () => clearTimeout(timer)
    }, [currentSlug, currentSectionSlug])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return chapters

        return chapters
            .map((ch) => {
                const chMatch = `${ch.number} ${ch.title} ${ch.partLabel}`.toLowerCase().includes(q)
                const matchedSections = ch.sections.filter((s) =>
                    s.title.toLowerCase().includes(q),
                )
                if (chMatch || matchedSections.length > 0) {
                    return { ...ch, sections: chMatch ? ch.sections : matchedSections }
                }
                return null
            })
            .filter(Boolean) as ChapterWithSections[]
    }, [chapters, query])

    // Group by part
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
            if (next.has(slug)) next.delete(slug)
            else next.add(slug)
            return next
        })
    }

    return (
        <aside className="hidden h-full w-72 xl:w-80 overflow-y-auto border-r border-base-300/60 bg-base-100 lg:block shrink-0">
            <div className="p-4">
                <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-base-content/70">
                        Contents
                    </span>
                    <span className="text-[0.65rem] text-base-content/50">
                        {query
                            ? `${filtered.length} / ${chapters.filter(c => /^Chapter \d+:/.test(c.title)).length}`
                            : chapters.filter(c => /^Chapter \d+:/.test(c.title)).length
                        } chapters
                    </span>
                </div>

                {/* Search */}
                <label className="input input-sm input-bordered flex items-center gap-2 w-full mb-4">
                    <svg className="h-3.5 w-3.5 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                        type="text"
                        className="grow bg-transparent text-xs outline-none"
                        placeholder="Filter chapters & sections…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => setQuery('')}
                            className="text-base-content/40 hover:text-base-content/70 transition-colors"
                        >
                            ✕
                        </button>
                    )}
                </label>

                {/* Chapters grouped by part */}
                {Array.from(grouped.entries()).map(([partLabel, chs]) => (
                    <div key={partLabel} className="mb-5">
                        <div className="mb-1.5 px-1 text-[0.65rem] font-semibold uppercase tracking-wider text-base-content/40">
                            {partLabel}
                        </div>
                        <ul className="space-y-0.5">
                            {chs.map((ch) => {
                                const isCurrentChapter = ch.slug === currentSlug
                                const isOpen = expanded.has(ch.slug) || !!query

                                return (
                                    <li key={ch.slug}>
                                        {/* Chapter row */}
                                        <button
                                            type="button"
                                            onClick={() => toggleChapter(ch.slug)}
                                            className={`w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-all duration-150 border text-left ${
                                                isCurrentChapter
                                                    ? 'bg-base-200/80 border-primary/40'
                                                    : 'border-transparent hover:bg-base-200/50 hover:border-base-300/60'
                                            }`}
                                        >
                                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isCurrentChapter ? 'bg-primary' : 'bg-base-300'}`} />
                                            <span className="flex-1 truncate text-sm font-medium text-base-content text-left">
                                                {ch.title}
                                            </span>
                                            {/* Expand indicator */}
                                            <span className={`shrink-0 text-base-content/40 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>
                                                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                            </span>
                                        </button>

                                        {/* Section list */}
                                        {isOpen && (
                                            <ul className="mt-0.5 ml-3 pl-3 border-l border-base-300/40 space-y-0.5 pb-1">
                                                {ch.sections.map((sec) => {
                                                    const isActiveSection =
                                                        isCurrentChapter && sec.slug === currentSectionSlug
                                                    return (
                                                        <li key={sec.slug}>
                                                            <Link
                                                                ref={isActiveSection ? activeSectionRef : undefined}
                                                                to={`/chapters/${ch.slug}/${sec.slug}`}
                                                                onClick={() => { const s = document.getElementById('main-scroll'); if (s) s.scrollTop = 0 }}
                                                                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-all duration-150 ${
                                                                    isActiveSection
                                                                        ? 'bg-primary/10 text-primary font-medium border-l-2 border-primary -ml-px pl-[7px]'
                                                                        : 'text-base-content/70 hover:text-base-content hover:bg-base-200/60'
                                                                }`}
                                                            >
                                                                <span className={`h-1 w-1 rounded-full shrink-0 ${isActiveSection ? 'bg-primary' : 'bg-base-300'}`} />
                                                                <span className="truncate">{sec.title}</span>
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
                    <p className="text-xs text-base-content/60 px-1">No results.</p>
                )}
            </div>
        </aside>
    )
}
