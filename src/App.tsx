import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { CommandPaletteProvider } from '@/components/CommandPalette'
import { getAllChapters, isPreviewChapter, type ChapterWithSections } from '@/lib/chapters'
import Home from '@/pages/Home'

const ChapterList = lazy(() => import('@/pages/ChapterList'))
const Chapter = lazy(() => import('@/pages/Chapter'))
const PreviewEnded = lazy(() => import('@/pages/PreviewEnded'))
const ComingSoon = lazy(() => import('@/pages/ComingSoon'))

function LoadingFallback() {
    return (
        <div className="min-h-screen bg-base-200 flex items-center justify-center">
            <div className="flex flex-col items-center gap-4">
                <span className="loading loading-spinner loading-lg text-primary" />
                <p className="text-base-content/60 text-sm">Loading…</p>
            </div>
        </div>
    )
}

function ChapterRedirect() {
    const { slug } = useParams<{ slug: string }>()
    const [target, setTarget] = useState<string | null>(null)

    useEffect(() => {
        if (!slug) return
        if (!isPreviewChapter(slug)) {
            setTarget('/preview-ended')
            return
        }
        getAllChapters().then((chapters) => {
            const ch = chapters.find((c) => c.slug === slug)
            const first = ch?.sections[0]
            if (ch && first) setTarget(`/chapters/${slug}/${first.slug}`)
            else setTarget('/')
        })
    }, [slug])

    if (!target) return <LoadingFallback />
    return <Navigate to={target} replace />
}

function App() {
    const [chapters, setChapters] = useState<ChapterWithSections[]>([])

    useEffect(() => {
        getAllChapters().then(setChapters)
    }, [])

    return (
        <CommandPaletteProvider chapters={chapters}>
            <Suspense fallback={<LoadingFallback />}>
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/chapters" element={<ChapterList />} />
                    <Route path="/chapters/:slug" element={<ChapterRedirect />} />
                    <Route path="/chapters/:slug/:section" element={<Chapter />} />
                    <Route path="/preview-ended" element={<PreviewEnded />} />
                    <Route path="/coming-soon" element={<ComingSoon />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </Suspense>
        </CommandPaletteProvider>
    )
}

export default App
