import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Navbar from '@/components/Navbar'
import { getAllChapters, type ChapterWithSections } from '@/lib/chapters'

/** Extract the chapter label (e.g. "Chapter 1:", "Appendix A:") and remaining title */
function splitChapterTitle(title: string): { label: string; rest: string } {
    const match = title.match(/^(Chapter\s+[\w.]+[A-Z]*:|Appendix\s+\w+:|Capstone\s+Project\s+\d+:|System\s+Design:)\s*(.*)$/)
    if (match) return { label: match[1], rest: match[2] }
    return { label: '', rest: title }
}

export default function ChapterList() {
    const [chapters, setChapters] = useState<ChapterWithSections[]>([])
    const [query, setQuery] = useState('')

    useEffect(() => {
        getAllChapters().then(setChapters)
    }, [])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return chapters
        return chapters.filter((c) =>
            `${c.number} ${c.title} ${c.partLabel}`.toLowerCase().includes(q),
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

    return (
        <div className="min-h-screen bg-base-200 w-full">
            <Navbar chapters={chapters} />

            <main className="px-4 sm:px-6 lg:px-10 py-8 lg:py-12">
                <div className="mx-auto w-full max-w-4xl">
                    <h1 className="text-2xl sm:text-3xl font-bold text-base-content mb-2">
                        All Chapters
                    </h1>
                    <p className="text-base-content/60 text-sm mb-6">
                        {chapters.filter(c => /^Chapter \d+/.test(c.title) && !/part-\d+[b-z]-/.test(c.part)).length} chapters
                        {' · '}
                        {chapters.filter(c => /^Chapter \d+/.test(c.title) && /part-\d+[b-z]-/.test(c.part)).length} sub-chapters
                        {' · '}
                        {new Set(chapters.map(c => c.part)).size} parts
                    </p>

                    {/* Search */}
                    <label className="input input-bordered flex items-center gap-2 w-full max-w-md mb-8">
                        <svg className="h-4 w-4 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        <input
                            type="text"
                            className="grow bg-transparent outline-none"
                            placeholder="Filter chapters..."
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery('')}
                                className="text-base-content/40 hover:text-base-content/70"
                            >
                                ✕
                            </button>
                        )}
                    </label>

                    {/* Chapter list grouped by part */}
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
                                                        <span className="font-semibold text-primary">{label}</span>
                                                        {' '}{rest}
                                                    </>
                                                ) : (
                                                    <span className="font-medium">{rest}</span>
                                                )}
                                            </span>
                                            <span className="text-xs text-base-content/40 shrink-0">
                                                {ch.sections.length} {ch.sections.length === 1 ? 'section' : 'sections'}
                                            </span>
                                        </Link>
                                    )
                                })}
                            </div>
                        </div>
                    ))}

                    {query && filtered.length === 0 && (
                        <p className="text-base-content/60 text-sm">No chapters match your search.</p>
                    )}
                </div>
            </main>
        </div>
    )
}
