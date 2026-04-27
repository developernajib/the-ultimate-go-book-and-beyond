import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllChapters } from '@/lib/chapters'

type KeyboardEvent = React.KeyboardEvent<HTMLInputElement>

export default function AnimatedTerminal() {
    const navigate = useNavigate()
    const [input, setInput] = useState('')
    const [history, setHistory] = useState<string[]>([
        'Welcome to The Ultimate Go Book & Beyond',
        '',
        'Your complete path from beginner to senior engineer.',
        'Type: go run gobook',
        '',
        '$ ',
    ])
    const [cursorVisible, setCursorVisible] = useState(true)
    const [cursorPos, setCursorPos] = useState(0)
    const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
        const update = () => setPrefersReducedMotion(mq.matches)
        update()
        mq.addEventListener('change', update)
        return () => mq.removeEventListener('change', update)
    }, [])

    useEffect(() => {
        if (prefersReducedMotion) { setCursorVisible(true); return }
        const id = setInterval(() => setCursorVisible((v) => !v), 530)
        return () => clearInterval(id)
    }, [prefersReducedMotion])

    const handleKeyDown = async (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const cmd = input.trim()

        if (cmd === 'go run gobook') {
            setHistory((prev) => [
                ...prev,
                `$ ${cmd}`,
                '',
                '🚀 Initializing Go Book...',
                '📚 Loading 150+ chapters...',
                '✨ Preparing your path to senior engineer...',
                '',
                '✓ Ready! Starting Chapter 1...',
            ])
            setInput('')
            setTimeout(async () => {
                const chapters = await getAllChapters()
                const first = chapters[0]
                if (first) navigate(`/chapters/${first.slug}`)
            }, 1800)
        } else if (cmd === 'clear') {
            setHistory(['$ '])
            setInput('')
        } else if (cmd === 'help') {
            setHistory((prev) => [
                ...prev,
                `$ ${cmd}`,
                '',
                'Available commands:',
                '  go run gobook     - Start your learning journey',
                '  go version        - Show Go version info',
                '  help              - Show this message',
                '  clear             - Clear terminal',
                '',
                '$ ',
            ])
            setInput('')
        } else if (cmd === 'go version') {
            setHistory((prev) => [
                ...prev,
                `$ ${cmd}`,
                'go version go1.26.0 linux/amd64',
                '',
                '$ ',
            ])
            setInput('')
        } else if (cmd) {
            setHistory((prev) => [
                ...prev,
                `$ ${cmd}`,
                `zsh: command not found: ${cmd}`,
                '',
                'Try: go run gobook',
                '$ ',
            ])
            setInput('')
        } else {
            setHistory((prev) => [...prev, '$ '])
            setInput('')
            setCursorPos(0)
        }
    }

    return (
        <div className="mx-auto w-full max-w-2xl px-2">
            <div className="group relative overflow-hidden rounded-xl border-2 border-base-300 bg-base-300/40 bg-gradient-to-b from-base-300/60 via-base-300/20 to-base-100/10 shadow-lg backdrop-blur transition-all duration-150 hover:shadow-xl [html[data-theme=gobook]_&]:border-primary/40 [html[data-theme=gobook]_&]:hover:border-primary/70">
                {/* Terminal Header */}
                <div className="flex items-center gap-2 border-b border-base-300/70 bg-base-300/70 px-3 sm:px-4 py-2.5">
                    <div className="flex gap-1.5 shrink-0">
                        <div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-error/80 group-hover:bg-error transition-colors" />
                        <div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-warning/80 group-hover:bg-warning transition-colors" />
                        <div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-success/80 group-hover:bg-success transition-colors" />
                    </div>
                    <div className="flex-1 text-center text-xs sm:text-sm font-medium text-base-content/70 truncate">
                        bash — gobook
                    </div>
                </div>

                {/* Terminal Content */}
                <div
                    className="relative cursor-text p-3 sm:p-4 md:p-5 font-mono text-[0.7rem] sm:text-xs md:text-sm min-h-[260px] sm:min-h-[300px] text-left text-base-content/90 overflow-x-auto"
                    onClick={() => inputRef.current?.focus()}
                >
                    {history.map((line, idx) => {
                        const isLastPrompt = line.startsWith('$ ') && idx === history.length - 1
                        const isPastPrompt = line.startsWith('$ ') && !isLastPrompt

                        if (isLastPrompt) {
                            return (
                                <div key={idx} className="flex items-center">
                                    <span className="mr-1 sm:mr-2 text-[0.65rem] sm:text-[0.75rem] text-base-content/50 shrink-0">
                                        gobook %
                                    </span>
                                    <span className="font-semibold text-primary shrink-0">$ </span>
                                    <span className="ml-1 sm:ml-2 text-base-content break-all">
                                        {input.slice(0, cursorPos)}
                                        <span className={`inline-block h-4 sm:h-5 w-1.5 sm:w-2 align-middle ${cursorVisible ? 'bg-primary' : 'bg-transparent'}`} />
                                        {input.slice(cursorPos)}
                                    </span>
                                </div>
                            )
                        }
                        if (isPastPrompt) {
                            return (
                                <div key={idx} className="flex items-center font-semibold text-primary">
                                    <span className="mr-1 sm:mr-2 text-[0.65rem] sm:text-[0.75rem] text-base-content/50 shrink-0">
                                        gobook %
                                    </span>
                                    <span className="break-all">{line}</span>
                                </div>
                            )
                        }
                        return (
                            <div key={idx} className="whitespace-pre-wrap break-words text-base-content/90">
                                {line}
                            </div>
                        )
                    })}

                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => {
                            setInput(e.target.value)
                            setCursorPos(e.target.selectionStart ?? e.target.value.length)
                        }}
                        onKeyDown={handleKeyDown}
                        onKeyUp={() => setCursorPos(inputRef.current?.selectionStart ?? input.length)}
                        onClick={() => setCursorPos(inputRef.current?.selectionStart ?? input.length)}
                        onSelect={() => setCursorPos(inputRef.current?.selectionStart ?? input.length)}
                        className="opacity-0 absolute pointer-events-none"
                        autoFocus
                        aria-label="Terminal input"
                    />
                </div>
            </div>

            <div className="mt-3 flex justify-center text-xs sm:text-sm text-base-content/70 px-2">
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-base-100/10 px-3 py-1.5 max-w-full">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                    <span className="italic break-words text-center">
                        Interactive terminal • Type to get started
                    </span>
                </div>
            </div>
        </div>
    )
}
