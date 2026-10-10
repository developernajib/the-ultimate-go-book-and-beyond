import { useEffect, useState } from 'react'
import Tooltip from './Tooltip'
import { GITHUB_REPO_URL, getGitHubIssueUrl } from '@/lib/constants'

interface ContributeCalloutProps {
	chapterTitle?: string
	sectionTitle?: string
}

export default function ContributeCallout({ chapterTitle, sectionTitle }: ContributeCalloutProps) {
	const [open, setOpen] = useState(() => {
		const stored = localStorage.getItem('contribute-callout')
		return stored === null ? true : stored === 'open'
	})

	// First visit only: auto-dismiss after 20s, then never again
	useEffect(() => {
		const stored = localStorage.getItem('contribute-callout')
		if (stored !== null) return
		const timer = setTimeout(() => {
			setOpen(false)
			localStorage.setItem('contribute-callout', 'closed')
		}, 20000)
		return () => clearTimeout(timer)
	}, [])

	const handleClose = () => {
		setOpen(false)
		localStorage.setItem('contribute-callout', 'closed')
	}

	const handleOpen = () => {
		setOpen(true)
		localStorage.setItem('contribute-callout', 'open')
	}

	const label =
		sectionTitle && sectionTitle !== 'Introduction'
			? `${chapterTitle}: ${sectionTitle}`
			: chapterTitle

	const issueTitle = label ? `Feedback for ${label}` : 'Feedback for Go Book'

	const issueUrl = getGitHubIssueUrl(issueTitle)

	if (!open) {
		return (
			<div className="relative h-0">
				<div className="absolute right-0 bottom-2 z-20">
					<Tooltip content="Give feedback" position="top-or-right">
						<button
							onClick={handleOpen}
							aria-label="Give feedback"
							className="flex h-11 w-11 items-center justify-center rounded-full border border-base-300/60 bg-base-200 shadow-md transition-all hover:border-primary/60 hover:bg-base-200 hover:shadow-primary/10 cursor-pointer"
						>
							<svg
								aria-hidden="true"
								className="h-5 w-5 text-base-content/70"
								viewBox="0 0 24 24"
								fill="none"
							>
								<path
									d="M12 6V14"
									stroke="currentColor"
									strokeWidth="1.8"
									strokeLinecap="round"
								/>
								<circle cx="12" cy="17" r="1" fill="currentColor" />
								<path
									d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4Z"
									stroke="currentColor"
									strokeWidth="1.4"
								/>
							</svg>
						</button>
					</Tooltip>
				</div>
			</div>
		)
	}

	return (
		<div className="mb-2 flex flex-col gap-3 rounded-xl border border-base-300/60 bg-base-200/95 backdrop-blur-sm px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between shadow-lg [html[data-theme=gobook]_&]:border-primary/30">
			<div className="flex items-start gap-3 min-w-0">
				<div className="mt-0.5 h-6 w-6 flex-shrink-0 rounded-full bg-base-300/70 flex items-center justify-center">
					<svg
						aria-hidden="true"
						className="h-3.5 w-3.5 text-base-content/80"
						viewBox="0 0 24 24"
						fill="none"
					>
						<path
							d="M12 6V14"
							stroke="currentColor"
							strokeWidth="1.8"
							strokeLinecap="round"
						/>
						<circle cx="12" cy="17" r="1" fill="currentColor" />
						<path
							d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4Z"
							stroke="currentColor"
							strokeWidth="1.4"
						/>
					</svg>
				</div>
				<div>
					<p className="font-medium text-base-content">Help make this chapter better.</p>
					<p className="text-base-content/70">
						Found a typo, rough edge, or missing explanation? Open an issue or propose
						an improvement on GitHub.
					</p>
				</div>
			</div>
			<div className="flex items-center gap-2 shrink-0 sm:justify-end">
				<a
					href={issueUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex flex-1 sm:flex-none sm:w-32 items-center justify-center rounded-lg border border-primary/70 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
				>
					Open issue
				</a>
				<a
					href={GITHUB_REPO_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="flex flex-1 sm:flex-none sm:w-32 items-center justify-center rounded-lg border border-base-content/20 bg-base-100/10 px-3 py-1.5 text-xs font-medium text-base-content/70 transition-colors hover:border-base-content/40 hover:text-base-content"
				>
					View repository
				</a>
				<Tooltip content="Dismiss" position="top">
					<button
						onClick={handleClose}
						aria-label="Dismiss"
						className="flex h-[2.125rem] w-8 items-center justify-center rounded-lg border border-base-content/20 bg-base-100/10 text-base-content/70 transition-colors hover:border-base-content/40 hover:text-base-content shrink-0"
					>
						<svg
							aria-hidden="true"
							className="h-3.5 w-3.5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
						>
							<path d="M18 6L6 18M6 6l12 12" />
						</svg>
					</button>
				</Tooltip>
			</div>
		</div>
	)
}
