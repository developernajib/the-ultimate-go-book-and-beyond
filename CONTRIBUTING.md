# Contributing to The Ultimate Go Book & Beyond

First off, welcome and thank you for taking the time to contribute! We are genuinely excited about building the ultimate Go resource together with the community. Whether you are fixing a typo, improving a technical explanation, contributing new Go examples, or polishing the React web reader, your help makes this project better for every developer.

## How to Contribute

Getting started is straightforward:

1. **Fork the Repository**
   Fork the repository to your own GitHub account and clone it locally:

    ```bash
    git clone https://github.com/<your-username>/the-ultimate-go-book-and-beyond.git
    cd the-ultimate-go-book-and-beyond
    ```

2. **Create a Topic Branch**
   Create a dedicated branch for your work:

    ```bash
    git checkout -b feature/your-improvement
    ```

3. **Make Your Changes**
    - **Chapter Content**: The book chapters and sections are located under `files/chapters/`. Edit or add Markdown files directly.
    - **React Application**: The web reader is built with React, Vite, Tailwind CSS, and TypeScript. Application code lives in `src/`.
        ```bash
        npm install
        npm run dev
        ```

4. **Verify Your Work**
    - If you modified React or TypeScript code, verify types and formatting:
        ```bash
        npm run typecheck
        ```
    - If you added or updated Go snippets, verify that the code compiles cleanly and adheres to standard Go formatting (`gofmt`).
    - If you touched anything under `files/chapters/`, rebuild the web content and check the chapter in the reader:
        ```bash
        npm run prebuild
        npm run dev
        ```

5. **Commit and Push**
   Commit your changes with a clear, descriptive commit message and push the branch to your fork:

    ```bash
    git add .
    git commit -m "docs: clarify channel synchronization in chapter 02"
    git push origin feature/your-improvement
    ```

6. **Open a Pull Request**
   Open a Pull Request (PR) against the `main` branch. Provide a brief description of what was changed and why. We will review your PR, offer constructive feedback, and collaborate with you to merge it.

## Content Style Guide

When contributing written content or Go code, please keep the following guidelines in mind:

- **Idiomatic Go (1.26+)**: Use modern, idiomatic Go conventions (e.g. `any` instead of `interface{}`, standard library packages like `slices` and `math/rand/v2`, `for range` integer loops, and builtin `min` / `max`).
- **Simplicity First**: Keep explanations clear, grounded, and accessible while maintaining technical depth. Avoid unnecessary jargon or over-complicated abstractions.
- **Runnable, Minimal Examples**: Ensure code snippets are clean, minimal, compile without errors, and demonstrate exactly what the surrounding text discusses.
- **Consistent Markdown**: Use standard Markdown formatting. Keep headings structured, tables tidy, and code blocks tagged with the appropriate language identifier (e.g. ````go```).
- **Standard Punctuation**: Use standard hyphens ("-") rather than em-dashes or en-dashes.

## Chapter File Rules

The converter (`npm run prebuild`) builds the reader from `files/chapters/` with strict conventions. Follow them so titles, slugs, and ordering come out right, whether you add a chapter or edit a section.

**Layout**

- Parts: `files/chapters/<part>/`, e.g. `part-01-go-mastery/`. Never rename a part folder, chapter slugs (and URLs) derive from it.
- Chapters: one folder per chapter, e.g. `chapter-04-types-deep-dive/`. Never rename a chapter folder, it is part of every section URL.
- Sections: one Markdown file per section, named `NN-descriptive-name.md` with a two-digit sequence (`00-`, `01-`, ...). File order is section order, so a late-added file lands at the end unless you renumber.

**Headings (this is what the sidebar shows)**

- Every section file except `00-*` must open its title with a `## ` heading. That exact text becomes the sidebar title and the URL slug. Files without one fall back to the filename, which renders lowercase and ugly.
- Use a single `# ` heading only for the chapter title inside the `00-*.md` intro file. That file always renders as the "Introduction" section.
- Keep `#` comments inside fenced code blocks only. A bare `# ` line outside a fence is read as a title.
- One title heading per file. Two adjacent files with the identical title get merged into one section.
- Name closing sections exactly `Summary`, `Exercises`, or `Further Reading` so they sort as end matter.

**Content hygiene**

- Tag every code fence with a language (``go`, ``bash`, ...). Never leave a fence unclosed, an unclosed fence swallows the rest of the file.
- Keep ASCII diagrams aligned (every row of a box the same display width). Check with `npm run check-diagrams`.
- Save files as UTF-8 without a BOM. A BOM breaks the first heading of the file.
- Complete Go programs (`package main` + `func main`) should use stdlib-only imports so they stay verifiable. Test snippets (`TestXxx`) need no `package` clause.

**New chapter checklist**

1. Create `files/chapters/<part>/chapter-NN-slug/` with files `00-*.md`, `01-*.md`, ... in reading order.
2. Give every file a `## ` title (or one `# ` chapter title in the `00-` file).
3. Run `npm run prebuild` and open the chapter via `npm run dev`.
4. Confirm sidebar order, section URLs, and that code blocks render highlighted.

## Contributor License Agreement (CLA)

By submitting a Pull Request to this project, you agree that your code contributions will be licensed under the MIT License and your written/media content contributions will be licensed under the Creative Commons Attribution 4.0 International (CC BY 4.0) license.

---

Thank you for helping us make Go mastery accessible to developers worldwide!
