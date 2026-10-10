import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router'
import { CommandPaletteProvider } from '@/components/CommandPalette'
import { TranslationProvider } from '@/lib/translation/TranslationContext'
import TranslationSettingsModal from '@/components/TranslationSettingsModal'
import { getAllChapters, type ChapterWithSections } from '@/lib/chapters'

const Home = lazy(() => import('@/pages/Home'))
const ChapterList = lazy(() => import('@/pages/ChapterList'))
const Chapter = lazy(() => import('@/pages/Chapter'))

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
		<TranslationProvider>
			<CommandPaletteProvider chapters={chapters}>
				<Suspense fallback={<LoadingFallback />}>
					<Routes>
						<Route path="/" element={<Home />} />
						<Route path="/chapters" element={<ChapterList />} />
						<Route path="/chapters/:slug" element={<ChapterRedirect />} />
						<Route path="/chapters/:slug/:section" element={<Chapter />} />
					</Routes>
				</Suspense>
				<TranslationSettingsModal />
			</CommandPaletteProvider>
		</TranslationProvider>
	)
}

export default App
