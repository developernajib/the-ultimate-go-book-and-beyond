import { useEffect, useRef, useState } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-docker'
import 'prismjs/components/prism-protobuf'

interface CodeBlockProps {
    code: string
    language?: string
}

const LANGUAGE_LABELS: Record<string, string> = {
    go: 'Go',
    golang: 'Go',
    sh: 'Shell',
    bash: 'Shell',
    shell: 'Shell',
    zsh: 'Shell',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    toml: 'TOML',
    sql: 'SQL',
    dockerfile: 'Dockerfile',
    docker: 'Dockerfile',
    proto: 'Protobuf',
    protobuf: 'Protobuf',
    text: 'Text',
    plaintext: 'Text',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    makefile: 'Makefile',
    make: 'Makefile',
}

export default function CodeBlock({ code, language = 'go' }: CodeBlockProps) {
    const [copied, setCopied] = useState(false)
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const normalized = (language || 'go').toLowerCase()

    useEffect(() => {
        Prism.highlightAll()
    }, [code, normalized])

    useEffect(() => {
        return () => {
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
        }
    }, [])

    const label =
        LANGUAGE_LABELS[normalized] ||
        normalized.charAt(0).toUpperCase() + normalized.slice(1)

    const isGo = normalized === 'go' || normalized === 'golang'
    const isShell = ['sh', 'bash', 'shell', 'zsh'].includes(normalized)

    const labelClass = isGo
        ? 'border-primary/80 bg-primary/10 text-primary'
        : isShell
          ? 'border-success/70 bg-success/10 text-success'
          : 'border-base-300/70 bg-base-100/10 text-base-content/70'

    const handleCopy = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(code)
            } else {
                const ta = document.createElement('textarea')
                ta.value = code
                ta.style.cssText = 'position:fixed;opacity:0'
                document.body.appendChild(ta)
                ta.select()
                document.execCommand('copy')
                document.body.removeChild(ta)
            }
            setCopied(true)
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
            copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500)
        } catch {
            // ignore
        }
    }

    // Normalize language for Prism class
    const prismLang = isGo ? 'go' : isShell ? 'bash' : normalized

    return (
        <div className="group my-6 overflow-hidden rounded-xl border border-base-300/60 bg-base-300/30 bg-gradient-to-b from-base-300/60 via-base-300/20 to-base-100/10 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur transition-all duration-150 hover:border-primary/60 hover:shadow-[0_6px_25px_rgba(0,0,0,0.25)]">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-base-300/60 bg-base-300/60 px-4 py-2">
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-[0.65rem] uppercase tracking-wide border ${labelClass}`}>
                    {label}
                </span>
                <button
                    type="button"
                    onClick={handleCopy}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.7rem] font-medium text-primary shadow-sm transition-all duration-150 ${
                        copied
                            ? 'border-primary/90 bg-primary/20'
                            : 'border-primary/80 bg-base-100/5 hover:-translate-y-[1px] hover:bg-primary/10'
                    }`}
                >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
                        <rect x="4" y="4" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" opacity="0.6" />
                    </svg>
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>

            {/* Code */}
            <div className={`${normalized === 'text' ? '' : 'max-h-[32rem]'} overflow-auto px-4 py-3`}>
                <pre className={`language-${prismLang} text-sm leading-relaxed`}>
                    <code className={`language-${prismLang}`}>{code}</code>
                </pre>
            </div>
        </div>
    )
}
