import { useEffect, useState } from 'react'

interface ReadingProgressProps {
	scrollContainerId?: string
	/** Bump to reset progress on navigation */
	resetKey?: string
}

export default function ReadingProgress({
	scrollContainerId = 'main-scroll',
	resetKey,
}: ReadingProgressProps) {
	const [progress, setProgress] = useState(0)

	useEffect(() => {
		setProgress(0)

		const scroller = document.getElementById(scrollContainerId)
		if (!scroller) return

		let ticking = false

		const updateProgress = () => {
			const scrollTop = scroller.scrollTop
			const scrollable = scroller.scrollHeight - scroller.clientHeight
			if (scrollable <= 0) {
				setProgress(0)
				return
			}
			const ratio = scrollTop / scrollable
			setProgress(Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0)
		}

		const handleScroll = () => {
			if (!ticking) {
				requestAnimationFrame(() => {
					updateProgress()
					ticking = false
				})
				ticking = true
			}
		}

		// Content renders async, measure after it lands
		const timer = setTimeout(updateProgress, 100)
		scroller.addEventListener('scroll', handleScroll, { passive: true })
		window.addEventListener('resize', updateProgress)

		return () => {
			clearTimeout(timer)
			scroller.removeEventListener('scroll', handleScroll)
			window.removeEventListener('resize', updateProgress)
		}
	}, [scrollContainerId, resetKey])

	return (
		<div className="h-0.5 w-full bg-base-300/40">
			<div
				className="h-full bg-primary transition-[width] duration-150 ease-out"
				style={{ width: `${progress * 100}%` }}
			/>
		</div>
	)
}
