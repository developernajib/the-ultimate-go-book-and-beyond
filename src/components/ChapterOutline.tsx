import { useEffect, useRef, useState } from 'react'

interface HeadingItem {
    id: string
    title: string
    level: 2 | 3
}

interface ChapterOutlineProps {
    targetId?: string
    scrollContainerId?: string
}

export default function ChapterOutline({
    targetId = 'chapter-content',
    scrollContainerId = 'main-scroll',
}: ChapterOutlineProps) {
    const [headings, setHeadings] = useState<HeadingItem[]>([])
    const [activeId, setActiveId] = useState<string | null>(null)
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
    const headingElemsRef = useRef<HTMLElement[]>([])

    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setPrefersReducedMotion(mq.matches)
        update()
        mq.addEventListener('change', update)
        return () => mq.removeEventListener('change', update)
    }, [])

    // Collect headings after render
    useEffect(() => {
        // Small delay so ChapterRenderer has time to replace placeholders
        const timer = setTimeout(() => {
            const article = document.getElementById(targetId)
            if (!article) return
            const elems = Array.from(article.querySelectorAll('h2[id], h3[id]')) as HTMLElement[]
            headingElemsRef.current = elems
            setHeadings(
                elems.map((el) => ({
                    id: el.id,
                    title: el.textContent?.trim() || el.id,
                    level: el.tagName === 'H2' ? 2 : 3,
                })),
            )
        }, 100)
        return () => clearTimeout(timer)
    }, [targetId])

    // Scroll spy — listen on the scrollable container, not window
    useEffect(() => {
        if (!headings.length) return
        const scroller = document.getElementById(scrollContainerId) || window
        let ticking = false

        const onScroll = () => {
            if (ticking) return
            ticking = true
            requestAnimationFrame(() => {
                const offset = 32
                let current = headingElemsRef.current[0]?.id || null
                for (const el of headingElemsRef.current) {
                    if (el.getBoundingClientRect().top - offset <= 0) current = el.id
                    else break
                }
                setActiveId(current)
                ticking = false
            })
        }

        onScroll()
        scroller.addEventListener('scroll', onScroll, { passive: true } as EventListenerOptions)
        return () => scroller.removeEventListener('scroll', onScroll)
    }, [headings, scrollContainerId])

    const handleClick = (id: string) => (e: React.MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        const el = document.getElementById(id)
        if (!el) return
        const scroller = document.getElementById(scrollContainerId)
        if (scroller) {
            const offset = el.offsetTop - 24
            scroller.scrollTo({ top: offset, behavior: prefersReducedMotion ? 'auto' : 'smooth' })
        } else {
            el.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' })
        }
        history.replaceState(null, '', `#${id}`)
    }

    if (!headings.length) return null

    return (
        <aside className="hidden lg:flex lg:flex-col w-64 xl:w-72 shrink-0 h-full overflow-y-auto py-6 pr-6 border-l border-base-300/40">
            <nav aria-label="On this page" className="sticky top-4">
                <div className="rounded-xl border border-base-300/40 bg-base-100/70 px-4 py-4 shadow-[0_4px_16px_rgba(0,0,0,0.15)] backdrop-blur">
                    <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-base-content/70">
                        On this page
                    </div>
                    <ul className="space-y-1">
                        {headings.map((h) => {
                            const active = h.id === activeId
                            return (
                                <li key={h.id}>
                                    <a
                                        href={`#${h.id}`}
                                        onClick={handleClick(h.id)}
                                        className={`flex items-center gap-2 rounded-md px-2 py-1 transition-all duration-150 ${
                                            h.level === 3 ? 'ml-3 text-[0.78rem]' : 'text-[0.82rem] font-medium'
                                        } ${
                                            active
                                                ? 'text-primary border-l-2 border-primary bg-base-100/60 pl-1.5'
                                                : 'text-base-content/60 hover:text-base-content hover:-translate-x-[1px]'
                                        }`}
                                    >
                                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${active ? 'bg-primary' : 'bg-base-300'}`} />
                                        <span className="truncate">{h.title}</span>
                                    </a>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            </nav>
        </aside>
    )
}
