## Summary

Fundamental complexity analysis reference:

- **Big O**: Upper bound (worst case)
- **Big Omega**: Lower bound (best case)
- **Big Theta**: Tight bound (when best = worst)
- **Amortized Analysis**: Average over sequence of operations
- **Space Complexity**: Memory usage analysis
- **Go Specifics**: Built-in operation complexities

Understanding complexity is essential for:
1. Choosing the right algorithm
2. Predicting performance
3. Making time-space trade-offs
4. Succeeding in technical interviews

### Junior → FAANG: Consolidating This Chapter into Interview Readiness

After completing this chapter, you should be able to answer three types of complexity questions without hesitation. First, "what is the complexity of this code?" requires reading a function and applying the loop analysis and recursion analysis rules. Second, "can you do better?" requires recognizing which complexity class you are in and knowing whether a lower class is achievable for the problem. Third, "what is the trade-off between approach A and approach B?" requires comparing two complexity profiles across both time and space dimensions.

If any of those three feels uncertain, go back to the sections where they are practiced and repeat the exercises with a timer. Interview readiness on complexity is a speed skill as much as a knowledge skill.

### Senior @ FAANG: Complexity as a Career-Long Discipline

The material in this chapter is not a one-time study topic. It is a lens that experienced engineers apply continuously throughout their careers. Every design review, every code review, every capacity planning exercise, and every post-incident analysis involves complexity reasoning at some level.

At the L6 and L7 level, the expectation is not that you apply these concepts to your own code: it is that you ensure your entire team applies them consistently. You achieve that through code review standards, CI tooling, team documentation, and the engineering culture you build through the choices you make visible and the conversations you start. A senior engineer who can derive the Master Theorem result for any recurrence but never spreads that knowledge to colleagues is less valuable than one who builds systems and processes that make complexity thinking automatic for everyone around them.
