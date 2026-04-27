import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AnimatedTerminal from '@/components/AnimatedTerminal'
import Navbar from '@/components/Navbar'
import GoLogo from '@/components/GoLogo'
import HeroBackground from '@/components/HeroBackground'
import { getAllChapters, type ChapterWithSections } from '@/lib/chapters'

const BUY_URL = import.meta.env.VITE_BUY_URL as string

const BOOK_STATS = [
    { label: 'Chapters', value: '185+' },
    { label: 'Sub-Chapters', value: '79+' },
    { label: 'System Design', value: '39' },
    { label: 'Capstone Projects', value: '16' },
]

const PART_HIGHLIGHTS = [
    { icon: '⚙️', title: 'Go 1.26 Mastery', desc: 'Green Tea GC, Swiss Tables, iterators, generics, internals' },
    { icon: '🔀', title: 'Concurrency', desc: 'Goroutines, channels, patterns, lock-free, anti-patterns' },
    { icon: '🏗️', title: 'System Design', desc: '39 problems across X-A to X-D + distributed consensus & multi-region DR' },
    { icon: '🎯', title: 'Interview Mastery', desc: 'DSA, system design mocks, SQL, LLD, behavioral, negotiation' },
    { icon: '☁️', title: 'Cloud & Platform', desc: 'Kubernetes, Terraform, GitOps, observability, security, compliance' },
    { icon: '🤖', title: 'AI Engineering', desc: 'LLM integration, AI agents, MCP/A2A, vector DBs, RAG — mandatory track' },
]

const START_HREF = '/chapters/00-front-matter--cover/intro'

export default function Home() {
    const [chapters, setChapters] = useState<ChapterWithSections[]>([])

    useEffect(() => {
        getAllChapters().then(setChapters)
    }, [])

    return (
        <div className="min-h-screen bg-base-200 relative overflow-hidden w-full">
            <HeroBackground />

            {/* Buy banner */}
            {BUY_URL && (
                <div className="relative z-30 bg-primary/10 border-b border-primary/20 text-center py-2 px-4">
                    <p className="text-xs sm:text-sm text-base-content/80">
                        You are reading the <span className="font-semibold text-primary">free preview</span> — Part I &amp; II only.{' '}
                        <a
                            href={BUY_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                        >
                            Get the full book &rarr;
                        </a>
                    </p>
                </div>
            )}

            <div className="relative z-20">
                <Navbar chapters={chapters} />
            </div>

            <main className="relative z-10">
                <section className="hero min-h-[calc(100vh-4rem)] py-6 sm:py-10">
                    <div className="hero-content w-full max-w-6xl px-3 sm:px-4 md:px-6 lg:px-8">
                        <div className="flex w-full flex-col items-center gap-8 sm:gap-10 lg:flex-row lg:items-stretch lg:gap-16">

                            {/* Left column */}
                            <div className="flex-1 max-w-xl text-center lg:text-left px-2">
                                <div className="space-y-6 md:space-y-8">
                                    <GoLogo />

                                    <div className="space-y-3">
                                        <div className="flex flex-wrap gap-2 justify-center lg:justify-start">
                                            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                                                <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                                                Go 1.26 · Updated April 2026
                                            </div>
                                            <div className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-xs font-semibold text-warning">
                                                Free Preview — Part I &amp; II
                                            </div>
                                        </div>
                                        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold leading-tight tracking-tight">
                                            Your complete path from{' '}
                                            <span className="text-primary">Beginner to Senior Engineer</span>
                                        </h1>
                                        <p className="text-base sm:text-lg text-base-content/70 leading-relaxed">
                                            The most comprehensive Go engineering book ever written —
                                            185+ chapters covering everything from your very first
                                            line of Go to building production systems at scale.
                                            This preview includes <span className="text-primary font-medium">Part I: Go Mastery</span> and{' '}
                                            <span className="text-primary font-medium">Part II: Concurrency</span>.
                                        </p>
                                    </div>

                                    <div className="flex max-w-xl items-start gap-3 rounded-xl border border-base-300/50 bg-base-100/5 px-3 sm:px-4 py-3 text-left shadow-sm">
                                        <div className="mt-1 h-10 w-px shrink-0 bg-gradient-to-b from-primary/70 via-primary/20 to-transparent" />
                                        <div className="space-y-1 min-w-0">
                                            <p className="text-sm sm:text-base italic text-base-content/80 font-light">
                                                &ldquo;You came for the simplicity.
                                            </p>
                                            <p className="text-sm sm:text-base italic text-primary font-medium">
                                                You&apos;ll stay for the concurrency.&rdquo;
                                            </p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                                        {BOOK_STATS.map((s) => (
                                            <div key={s.label} className="rounded-lg border border-base-300/50 bg-base-100/20 px-3 py-2 text-center">
                                                <div className="text-lg font-bold text-primary">{s.value}</div>
                                                <div className="text-[0.7rem] text-base-content/60">{s.label}</div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="flex flex-wrap gap-3 justify-center lg:justify-start pt-2">
                                        <Link to={START_HREF} className="btn btn-primary btn-sm sm:btn-md">
                                            Read Free Preview
                                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                            </svg>
                                        </Link>
                                        {BUY_URL ? (
                                            <a
                                                href={BUY_URL}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="btn btn-ghost btn-sm sm:btn-md border border-primary/40 text-primary hover:bg-primary/10"
                                            >
                                                Buy Full Book
                                            </a>
                                        ) : (
                                            <Link
                                                to="/coming-soon"
                                                className="btn btn-ghost btn-sm sm:btn-md border border-base-300/60"
                                            >
                                                Buy Full Book
                                            </Link>
                                        )}
                                    </div>

                                    <p className="text-xs text-base-content/50 pt-2 flex flex-wrap items-center gap-1.5">
                                        <span>Written by</span>
                                        <button
                                            onClick={() => {
                                                navigator.clipboard.writeText('developernajib@gmail.com')
                                                const btn = document.getElementById('copy-email-toast')
                                                if (btn) {
                                                    btn.classList.remove('hidden')
                                                    setTimeout(() => btn.classList.add('hidden'), 2000)
                                                }
                                            }}
                                            className="group badge badge-primary badge-sm font-semibold cursor-pointer px-3 py-2.5 hover:scale-105 hover:shadow-md hover:shadow-primary/30 transition-all duration-200"
                                            title="Click to copy email"
                                        >
                                            <span className="group-hover:hidden">Md. Najib Islam</span>
                                            <span className="hidden group-hover:inline">developernajib@gmail.com</span>
                                        </button>
                                        <span id="copy-email-toast" className="hidden text-xs text-success animate-pulse">
                                            Copied!
                                        </span>
                                    </p>
                                </div>
                            </div>

                            {/* Terminal column */}
                            <div className="flex-1 max-w-xl w-full">
                                <AnimatedTerminal />
                            </div>
                        </div>
                    </div>
                </section>

                {/* Human + AI authorship notice */}
                <section className="relative z-10 px-4 pb-8">
                    <div className="max-w-6xl mx-auto">
                        <div className="flex items-start gap-4 rounded-2xl border border-primary/20 bg-gradient-to-r from-primary/5 via-base-100/10 to-warning/5 px-5 py-4 shadow-sm">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-lg">
                                ✦
                            </div>
                            <div className="space-y-1 min-w-0">
                                <p className="text-sm font-semibold text-base-content">
                                    Created, Written, Brainstormed, and Verified by both Human and AI
                                </p>
                                <p className="text-xs sm:text-sm text-base-content/65 leading-relaxed">
                                    This book is authored by{' '}
                                    <span className="font-medium text-base-content/80">Md. Najib Islam</span> in genuine collaboration with AI,
                                    with both contributing to the writing, research, content, and verification throughout.{' '}
                                    <span className="text-primary font-medium">A new kind of technical book where Human expertise and AI work together.</span>
                                </p>
                            </div>
                        </div>
                    </div>
                </section>

                {/* What's Inside */}
                <section className="relative z-10 pb-16 px-4">
                    <div className="max-w-6xl mx-auto">
                        <div className="text-center mb-8">
                            <h2 className="text-xl sm:text-2xl font-bold">What&apos;s Inside the Full Book</h2>
                            <p className="text-base-content/60 text-sm mt-1">23 parts covering the full engineering journey — preview includes Part I &amp; II</p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                            {PART_HIGHLIGHTS.map((p, i) => (
                                <div
                                    key={p.title}
                                    className={`rounded-xl border p-4 text-center transition-all ${
                                        i < 2
                                            ? 'border-primary/40 bg-primary/5 hover:border-primary/60'
                                            : 'border-base-300/30 bg-base-100/10 opacity-60'
                                    }`}
                                >
                                    <div className="text-2xl mb-2">{p.icon}</div>
                                    <div className="text-sm font-semibold">{p.title}</div>
                                    <div className="text-[0.65rem] text-base-content/50 mt-1 leading-snug">{p.desc}</div>
                                    {i < 2 && (
                                        <div className="mt-2">
                                            <span className="text-[0.6rem] font-medium text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">In Preview</span>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
                            {[
                                { icon: '🔤', title: '53.75M', desc: 'Characters' },
                                { icon: '✍️', title: '7.18M',  desc: 'Words' },
                                { icon: '📝', title: '899.3K', desc: 'Content Lines' },
                                { icon: '💻', title: '600K+',  desc: 'Code Lines' },
                                { icon: '📄', title: '26.1K',  desc: 'Est. Pages' },
                                { icon: '🧠', title: '12M+',   desc: 'AI Tokens' },
                            ].map((s) => (
                                <div
                                    key={s.desc}
                                    className="rounded-xl border border-base-300/50 bg-base-100/20 backdrop-blur p-4 text-center hover:border-primary/40 hover:bg-base-100/30 transition-all"
                                >
                                    <div className="text-2xl mb-2">{s.icon}</div>
                                    <div className="text-sm font-semibold">{s.title}</div>
                                    <div className="text-[0.65rem] text-base-content/50 mt-1 leading-snug">{s.desc}</div>
                                </div>
                            ))}
                        </div>

                        {BUY_URL && (
                            <div className="text-center mt-8">
                                <a
                                    href={BUY_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-primary btn-md"
                                >
                                    Get the Full Book — All 22 Parts
                                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                </a>
                            </div>
                        )}
                    </div>
                </section>
            </main>
        </div>
    )
}
