import { useEffect, useState } from 'react'

export default function GoLogo() {
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    return (
        <div className={`flex items-center gap-3 transition-opacity duration-500 ${mounted ? 'opacity-100' : 'opacity-0'}`}>
            <div className="animate-float inline-flex items-center justify-center rounded-2xl bg-primary/10 border border-primary/30 p-3 shadow-lg shadow-primary/20">
                <div className="font-mono text-2xl leading-none select-none" aria-label="Go Gopher">
                    <span className="text-primary">ʕ◔ϖ◔ʔ</span>
                </div>
            </div>
            <div className="flex flex-col">
                <span className="text-xs font-semibold uppercase tracking-widest text-primary/80">
                    The Ultimate
                </span>
                <span className="text-2xl font-bold tracking-tight text-base-content">
                    Go Book & Beyond
                </span>
            </div>
        </div>
    )
}
