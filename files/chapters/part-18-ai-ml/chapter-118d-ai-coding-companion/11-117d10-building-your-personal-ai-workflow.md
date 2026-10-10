## 118D.10 Building Your Personal AI Workflow

### Setting Up Claude Code for Your Go Projects

Most agentic coding tools read a project-context file from the repository root and prepend it to every request. Claude Code uses `CLAUDE.md`; other tools use their own filename and broadly the same idea. Whatever it is called, this file is the highest-value thing you can write for output quality, because it supplies the context the model cannot infer: your stack, your conventions, your constraints, and the things it must never do.

The reason it matters so much follows from the failure mode described throughout this chapter. A model with no context does not decline to answer, it produces a confident, generic answer. Generic is precisely what you do not want in a codebase with existing conventions. The context file is how you convert "write a handler" into "write a handler *the way this repository writes handlers*", which is the difference between a suggestion you accept and one you rewrite.

**Example: CLAUDE.md for a Go Microservice**

```markdown
# Project: Payment Service
```

That heading is the whole file so far. The sections that fill it in follow, one at a time: architecture, code conventions, package structure, security rules, testing, and approved dependencies. Read them as a single document assembled in pieces.

### Junior → FAANG: Personal Workflow as Career Infrastructure

A personal AI workflow is career infrastructure: it compounds over time, it is transferable across employers and projects, and it distinguishes engineers who have invested in their craft from those who have not. The core components of a personal AI workflow are: CLAUDE.md templates for the types of projects you work on most, a prompt library for the task types you perform most frequently, measurement practices for tracking your productivity, and review habits that maintain code quality. Building each component incrementally, starting from what you do most often, produces a workflow that is continuously improving rather than stagnant.

One diagnostic worth running occasionally: review your last 20 unsuccessful prompts and categorize the failure mode (too little context, too much context, wrong task specification, stale knowledge about a library, inherently a judgement task the model cannot do). The distribution tells you which part of your practice to improve first, and it is more useful than any aggregate number, because the fix differs completely by category. "Too little context" is solved by a better context file. "Inherently a judgement task" is solved by not asking.

Resist the temptation to turn this into a percentage with a threshold. An earlier draft of this chapter asserted that a sub-50% prompt success rate means AI is costing you time. That number was invented, nobody tracks their prompt success rate, and the threshold would depend entirely on how long the failures took versus what the successes saved. The diagnostic is the categorization, not the score.

### Senior @ FAANG: Personal Workflow as Team Capability Blueprint

At senior level, a well-developed personal AI workflow is the blueprint for team AI capability development. Engineers who have developed effective personal workflows for Go architecture discussions, debugging, code review, test generation, documentation, and refactoring have the practical experience to guide the team toward the same productivity level. Sharing your personal CLAUDE.md templates, prompt library, and measurement practices with the team is the knowledge multiplication that distinguishes senior engineers who scale their impact through others from those who only scale their personal productivity.

The same failure-mode categorization, run across the team rather than one engineer, reveals systemic gaps. If most failures cluster on "too little context", the team's context file is stale or thin, and fixing one file helps everyone. If they cluster on "wrong task specification", the team is reaching for AI on tasks it cannot do, and the fix is a shared understanding of where the real value is. Addressing a systemic gap beats coaching individuals one at a time.

Be sceptical of anyone (including a book) offering a number here. There is no credible published figure for how much faster an AI-augmented team is, the honest studies disagree with each other by more than their effect sizes, and the one thing that is well established is that self-reported speedups do not track measured ones. If your organization wants to know whether the investment is paying off, the only trustworthy answer comes from measuring your own delivery on your own work, with the same scepticism you would apply to any other vendor's benchmark.
