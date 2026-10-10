# GoBook

The open source web reader for **The Ultimate Go Book & Beyond**, your complete path
from beginner to senior engineer.

## Quick start

Requires Node.js 22+.

```sh
npm install
npm run dev
```

The app expects built chapter content under `public/chapters/`:

- `public/chapters/index.json` — chapter index (`id`, `title`, `part`, `slug`, `sections`)
- `public/chapters/<slug>/<n>.js` — one ES module per section, `export default` markdown string

Book markdown lives in `files/chapters/` (part/chapter/section files). After editing
markdown, rebuild the web content with:

```sh
npm run prebuild
```

This regenerates `public/chapters/` incrementally (359 chapters, 6100+ sections).
Built output under `public/chapters/` is gitignored, markdown sources are committed.

Section files are ordered by their `##` number (`4.10` lands after `4.9`),
unnumbered content keeps file order, and tail matter (Summary, Exercises,
Further Reading) goes last, so late-appended files can never end up stranded
at the end again.

`npm run build` runs the converter first (`prebuild`, a no-op when nothing
changed), then typechecks and bundles. `dist/chapters/` is preserved across
builds instead of wiped and recopied, which keeps incremental builds around
15 seconds; stale sections are pruned by the converter itself.

## Scripts

| Command                    | What it does                                       |
| -------------------------- | -------------------------------------------------- |
| `npm run dev`              | Start the dev server                               |
| `npm run build`            | Typecheck and build to `dist/`                     |
| `npm run preview`          | Preview the production build                       |
| `npm run typecheck`        | Typecheck only                                     |
| `npm run lint`             | Lint `src/` with zero warnings                     |
| `npm run format`           | Format `src/` with Prettier                        |
| `npm run prebuild`         | Rebuild `public/chapters/` from `files/chapters/`  |
| `npm run check-diagrams`   | Validate ASCII diagrams (needs Python 3)           |
| `npm run token-count`      | Exact token stats via tiktoken (needs Python 3)    |
| `npm run token-count:fast` | Approximate stats, writes `public/book-stats.json` |
| `npm run generate-llms`    | Export all content to `llms.txt`                   |

## Project structure

```text
src/
  components/       Navbar, Sidebar, ChapterRenderer, CommandPalette,
                    AnimatedTerminal, Tooltip, LanguageSelector, …
  lib/              chapters, markdown, constants
  lib/translation/  i18n context, engine, providers, cache, masker, languages
  hooks/            useDocumentMeta (per-route title and description)
  files/            book markdown sources + convert-md-files.js pipeline
  pages/            Home, ChapterList, Chapter
  App.tsx           routes + providers
  main.tsx          entry, theme init
  index.css         Tailwind 4 + daisyUI 5 gobook themes + reader prose styles
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Application code under MIT (see `package.json`), book content under
[CC BY 4.0](LICENSE.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
