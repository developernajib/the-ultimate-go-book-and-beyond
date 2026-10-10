## 85.10 Core Concepts Recap

### Key Takeaways

1. **Think in systems, not just components** - Understand relationships and interactions
2. **Identify feedback loops** - Know which are reinforcing vs balancing
3. **Consider higher-order effects** - First-order thinking is insufficient
4. **Expect emergence** - System behavior differs from component behavior
5. **Map dependencies thoroughly** - Know hard, soft, and hidden dependencies
6. **Apply mental models** - Queuing theory, Little's Law, CAP theorem

### Systems Thinking Checklist

- [ ] Can I draw a diagram of the system and its relationships?
- [ ] Have I identified the feedback loops?
- [ ] What are the second and third-order effects of my change?
- [ ] What emergent behaviors might occur?
- [ ] What are all the dependencies (including hidden ones)?
- [ ] What happens when each dependency fails?
- [ ] Which system archetype applies here?

---

### Core Practice Exercises

### Exercise 1: Map a System
Take a system you work with and create a complete diagram showing:
- All components and their relationships
- Feedback loops (mark reinforcing vs balancing)
- Dependencies (mark hard vs soft vs hidden)

### Exercise 2: Effect Analysis
For your next technical decision, write out:
- First, second, and third-order effects
- Potential emergent behaviors
- Mitigations for negative effects

### Exercise 3: Failure Mode Analysis
For a critical service you own:
- List all dependencies
- For each dependency, document what happens if it's: unavailable, slow, or returns errors
- Design graceful degradation strategies

### Junior → FAANG: Systems Thinking as an Accelerant for Every Other Skill

The key insight from this chapter that compounds with everything else in Part XIII: systems thinking is not a standalone skill. It makes every other skill more effective. Technical leadership becomes more effective when you can frame decisions in terms of system-level consequences. Code review becomes more effective when you can identify feedback loops in proposed changes. RFC writing becomes more effective when you can analyze second and third-order effects.

Before your interview, practice weaving systems thinking language into your other answers. When you describe a technical decision, add: "and I also considered how this would interact with the X component under load." When you describe a failure, add: "which we traced to a reinforcing feedback loop where Y caused Z which amplified Y." This language signals systems thinking without being explicit about it.

### Senior @ FAANG: Making Systems Thinking Contagious

The single most useful outcome of internalizing this chapter is not personal competence. It is the ability to model systems thinking visibly enough that other engineers on your team start doing it naturally. This happens through: consistently asking systems-thinking questions in design reviews, naming feedback loops and archetypes when you observe them in real systems, and writing post-mortems that trace the system dynamics behind the failure rather than just the proximate cause.

Over time, a team that has been consistently exposed to systems thinking language and questions will start using them independently. That is the compounding return: your systems thinking becomes the team's systems thinking, which produces better designs, fewer surprises in production, and faster incident resolution.

---
