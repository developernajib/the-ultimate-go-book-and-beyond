import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import Navbar from '@/components/Navbar'
import Sidebar from '@/components/Sidebar'
import ChapterRenderer from '@/components/ChapterRenderer'
import SectionNav from '@/components/SectionNav'
import ReadingProgress from '@/components/ReadingProgress'
import ContributeCallout from '@/components/ContributeCallout'
import {
    getAllChapters,
    getSectionContent,
    getAllSectionsFlat,
    isPreviewChapter,
    type ChapterWithSections,
    type Section,
} from '@/lib/chapters'
import { parseMarkdown } from '@/lib/markdown'
import PreviewEnded from '@/pages/PreviewEnded'

export default function ChapterPage() {
    const { slug, section: sectionSlug } = useParams<{ slug: string; section: string }>()
    const navigate = useNavigate()

    const [chapters, setChapters] = useState<ChapterWithSections[]>([])
    const [sidebarOpen, setSidebarOpen] = useState(false)
    const [currentChapter, setCurrentChapter] = useState<ChapterWithSections | null>(null)
    const [currentSection, setCurrentSection] = useState<Section | null>(null)
    const [html, setHtml] = useState('')
    const [contentLoading, setContentLoading] = useState(true)
    const [initialLoading, setInitialLoading] = useState(true)
    const [flatSections, setFlatSections] = useState<
        Awaited<ReturnType<typeof getAllSectionsFlat>>
    >([])

    const prevKey = useRef('')

    // Reset scroll on mount before browser can restore position
    useEffect(() => {
        const scroller = document.getElementById('main-scroll')
        if (scroller) scroller.scrollTop = 0
        window.scrollTo(0, 0)
    }, [])

    useEffect(() => {
        Promise.all([getAllChapters(), getAllSectionsFlat()]).then(([all, flat]) => {
            setChapters(all)
            setFlatSections(flat)
            setInitialLoading(false)
        })
    }, [])

    useEffect(() => {
        if (!slug || !sectionSlug || flatSections.length === 0) return

        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement
            if (
                target.tagName === 'INPUT' ||
                target.tagName === 'TEXTAREA' ||
                target.isContentEditable ||
                e.ctrlKey || e.metaKey || e.altKey
            ) return

            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return

            const idx = flatSections.findIndex(
                (s) => s.chapterSlug === slug && s.slug === sectionSlug,
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

    useEffect(() => {
        if (!slug || !sectionSlug || chapters.length === 0) return
        const key = `${slug}/${sectionSlug}`
        if (prevKey.current === key) return
        prevKey.current = key

        // Non-preview chapter: show gate immediately, no fetch
        if (!isPreviewChapter(slug)) {
            const chapter = chapters.find((c) => c.slug === slug)
            setCurrentChapter(chapter || null)
            setCurrentSection(null)
            setContentLoading(false)
            return
        }

        setContentLoading(true)
        const scroller = document.getElementById('main-scroll')
        if (scroller) scroller.scrollTop = 0

        const chapter = chapters.find((c) => c.slug === slug)
        if (!chapter) { navigate('/', { replace: true }); return }
        setCurrentChapter(chapter)

        const sec = chapter.sections.find((s) => s.slug === sectionSlug)
        if (!sec) {
            const first = chapter.sections[0]
            if (first) navigate(`/chapters/${slug}/${first.slug}`, { replace: true })
            return
        }
        setCurrentSection(sec)

        getSectionContent(slug, sectionSlug).then((raw) => {
            const { html: rendered } = parseMarkdown(raw)
            setHtml(rendered)
            setContentLoading(false)
        })
    }, [slug, sectionSlug, chapters, navigate])

    if (initialLoading) {
        return (
            <div className="min-h-screen bg-base-200 flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <span className="loading loading-spinner loading-lg text-primary" />
                    <p className="text-base-content/60 text-sm">Loading…</p>
                </div>
            </div>
        )
    }

    if (slug && !isPreviewChapter(slug)) {
        return (
            <div className="flex flex-col h-screen overflow-hidden bg-base-200 w-full">
                <div className="shrink-0 z-30">
                    <Navbar chapters={chapters} currentSlug={slug} />
                </div>
                <div className="flex flex-1 min-h-0 w-full">
                    <Sidebar chapters={chapters} currentSlug={slug} currentSectionSlug={sectionSlug} />
                    <div className="flex-1 min-w-0 overflow-y-auto">
                        <PreviewEnded />
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-base-200 w-full">
            <div className="shrink-0 z-30">
                <Navbar chapters={chapters} currentSlug={slug} currentSection={currentSection?.title} onOpenSidebar={() => setSidebarOpen(true)} />
                <ReadingProgress scrollContainerId="main-scroll" resetKey={`${slug}/${sectionSlug}`} />
            </div>

            <div className="flex flex-1 min-h-0 w-full">
                <Sidebar chapters={chapters} currentSlug={slug} currentSectionSlug={sectionSlug} mobileOpen={sidebarOpen} setMobileOpen={setSidebarOpen} />

                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    <div id="main-scroll" className="flex-1 min-h-0 overflow-y-auto">
                        <main className="px-4 sm:px-6 lg:px-10 py-6 lg:py-10">
                            <div className="mx-auto w-full max-w-4xl space-y-4">
                                {/* Breadcrumbs */}
                                <nav className="text-xs sm:text-sm text-base-content/70">
                                    <ol className="flex flex-wrap items-center gap-y-1">
                                        <li className="flex items-center">
                                            <Link to="/" className="hover:text-base-content transition-colors">Home</Link>
                                            <span className="mx-1.5 text-base-content/30">/</span>
                                        </li>
                                        {currentChapter && (
                                            <>
                                                <li className="flex items-center">
                                                    <span className="text-base-content/60 truncate max-w-[160px]">
                                                        {currentChapter.partLabel}
                                                    </span>
                                                    <span className="mx-1.5 text-base-content/30">/</span>
                                                </li>
                                                <li className="flex items-center">
                                                    <span className="text-base-content/70 font-medium truncate max-w-[180px]">
                                                        {currentChapter.title}
                                                    </span>
                                                    {currentSection && currentSection.title !== 'Introduction' && (
                                                        <>
                                                            <span className="mx-1.5 text-base-content/30">/</span>
                                                            <span className="text-base-content/80 font-medium truncate max-w-[140px]">
                                                                {currentSection.title}
                                                            </span>
                                                        </>
                                                    )}
                                                </li>
                                            </>
                                        )}
                                    </ol>
                                </nav>

                                {/* Chapter + section header */}
                                {currentChapter && (
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="badge badge-neutral badge-sm px-3 py-3">{currentChapter.partLabel}</span>
                                        {currentSection && currentChapter.sections.length > 1 && (
                                            <span className="badge badge-neutral badge-sm px-3 py-3">
                                                Section {currentSection.index + 1} / {currentChapter.sections.length}
                                            </span>
                                        )}
                                        <span className="badge badge-primary badge-sm px-3 py-3">Free Preview</span>
                                    </div>
                                )}

                                {/* Content */}
                                {contentLoading ? (
                                    <div className="flex items-center justify-center py-20">
                                        <span className="loading loading-spinner loading-md text-primary" />
                                    </div>
                                ) : (
                                    <article id="chapter-content">
                                        <ChapterRenderer html={html} />
                                    </article>
                                )}
                            </div>
                        </main>
                    </div>

                    {!contentLoading && slug && (
                        <div className="shrink-0 px-4 sm:px-6 lg:px-10">
                            <div className="mx-auto w-full max-w-4xl">
                                <ContributeCallout
                                    chapterTitle={currentChapter?.title}
                                    sectionTitle={currentSection?.title}
                                />
                            </div>
                        </div>
                    )}

                    {flatSections.length > 0 && slug && sectionSlug && (
                        <div className="shrink-0 px-4 sm:px-6 lg:px-10 py-1.5">
                            <div className="mx-auto w-full max-w-4xl rounded-xl border border-base-300/60 bg-base-200/95 backdrop-blur-sm px-2 py-1">
                                <SectionNav
                                    flatSections={flatSections}
                                    currentChapterSlug={slug}
                                    currentSectionSlug={sectionSlug}
                                />
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
