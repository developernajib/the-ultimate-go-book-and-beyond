import { Link } from 'react-router-dom'
import type { getAllSectionsFlat } from '@/lib/chapters'

type FlatSection = Awaited<ReturnType<typeof getAllSectionsFlat>>[number]

interface SectionNavProps {
    flatSections: FlatSection[]
    currentChapterSlug: string
    currentSectionSlug: string
}

function scrollToTop() {
    const scroller = document.getElementById('main-scroll')
    if (scroller) scroller.scrollTop = 0
}

export default function SectionNav({ flatSections, currentChapterSlug, currentSectionSlug }: SectionNavProps) {
    const idx = flatSections.findIndex(
        (s) => s.chapterSlug === currentChapterSlug && s.slug === currentSectionSlug,
    )
    const prev = idx > 0 ? flatSections[idx - 1] : null
    const next = idx < flatSections.length - 1 ? flatSections[idx + 1] : null

    const isNewChapter = (s: FlatSection) => s.chapterSlug !== currentChapterSlug

    return (
        <nav className="py-1">
            <div className="grid gap-2 md:grid-cols-2">
                {prev ? (
                    <Link
                        to={`/chapters/${prev.chapterSlug}/${prev.slug}`}
                        onClick={scrollToTop}
                        title="← Arrow key"
                        className="group flex items-center gap-2 rounded-lg border border-base-300/60 bg-base-100/10 px-3 py-1.5 text-left transition-all duration-150 hover:-translate-x-[1px] hover:border-primary/70"
                    >
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-base-300/70 shrink-0">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                            </svg>
                        </span>
                        <div className="min-w-0">
                            <div className="text-[0.65rem] text-base-content/50 leading-none">
                                {isNewChapter(prev) ? `← Ch ${prev.chapterNumber}` : 'Previous'}
                            </div>
                            <div className="text-xs font-medium line-clamp-1 text-base-content mt-0.5">
                                {prev.title}
                            </div>
                        </div>
                    </Link>
                ) : (
                    <div className="hidden md:block" />
                )}

                {next ? (
                    <Link
                        to={`/chapters/${next.chapterSlug}/${next.slug}`}
                        onClick={scrollToTop}
                        title="→ Arrow key"
                        className="group flex items-center justify-end gap-2 rounded-lg border border-base-300/60 bg-base-100/10 px-3 py-1.5 text-right transition-all duration-150 hover:translate-x-[1px] hover:border-primary/70"
                    >
                        <div className="min-w-0">
                            <div className="text-[0.65rem] text-base-content/50 leading-none">
                                {isNewChapter(next) ? `Ch ${next.chapterNumber} →` : 'Next'}
                            </div>
                            <div className="text-xs font-medium line-clamp-1 text-base-content mt-0.5">
                                {next.title}
                            </div>
                        </div>
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-base-300/70 shrink-0">
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
