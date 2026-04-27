import { useEffect, useState } from 'react'

interface ContributeCalloutProps {
    chapterTitle?: string
    sectionTitle?: string
}

export default function ContributeCallout({ chapterTitle, sectionTitle }: ContributeCalloutProps) {
    const [open, setOpen] = useState(() => {
        const stored = localStorage.getItem('contribute-callout')
        return stored === null ? true : stored === 'open'
    })

    // Auto-close only on first ever visit (no stored value yet)
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

    const label = sectionTitle && sectionTitle !== 'Introduction'
        ? `${chapterTitle}: ${sectionTitle}`
        : chapterTitle

    const issueTitle = label
        ? `Feedback for ${label}`
        : 'Feedback for Go Book'

    const issueUrl = `https://github.com/developernajib/the-ultimate-go-book-and-beyond/issues/new?title=${encodeURIComponent(issueTitle)}`

    if (!open) {
        return (
            <button
                onClick={handleOpen}
                title="Give feedback"
                className="fixed bottom-6 right-6 z-50 flex h-11 w-11 items-center justify-center rounded-full border border-base-300/60 bg-base-200 shadow-lg transition-all hover:border-primary/60 hover:bg-base-200 hover:shadow-primary/10"
            >
                <svg className="h-5 w-5 text-base-content/70" viewBox="0 0 24 24" fill="none">
                    <path d="M12 6V14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="12" cy="17" r="1" fill="currentColor" />
                    <path
                        d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4Z"
                        stroke="currentColor"
                        strokeWidth="1.4"
                    />
                </svg>
            </button>
        )
    }

    return (
        <div className="flex flex-col gap-3 rounded-xl border border-base-300/60 bg-base-100/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3 min-w-0">
                <div className="mt-0.5 h-6 w-6 flex-shrink-0 rounded-full bg-base-300/70 flex items-center justify-center">
                    <svg className="h-3.5 w-3.5 text-base-content/80" viewBox="0 0 24 24" fill="none">
                        <path d="M12 6V14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
                        Found a typo, rough edge, or missing explanation? Open an issue or propose an
                        improvement on GitHub.
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
                    href="https://github.com/developernajib/the-ultimate-go-book-and-beyond"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex flex-1 sm:flex-none sm:w-32 items-center justify-center rounded-lg border border-base-content/20 bg-base-100/10 px-3 py-1.5 text-xs font-medium text-base-content/70 transition-colors hover:border-base-content/40 hover:text-base-content"
                >
                    View repository
                </a>
                <button
                    onClick={handleClose}
                    title="Dismiss"
                    className="flex h-[2.125rem] w-8 items-center justify-center rounded-lg border border-base-content/20 bg-base-100/10 text-base-content/70 transition-colors hover:border-base-content/40 hover:text-base-content shrink-0"
                >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>
    )
}
