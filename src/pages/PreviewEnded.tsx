import { Link } from 'react-router-dom'
import GopherIcon from '@/components/GopherIcon'

const BUY_URL = import.meta.env.VITE_BUY_URL as string

const FULL_BOOK_HIGHLIGHTS = [
    { icon: '🏗️', label: 'Part III: Production Ready & High Performance' },
    { icon: '🌐', label: 'Part IV–IX: REST, gRPC, Microservices, Fullstack' },
    { icon: '🗄️', label: 'Part V: Data Layer, Databases & Caching' },
    { icon: '📐', label: 'Part X: System Design (39 Problems)' },
    { icon: '🧩', label: 'Part XI–XII: DSA & Interview Mastery' },
    { icon: '🎓', label: 'Part XIII: Senior Engineer Mindset' },
    { icon: '☁️', label: 'Part XV: Cloud, DevOps & Networking' },
    { icon: '🔍', label: 'Part XVI: Observability & SRE' },
    { icon: '🔒', label: 'Part XVII: Security & Compliance' },
    { icon: '🤖', label: 'Part XVIII: AI Engineering & ML' },
    { icon: '⚡', label: 'Part XXII: eBPF & Linux Internals' },
    { icon: '📦', label: 'Part XIX: 15 Capstone Projects' },
]

export default function PreviewEnded() {
    return (
        <div className="min-h-screen bg-base-200 flex flex-col items-center justify-center px-4 py-16">
            <div className="max-w-2xl w-full text-center space-y-8">
                {/* Icon */}
                <div className="flex justify-center">
                    <div className="rounded-full border border-primary/20 bg-primary/10 p-6">
                        <GopherIcon className="h-16 w-16 text-primary" />
                    </div>
                </div>

                {/* Heading */}
                <div className="space-y-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-warning/30 bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
                        End of Free Preview
                    </div>
                    <h1 className="text-3xl sm:text-4xl font-bold">
                        You&apos;ve finished the{' '}
                        <span className="text-primary">free preview</span>
                    </h1>
                    <p className="text-base-content/60 text-base leading-relaxed">
                        You&apos;ve read <strong className="text-base-content">Front Matter, Part I: Go Mastery</strong> and{' '}
                        <strong className="text-base-content">Part II: Concurrency</strong>.
                        The full book continues with 20 more parts, everything you need to
                        go from Go developer to senior engineer.
                    </p>
                </div>

                {/* What's in the full book */}
                <div className="rounded-xl border border-base-300/50 bg-base-100/20 p-6 text-left">
                    <h2 className="text-sm font-semibold uppercase tracking-wider text-base-content/50 mb-4 text-center">
                        What you&apos;ll unlock
                    </h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {FULL_BOOK_HIGHLIGHTS.map((h) => (
                            <div key={h.label} className="flex items-center gap-3 text-sm text-base-content/80">
                                <span className="text-lg shrink-0">{h.icon}</span>
                                <span>{h.label}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {/* CTA */}
                <div className="flex flex-wrap gap-3 justify-center">
                    {BUY_URL && (
                        <a
                            href={BUY_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-primary btn-lg"
                        >
                            Get the Full Book
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                        </a>
                    )}
                    <Link to="/chapters" className="btn btn-ghost btn-lg border border-base-300/60">
                        Back to Chapters
                    </Link>
                </div>

                <p className="text-xs text-base-content/40">
                    Or <Link to="/" className="underline underline-offset-2 hover:text-base-content/60 transition-colors">go back home</Link>
                </p>
            </div>
        </div>
    )
}
