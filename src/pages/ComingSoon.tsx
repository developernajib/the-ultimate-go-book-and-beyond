import { Link } from 'react-router-dom'
import GopherIcon from '@/components/GopherIcon'

export default function ComingSoon() {
    return (
        <div className="min-h-screen bg-base-200 flex flex-col items-center justify-center px-4 py-16">
            <div className="max-w-lg w-full text-center space-y-8">
                <div className="flex justify-center">
                    <div className="rounded-full border border-primary/20 bg-primary/10 p-6 animate-pulse">
                        <GopherIcon className="h-16 w-16 text-primary" />
                    </div>
                </div>

                <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                        Work in Progress
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-bold">
                        The full book is{' '}
                        <span className="text-primary">coming soon</span>
                    </h1>
                    <p className="text-base-content/60 text-base leading-relaxed">
                        The complete edition is still being written. In the meantime, enjoy the
                        free preview covering <strong className="text-base-content">Part I: Go Mastery</strong> and{' '}
                        <strong className="text-base-content">Part II: Concurrency</strong> — 16 full chapters.
                    </p>
                </div>

                <div className="rounded-xl border border-base-300/50 bg-base-100/20 px-6 py-5 text-left space-y-3">
                    <p className="text-sm font-semibold text-base-content/70 uppercase tracking-wider">Already available in the preview</p>
                    <ul className="space-y-2 text-sm text-base-content/80">
                        <li className="flex items-center gap-2">
                            <span className="text-success">✓</span> Part I: Go Mastery — 10 chapters
                        </li>
                        <li className="flex items-center gap-2">
                            <span className="text-success">✓</span> Part II: Concurrency — 6 chapters
                        </li>
                        <li className="flex items-center gap-2">
                            <span className="text-success">✓</span> Front Matter and Table of Contents
                        </li>
                    </ul>
                </div>

                <div className="flex flex-wrap gap-3 justify-center">
                    <Link to="/" className="btn btn-primary btn-md">
                        Read Free Preview
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                    </Link>
                    <Link to="/chapters" className="btn btn-ghost btn-md border border-base-300/60">
                        Browse Chapters
                    </Link>
                </div>
            </div>
        </div>
    )
}
