import { useEffect, useRef } from 'react'
import Prism from 'prismjs'
import 'prismjs/components/prism-go'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-yaml'
import 'prismjs/components/prism-sql'

interface ChapterRendererProps {
    html: string
}

/**
 * Renders the HTML produced by parseMarkdown().
 * After mounting it replaces data-code-block placeholders with styled
 * CodeBlock-equivalent DOM nodes and runs Prism highlighting.
 */
export default function ChapterRenderer({ html }: ChapterRendererProps) {
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        // Replace data-code-block placeholders with real code blocks
        const placeholders = container.querySelectorAll<HTMLElement>('[data-code-block]')

        placeholders.forEach((placeholder) => {
            const lang = placeholder.dataset.lang || 'go'
            const code = placeholder.dataset.code || ''

            // Decode HTML entities
            const decoded = code
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')

            const LANG_LABELS: Record<string, string> = {
                go: 'Go', golang: 'Go', sh: 'Shell', bash: 'Shell',
                shell: 'Shell', zsh: 'Shell', json: 'JSON', yaml: 'YAML',
                yml: 'YAML', toml: 'TOML', sql: 'SQL', proto: 'Protobuf',
                text: 'Text', plaintext: 'Text', makefile: 'Makefile',
            }

            const isGo = lang === 'go' || lang === 'golang'
            const isShell = ['sh', 'bash', 'shell', 'zsh'].includes(lang)
            const labelText = LANG_LABELS[lang] || lang.charAt(0).toUpperCase() + lang.slice(1)
            const prismLang = isGo ? 'go' : isShell ? 'bash' : lang

            const labelColorClass = isGo
                ? 'border-primary/80 bg-primary/10 text-primary'
                : isShell
                  ? 'border-success/70 bg-success/10 text-success'
                  : 'border-base-300/70 bg-base-100/10 text-base-content/70'

            const wrapper = document.createElement('div')
            wrapper.className =
                'my-6 overflow-hidden rounded-xl border border-base-300/60 bg-base-300/30 bg-gradient-to-b from-base-300/60 via-base-300/20 to-base-100/10 shadow-[0_4px_20px_rgba(0,0,0,0.2)] backdrop-blur transition-all duration-150 hover:border-primary/60 hover:shadow-[0_6px_25px_rgba(0,0,0,0.25)]'

            const header = document.createElement('div')
            header.className =
                'flex items-center justify-between gap-3 border-b border-base-300/60 bg-base-300/60 px-4 py-2'
            header.innerHTML = `
                <span class="inline-flex items-center rounded-full px-2 py-1 text-[0.65rem] uppercase tracking-wide border ${labelColorClass}">${labelText}</span>
                <button type="button" class="copy-btn inline-flex items-center gap-1 rounded-full border border-primary/80 bg-base-100/5 px-2.5 py-1 text-[0.7rem] font-medium text-primary shadow-sm transition-all duration-150 hover:-translate-y-[1px] hover:bg-primary/10">
                    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                        <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>
                        <rect x="4" y="4" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6" opacity="0.6"/>
                    </svg>
                    <span>Copy</span>
                </button>
            `

            // Copy button logic
            const copyBtn = header.querySelector<HTMLButtonElement>('.copy-btn')!
            const copySpan = copyBtn.querySelector('span')!
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(decoded)
                    copySpan.textContent = 'Copied!'
                    setTimeout(() => { copySpan.textContent = 'Copy' }, 1500)
                } catch { /* ignore */ }
            })

            const body = document.createElement('div')
            body.className = lang === 'text' ? 'overflow-auto px-4 py-3' : 'max-h-[32rem] overflow-auto px-4 py-3'

            const pre = document.createElement('pre')
            pre.className = `language-${prismLang} text-sm leading-relaxed`

            const codeEl = document.createElement('code')
            codeEl.className = `language-${prismLang}`
            codeEl.textContent = decoded

            pre.appendChild(codeEl)
            body.appendChild(pre)
            wrapper.appendChild(header)
            wrapper.appendChild(body)

            placeholder.replaceWith(wrapper)
        })

        // Run Prism on everything
        Prism.highlightAllUnder(container)
    }, [html])

    return (
        <div
            ref={containerRef}
            id="chapter-article"
            className="prose-gobook"
            dangerouslySetInnerHTML={{ __html: html }}
        />
    )
}
