import { marked } from 'marked'

marked.setOptions({
    gfm: true,
    breaks: false,
})

export interface ParsedMarkdown {
    html: string
    headings: Array<{ id: string; text: string; level: number }>
}

function slugifyHeading(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim()
}

// Replace encoded & with "and" for clean display
function cleanAmpersand(text: string): string {
    return text.replace(/&amp;/g, 'and').replace(/ & /g, ' and ')
}

export function parseMarkdown(content: string): ParsedMarkdown {
    const headings: Array<{ id: string; text: string; level: number }> = []
    const idCounts: Record<string, number> = {}

    const renderer = new marked.Renderer()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer.heading = function ({ tokens, depth }: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (this as any).parser.parseInline(tokens)
        const baseId = slugifyHeading(text.replace(/<[^>]+>/g, ''))
        idCounts[baseId] = (idCounts[baseId] || 0) + 1
        const id = idCounts[baseId] > 1 ? `${baseId}-${idCounts[baseId]}` : baseId

        const displayText = cleanAmpersand(text)

        if (depth <= 3) {
            headings.push({ id, text: displayText, level: depth })
        }

        const sizeClass =
            depth === 1
                ? 'prose-heading mt-10 mb-6 scroll-mt-24'
                : depth === 2
                  ? 'prose-subheading mt-8 mb-4 scroll-mt-24'
                  : 'text-lg font-semibold mt-6 mb-3 text-base-content scroll-mt-24'

        return `<h${depth} id="${id}" class="${sizeClass}">${displayText}</h${depth}>\n`
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer.paragraph = function ({ tokens }: any) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const text = (this as any).parser.parseInline(tokens)
        // Box-drawing / block characters — render as preformatted monospace
        if (/[│┌┐└┘─┬┴┼╗╔║╝╚╠╣╦╩╬█░▒▓]/.test(text)) {
            return `<pre class="font-mono text-xs leading-tight overflow-x-auto whitespace-pre">${cleanAmpersand(text)}</pre>\n`
        }
        return `<p>${cleanAmpersand(text)}</p>\n`
    }

    renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
        const language = lang || 'text'
        const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
        return `<div data-code-block data-lang="${language}" data-code="${escaped}"></div>`
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer.blockquote = (token: any) => {
        const inner = token.tokens
            ? token.tokens.map((t: any) => marked.parse(t.raw) as string).join('')
            : token.text
        return `<blockquote class="my-8 rounded-xl border border-base-300/60 border-l-4 border-l-accent/70 bg-base-200/60 px-5 py-4 italic shadow-sm">${cleanAmpersand(inner)}</blockquote>\n`
    }

    renderer.hr = () => {
        return `<hr class="my-8 border-t border-base-300/60" />\n`
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    renderer.table = (token: any) => {
        const headerHtml = (token.header as any[])
            .map((cell: any) => `<th>${cleanAmpersand((cell.tokens as any[]).map((t: any) => marked.parseInline(t.raw) as string).join(''))}</th>`)
            .join('')
        const bodyHtml = (token.rows as any[][])
            .map(
                (row: any[]) =>
                    `<tr>${row.map((cell: any) => `<td>${cleanAmpersand((cell.tokens as any[]).map((t: any) => marked.parseInline(t.raw) as string).join(''))}</td>`).join('')}</tr>`,
            )
            .join('')

        return `<div class="my-6 overflow-x-auto">
<table class="table table-zebra table-sm chapter-table w-full">
<thead><tr>${headerHtml}</tr></thead>
<tbody>${bodyHtml}</tbody>
</table>
</div>\n`
    }

    marked.use({ renderer })

    const html = marked(content) as string

    return { html, headings }
}
