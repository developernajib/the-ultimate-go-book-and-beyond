## 118.5 When NOT to Trust AI

### Knowledge Cutoff Problems

Every model has a training cutoff, and whatever it is when you read this, it is in the past. The naive version of this problem is that the model has never heard of a recent API. That does happen, but it is the easy case, because the code fails to compile and you find out immediately.

The harder problem, and the one that actually bites, is **training-data skew**. A model's Go knowledge is weighted by how much Go it saw, and the internet contains vastly more Go written before a feature existed than after. So the model knows perfectly well that `log/slog` exists, and still reaches for `logrus` by default, because that is what the overwhelming mass of example code in its training data does. Newer and better loses to older and more numerous.

**Watch for the old-but-plentiful default**: the code compiles, works, and is simply five years out of date:
- `logrus` or `zap` where `log/slog` (Go 1.21) is now the standard answer
- Hand-rolled loops where the `slices` and `maps` packages (Go 1.21) do it in one call
- Callback-style iteration where a range-over-func iterator (Go 1.23) reads better
- `interface{}` where generics (Go 1.18) would give you a real type

This is exactly what the "pinned dependencies" and version lines in CLAUDE.md are for. You are not informing the model that these packages exist. You are outvoting its training data.

**Library versions**: AI will suggest outdated dependency versions. Always verify against current documentation:
```bash
# After AI suggests a dependency, check current version:
go list -m -json github.com/some/package@latest

# Or simply:
go get github.com/some/package@latest
```
**Security advisories**: AI does not know about vulnerabilities disclosed after its training cutoff. Always run:
```bash
govulncheck ./...
```
### Hallucination Patterns

Hallucinations in code are dangerous precisely because they look like valid code. The model is not lying to you, and it has no notion of a fact it could lie about. It is producing the most plausible continuation, and a function name that ought to exist is extremely plausible:

**Made-up function names**:
```go
// AI confidently writes this:
result, err := strings.ContainsPattern(s, regex) // Does not exist

// Actual stdlib:
matched, err := regexp.MatchString(pattern, s)
```
**Invented package paths**:
```go
// AI invents this:
import "github.com/jackc/pgx/v5/pgxutil" // Does not exist

// Actual:
import "github.com/jackc/pgx/v5/pgxpool"
```
**Confident wrong answers about behavior**:
```go
// AI claims sync.Map.Store returns an error. It does not.
value, err := sm.Store(key, val) // WRONG: Store returns nothing

// Actual signature:
sm.Store(key, val) // no return value
```
**Plausible but wrong algorithms**:

The most insidious hallucination is an algorithm that looks right, compiles, and even passes unit tests, but is wrong at the edges. This is most common in:
- Sorting and search algorithms
- Tree traversals
- Cryptographic implementations
- Rate limiting algorithms
- Distributed consensus logic

When AI generates an algorithm, verify the logic independently. Do not trust that it works just because it compiles.

### High-Risk Areas to Never Rely on AI Alone

These areas require human expertise and cannot be delegated to AI:

**Authentication and authorization**: Auth bugs are security critical. JWT validation, session management, OAuth flows, and RBAC enforcement all require a security engineer's review.

**Cryptography**: Never implement cryptographic primitives yourself (AI or not). Use established libraries. But even when using libraries, the configuration matters: key sizes, cipher modes, IV generation, key derivation. AI gets these wrong with dangerous confidence.

**Payment processing**: Stripe/Braintree/Adyen integrations have subtle correctness requirements around idempotency, webhook verification, and failure handling. A wrong implementation means real money lost.

**GDPR/compliance code**: right to deletion, data export, and consent management all carry legal implications. AI does not understand your legal requirements.

**Database migrations**: Migrations that drop columns, rename tables, or change constraints can cause irreversible data loss. Always write migrations manually. Always review with DBAs. Always test on a production data copy.

**Infrastructure/deployment scripts**: A wrong Terraform plan can destroy production infrastructure. A wrong Kubernetes manifest can take down a service. Never let AI generate these without thorough expert review.

### Do Not Turn Off the Permission Prompts

Agentic tools ask before running commands. That prompt is the last synchronous checkpoint between a plausible-looking plan and your filesystem, and it is the first thing people disable because it is annoying. Resist this. `--allow-dangerously-skip-permissions` and its equivalents in other tools are named that way on purpose.

The risk is not that the model is malicious. It is that "clean up the test fixtures" and "clean up the test fixtures and also this directory that looks like fixtures" are one token apart, and `rm -rf` does not ask twice. Worse, as Section 118.2 covered, an agent that reads an issue, a web page, or a tool result has ingested text written by someone who is not you. If that text contains instructions and the agent has unrestricted shell access, the blast radius of a prompt injection is the blast radius of your shell.

Reasonable practice:
- Keep the prompts on for anything that writes, deletes, pushes, or deploys.
- Allowlist the commands you genuinely run constantly and that cannot hurt you (`go test`, `go build`, `go vet`).
- If you want an agent running unattended, give it a sandbox: a container or a disposable worktree, with no production credentials and no network access it does not need. Skipping permissions is defensible when the agent is in a box where the worst case is "throw the box away". It is not defensible on your laptop, which has your SSH keys on it.
- Never paste secrets into a prompt. API keys, connection strings, and customer data do not belong in a context window that goes to a third party and may be retained. Use environment variables and reference them by name, exactly as you would in code.

### When AI Makes Things Worse

**Complex domain logic**: if your business domain is genuinely complex, whether that means actuarial calculations, financial risk models, or healthcare protocols, AI does not know your domain. It will generate code that looks correct but violates domain invariants. Write this logic yourself, have domain experts review it.

**Performance-critical hot paths**: AI cannot profile your code. It does not know what is slow. When you have a performance problem, profile first with `pprof`, identify the actual bottleneck, then optimize specifically. AI-generated "optimizations" based on general principles often optimize the wrong thing or introduce subtle correctness bugs.

**Large existing architecture refactors**: When you need to refactor a large, complex codebase, AI does not have enough context to maintain architectural consistency across hundreds of files. It will make locally reasonable decisions that are globally incoherent. These refactors require human judgment.

### Junior → FAANG: Calibrating Trust in AI Output as a Core Engineering Skill

The sections of this file define the AI trust calibration framework that every professional engineer needs. "When not to trust AI" is the complement to "when to use AI": you need both to use AI tools productively rather than counterproductively. The knowledge cutoff problem is the most immediately actionable: always verify the version of any library or framework that AI generates code against before using it. A model will happily generate code against an API that was deprecated after its cutoff, or against the previous major version of a library because that version dominated its training data. Check the official documentation or changelog for the specific version your project pins.

Cryptographic and security-sensitive code requires special discipline. The failure mode is that AI generates code that looks secure but has a subtle flaw: using a non-cryptographic random number generator where a cryptographic one is required, using an ECB mode cipher instead of a mode with an IV, or generating a token with insufficient entropy. These bugs pass casual review because the code structure is correct. Only someone who knows the specific requirements of secure cryptographic code can identify the flaw. For any security-sensitive function, use a standard library implementation where one exists (crypto/rand for random number generation, bcrypt for password hashing), and treat any AI-generated cryptographic code as requiring a security engineer's review before merging.

The "large existing architecture refactors" limitation is important to understand before an interview where you might be asked to design a large refactoring plan. AI can be useful for generating the migration scripts, the new interface definitions, and individual file refactors. But the overall plan, the sequencing of changes to avoid breaking the build, and the decisions about how to handle exceptions where the pattern does not fit cleanly, require human architectural judgment. Practice describing the human role in a large refactor: what you design yourself, what you delegate to AI, and how you verify that the AI's local decisions are consistent with the global architectural intent.

### Senior @ FAANG: Trust Calibration as a Risk Management Framework

At senior level, the "when not to trust AI" framework becomes a risk management framework for AI-assisted development at the team level. Each category in this section corresponds to a risk level: knowledge cutoff problems are medium risk (easy to catch with version verification, fixable with a library update), security-sensitive code is high risk (bugs are exploitable and may not be immediately visible), complex business logic is medium risk (bugs may be caught by tests), large refactors are medium risk (architectural incoherence becomes visible during review). Risk-stratified review requirements flow from this assessment: standard review for general code, mandatory security engineer review for security-sensitive code, mandatory architect review for large refactors.

The organizational governance implication is that AI-assisted development policies must specify not just "how to use AI tools" but "when human expertise must supplement AI output." A policy that says "all JWT implementation code requires review by a security engineer, regardless of whether it was AI-generated or human-generated" is the correct response to the security-sensitive code trust limitation. A policy that says "refactors affecting more than 10 files require an architectural review before implementation begins" is the correct response to the large refactor limitation. These policies are not AI-specific. They are quality and risk policies that happen to be particularly relevant when AI tools are used because the volume of code generated increases.

The most subtle limitation in this section is the gap between "AI confirms what it generated is correct" and "AI output is actually correct." AI models can confidently confirm incorrect code because their confidence is derived from pattern matching against training data, not from actually executing the code against test cases. The only reliable way to verify AI-generated code is to run it: run the tests, run the linter, run the security scanner. Organizational cultures that treat AI confirmation as a substitute for test execution accumulate hidden technical debt that becomes visible only when the code encounters a case the AI's training data did not represent well. Establishing "run the tests before merging" as a non-negotiable requirement, even when the AI says the code is correct, is a senior engineering culture contribution.

---
