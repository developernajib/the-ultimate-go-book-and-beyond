import { Link } from 'react-router-dom'
import type { Chapter } from '@/lib/chapters'

interface ChapterNavProps {
    currentSlug: string
    chapters: Chapter[]
}

export default function ChapterNav({ currentSlug, chapters }: ChapterNavProps) {
    const idx = chapters.findIndex((c) => c.slug === currentSlug)
    const prev = idx > 0 ? chapters[idx - 1] : null
    const next = idx < chapters.length - 1 ? chapters[idx + 1] : null

    return (
        <nav className="mt-12 border-t border-base-300/70 pt-6">
            <div className="grid gap-4 md:grid-cols-2">
                {prev ? (
                    <Link
                        to={`/chapters/${prev.slug}`}
                        className="group flex items-center gap-3 rounded-xl border border-base-300/60 bg-base-100/10 px-4 py-3 text-left shadow-sm transition-all duration-150 hover:-translate-x-[2px] hover:border-primary/70 hover:shadow-[0_4px_16px_rgba(0,0,0,0.15)]"
                    >
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-base-300/70 text-base-content/80 shrink-0">
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                        </span>
                        <div className="min-w-0">
                            <div className="text-xs text-base-content/60">Previous</div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm font-medium">
                                <span className="badge badge-xs badge-neutral shrink-0">{prev.number}</span>
                                <span className="line-clamp-2">{prev.title}</span>
                            </div>
                        </div>
                    </Link>
                ) : (
                    <div className="hidden md:block" />
                )}

                {next ? (
                    <Link
                        to={`/chapters/${next.slug}`}
                        className="group flex items-center justify-end gap-3 rounded-xl border border-base-300/60 bg-base-100/10 px-4 py-3 text-right shadow-sm transition-all duration-150 hover:translate-x-[2px] hover:border-primary/70 hover:shadow-[0_4px_16px_rgba(0,0,0,0.15)]"
                    >
                        <div className="min-w-0">
                            <div className="text-xs text-base-content/60">Next</div>
                            <div className="mt-1 flex flex-wrap items-center justify-end gap-2 text-sm font-medium">
                                <span className="line-clamp-2">{next.title}</span>
                                <span className="badge badge-xs badge-primary shrink-0">{next.number}</span>
                            </div>
                        </div>
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-base-300/70 text-base-content/80 shrink-0">
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </span>
                    </Link>
                ) : (
                    <div className="hidden md:block" />
                )}
            </div>
        </nav>
    )
}
