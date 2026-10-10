## 94.6 Delivering Early Wins

Early wins serve two purposes: they build your confidence that you can contribute to this new codebase, and they build your team's confidence that you are a capable, reliable engineer. The ideal first project is small enough to complete quickly but real enough that it touches the actual codebase and delivers genuine value. Resist the temptation to take on something large or impressive too early, a well-executed small task earns more trust than a half-finished ambitious one.

### Finding Good First Projects

The characteristics listed here are not arbitrary, they directly mitigate the two biggest risks of a first contribution: breaking something critical before you understand the system, and taking so long to deliver that your team loses confidence in your velocity. A project that is not on the critical path gives you room to ask questions and iterate without causing an incident, while "touches representative parts of codebase" ensures you learn patterns that generalize, rather than working in an isolated corner that teaches you nothing transferable.

```
IDEAL FIRST PROJECT CHARACTERISTICS:
✓ Relatively contained scope
✓ Not on critical path
✓ Touches representative parts of codebase
✓ Has clear success criteria
✓ Can be completed in 1-2 weeks

EXAMPLES:
• Fix a small bug
• Add a feature flag
• Improve test coverage
• Update documentation
• Add monitoring/logging
• Small performance improvement

ASK YOUR MANAGER:
"What's a good starter project that would help
me learn the codebase while delivering value?"
```

### Making Impact Visible

In a distributed or asynchronous team, work that is not communicated effectively is functionally invisible, your manager cannot advocate for you in performance discussions based on code they never heard about. Clear PR descriptions also serve as durable documentation: six months later, a teammate tracing a regression will rely on your description to understand intent. Proactive communication is especially critical for new hires because it replaces the ambient awareness your teammates naturally have about each other's work.

```
DOCUMENT YOUR WORK:
• Write clear PR descriptions
• Update team documentation
• Share learnings in team meetings
• Write short updates for your manager

COMMUNICATE PROACTIVELY:
• Regular updates in standups
• Weekly summary to manager
• Don't wait to be asked

MEASURE RESULTS:
• Before/after metrics where possible
• User or team impact
• Time saved
```

### Junior → FAANG: Choosing and Framing Your First Wins

The instinct at early career is to wait until you fully understand the system before contributing. This instinct produces invisible engineers who are still in "learning mode" at day 60. The better approach is to ship something small and well-executed at day 30, even if it feels trivial.

The best first contribution has three characteristics: it is well-scoped enough to complete in one to two weeks, it requires understanding at least one non-trivial aspect of the system, and it has a visible positive outcome that your manager can see. Fixing a bug that has been in the backlog for months, adding test coverage to an undertested module, or improving an error message that has been confusing on-call engineers are all appropriate first wins. Rewriting a component or proposing architectural changes are not.

After you ship your first contribution, communicate the outcome explicitly: "I shipped X and it reduced Y" or "I shipped X and here is the test coverage increase." FAANG performance reviews reward impact communication as much as impact delivery. Building this habit in your first 90 days sets the pattern for how you will communicate your work for the rest of your time at the company.

### Senior @ FAANG: Early Wins That Build Credibility at L6

At senior level, the early win calculus is different. A senior engineer's first win should not be a small task completed quickly. It should be a thoughtful contribution that demonstrates the judgment and scope that L6 requires. The best early win for a senior engineer is typically a design document that identifies a real problem and proposes a well-reasoned solution, or a technical decision that resolves a question the team has been debating without resolution.

The specific quality that makes a senior early win effective is that it demonstrates awareness of constraints the team is operating under that a junior engineer would not have considered: organizational readiness for migration, operational complexity of the proposed change, and the migration path from the current state to the desired state. An early win that shows this awareness signals immediately that the new senior engineer understands the difference between a technically correct solution and a solution that can actually be shipped in a real organization.

The governance principle: your first 90-day win should be something the team would have been proud to produce themselves, not something that makes the team feel like they missed an obvious improvement. The former builds trust. The latter creates defensiveness, even when the contribution is genuinely valuable.

---
