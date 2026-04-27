export interface Chapter {
    slug: string
    title: string
    number: string
    part: string
    partLabel: string
    filePath: string
}

export interface Section {
    slug: string
    title: string
    index: number
    chapterSlug: string
    content: string
}

export interface ChapterWithSections extends Chapter {
    sections: Section[]
}

const PREVIEW_PARTS = new Set(['00-front-matter', 'part-01-go-mastery', 'part-02-concurrency'])

export function isPreviewChapter(slug: string): boolean {
    const prefix = slug.split('--')[0]
    return PREVIEW_PARTS.has(prefix)
}

const PART_LABELS: Record<string, string> = {
    '00-front-matter': 'Front Matter',
    'part-01-go-mastery': 'Part I: Go Mastery',
    'part-02-concurrency': 'Part II: Concurrency',
    'part-03a-production-ready': 'Part III-A: Production Ready',
    'part-03b-high-performance': 'Part III-B: High Performance Go',
    'part-03c-testing-at-scale': 'Part III-C: Testing at Scale',
    'part-04-real-world-apps': 'Part IV: Real-World Apps',
    'part-05a-data-layer': 'Part V-A: Data Layer',
    'part-05b-database-ecosystem': 'Part V-B: Database Ecosystem',
    'part-05c-caching-engineering': 'Part V-C: Caching Engineering',
    'part-06-rest-api': 'Part VI: REST API',
    'part-07-grpc': 'Part VII: gRPC',
    'part-08a-microservices': 'Part VIII-A: Microservices',
    'part-08b-domain-driven-design': 'Part VIII-B: Domain-Driven Design',
    'part-08c-message-queues': 'Part VIII-C: Message Queues',
    'part-08d-workflow-orchestration': 'Part VIII-D: Workflow Orchestration',
    'part-09-fullstack': 'Part IX: Fullstack',
    'part-10a-system-design': 'Part X-A: System Design',
    'part-10b-system-design-problems': 'Part X-B: System Design Problems',
    'part-10c-distributed-systems-extended': 'Part X-C: Distributed Systems',
    'part-10d-multi-region-disaster-recovery': 'Part X-D: Multi-Region & DR',
    'part-11-dsa': 'Part XI: DSA & Algorithms',
    'part-12-interview-mastery': 'Part XII: Interview Mastery',
    'part-13a-senior-engineer-mindset': 'Part XIII-A: Senior Engineer Mindset',
    'part-13b-architecture-patterns': 'Part XIII-B: Architecture Patterns',
    'part-14a-career-guide': 'Part XIV-A: Career Guide',
    'part-14b-migration-modernization': 'Part XIV-B: Migration & Modernization',
    'part-15a-cloud-infrastructure': 'Part XV-A: Cloud & Infrastructure',
    'part-15b-devops-platform': 'Part XV-B: DevOps & Platform Engineering',
    'part-15c-networking-protocols': 'Part XV-C: Networking & Protocols',
    'part-16a-observability-sre': 'Part XVI-A: Observability & SRE',
    'part-16b-observability-extended': 'Part XVI-B: Observability Extended',
    'part-17a-security': 'Part XVII-A: Security',
    'part-17b-compliance-regulatory': 'Part XVII-B: Compliance & Regulatory',
    'part-18-ai-ml': 'Part XVIII: AI Engineering & Machine Learning',
    'part-19-blockchain': 'Part XIX: Blockchain & Web3 (Optional)',
    'part-20-capstone-projects': 'Part XX: Capstone Projects',
    'part-21a-cpp': 'Part XXI-A: C++ Mastery',
    'part-21b-cpp-concurrency-systems': 'Part XXI-B: C++ Concurrency & Systems',
    'part-21c-cpp-performance': 'Part XXI-C: C++ Performance',
    'part-21d-cpp-production': 'Part XXI-D: C++ Production',
    'part-22-ebpf-linux-internals': 'Part XXII: eBPF & Linux Internals',
    'appendices': 'Appendices',
    '99-afterword': 'Afterword',
}

const slugify = (text: string) =>
    text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim().slice(0, 60)

let _chapterListCache: ChapterWithSections[] | null = null
const _sectionContentCache = new Map<string, string>()

interface IndexEntry {
    id: string
    title: string
    number: string
    part: string
    slug: string
    sections: string[]
    sectionCount: number
}

let _indexCache: IndexEntry[] | null = null

async function loadIndex(): Promise<IndexEntry[]> {
    if (_indexCache) return _indexCache
    const resp = await fetch('/chapters/index.json')
    _indexCache = await resp.json()
    return _indexCache!
}

export async function getAllChapters(): Promise<ChapterWithSections[]> {
    if (_chapterListCache) return _chapterListCache

    const index = await loadIndex()

    _chapterListCache = index.map((entry, i) => {
        const slug = entry.slug
        const sectionTitles = entry.sections || ['Introduction']

        const sections: Section[] = sectionTitles.map((title, idx) => ({
            slug: title === 'Introduction' ? 'intro' : slugify(title),
            title,
            index: idx,
            chapterSlug: slug,
            content: '',
        }))

        return {
            slug,
            title: entry.title,
            number: String(i + 1).padStart(2, '0'),
            part: entry.part,
            partLabel: PART_LABELS[entry.part] || entry.part,
            filePath: '',
            sections,
        }
    })

    return _chapterListCache
}

export async function getChapterBySlug(slug: string): Promise<ChapterWithSections | null> {
    const chapters = await getAllChapters()
    return chapters.find((c) => c.slug === slug) || null
}

export async function getSectionContent(chapterSlug: string, sectionSlug: string): Promise<string> {
    const cacheKey = `${chapterSlug}/${sectionSlug}`
    if (_sectionContentCache.has(cacheKey)) {
        return _sectionContentCache.get(cacheKey)!
    }

    const index = await loadIndex()
    const entry = index.find((e) => e.slug === chapterSlug)
    if (!entry) {
        return `## Section Not Found\n\nCould not find chapter **${chapterSlug}**.`
    }

    const chapters = await getAllChapters()
    const chapter = chapters.find((c) => c.slug === chapterSlug)
    if (!chapter) {
        return `## Section Not Found\n\nChapter not found.`
    }

    const sectionIndex = chapter.sections.findIndex((s) => s.slug === sectionSlug)
    if (sectionIndex === -1) {
        return `## Section Not Found\n\nSection **${sectionSlug}** not found.`
    }

    const mod = await import(/* @vite-ignore */ `/chapters/${entry.slug}/${sectionIndex}.js`)
    const raw = mod.default as string
    _sectionContentCache.set(cacheKey, raw)
    return raw
}

export async function getAllSectionsFlat(): Promise<Array<Section & { chapterTitle: string; chapterNumber: string }>> {
    const chapters = await getAllChapters()
    return chapters.flatMap((ch) =>
        ch.sections.map((sec) => ({
            ...sec,
            chapterTitle: ch.title,
            chapterNumber: ch.number,
        })),
    )
}
