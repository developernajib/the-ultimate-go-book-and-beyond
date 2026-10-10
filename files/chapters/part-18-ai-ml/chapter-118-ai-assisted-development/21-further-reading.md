## Further Reading

**The evidence, read it yourself rather than trusting anyone's summary (including this chapter's):**
- Peng et al., "The Impact of AI on Developer Productivity: Evidence from GitHub Copilot" (arXiv:2302.06590). The 55% study. Note the scope: 95 developers, one greenfield HTTP server in JavaScript, 95% confidence interval of 21% to 89%.
- METR, "Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity" (arXiv:2507.09089, July 2025). The 19% slowdown, and the perception gap that matters more than the headline. METR itself now labels the result historical, which is a model of how to cite your own work.

**Primary sources on the tools:**
- Andrej Karpathy's "vibe coding" post (X, 2 February 2025). Read the whole thing, not the first sentence. (For his more substantial argument, see "Software 2.0", 2017. The phrase "software is eating the world" is Marc Andreessen's, from 2011, and is a different claim entirely.)
- Claude Code documentation: `code.claude.com/docs`. The authoritative source for flags, hooks, and settings, all of which change between releases and none of which a model reliably remembers.

**Go craft, the part AI cannot supply:**
- `go.dev/wiki/CodeReviewComments`. The Go code review guidelines AI output should follow and often does not.
- Go documentation: `pkg.go.dev`. The source of truth for the API signatures AI misquotes.
- "A Philosophy of Software Design" (Ousterhout). Deep versus shallow modules, which is exactly the distinction AI-generated code most often gets wrong.
- "The Pragmatic Programmer" (Hunt & Thomas). Still the best foundation for the judgment none of this replaces.

**Tooling that verifies rather than believes:**
- `govulncheck` (`golang.org/x/vuln`). Vulnerability checking for the dependencies AI suggests.
- `golangci-lint`. Catches most AI Go anti-patterns automatically.
- `gosec`. Flags string-formatted SQL and weak crypto.
- OWASP Go Secure Coding Practices. The security checklist to run AI-generated code against.
- "Accelerate" (Forsgren, Humble, Kim). DORA metrics, the vocabulary for Section 118.14.

### Junior → FAANG: Building a Curated Reading Practice

The reading list covers four categories: the primary evidence (the GitHub and METR papers), the tools (Karpathy, Claude Code docs), Go-specific craft (Go documentation, CodeReviewComments), and engineering judgment (Pragmatic Programmer, Philosophy of Software Design, Accelerate). Start with the two papers, and read them rather than the coverage of them, because this is a field where the summaries are consistently more confident than the studies. Reading one resource from each category per quarter builds a balanced foundation. "A Philosophy of Software Design" by John Ousterhout is particularly valuable as an AI-assisted development complement because it articulates the design principles that AI-generated code most frequently violates: deep modules versus shallow modules, complexity hiding, error handling as part of the interface contract. "Accelerate" provides the vocabulary for DORA metrics that are increasingly required for engineering productivity discussions at FAANG.

The govulncheck tool should be in every Go engineer's local development toolchain and in the CI pipeline. AI tools may suggest dependencies that have known vulnerabilities (because the vulnerability was disclosed after the AI's training cutoff), and govulncheck detects these before they reach production. Running govulncheck on every dependency change is a security hygiene habit that prevents a class of supply chain vulnerabilities that AI-assisted development makes more likely (AI suggests using a library, engineer adds it without manually checking its vulnerability history).

### Senior @ FAANG: Reading List as Team Engineering Culture Curriculum

At senior level, the further reading list is the foundation for a team engineering culture curriculum. Selecting one book per quarter as a team reading, scheduling a discussion session to connect the book's principles to the team's current challenges, and assigning a practice exercise that applies the book's principles to a real codebase problem is a team culture investment that compounds over time. The Pragmatic Programmer is the starting point for teams adopting AI tools without a strong software craftsmanship foundation. Philosophy of Software Design is the follow-up for teams that need help distinguishing AI-generated shallow modules from the deep modules that make large codebases maintainable.

Integrating govulncheck into CI and distributing the OWASP Go checklist as part of the team's security review process are the concrete security engineering contributions that senior engineers make to protect AI-assisted development from security debt. As AI generates more Go code, the rate at which insecure patterns can be introduced increases proportionally. The security toolchain must scale with the code generation rate, which means automated scanning is more important than ever when AI tools are active.
