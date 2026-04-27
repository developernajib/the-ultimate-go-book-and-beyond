export default `## Exercises

1. Write a linter that detects \`context.Context\` not being the first parameter of functions
2. Build a code generator that creates mock implementations from interfaces
3. Implement a tool that counts lines-of-code per package and generates a report
4. Write a \`go generate\` command that reads a YAML config and generates Go constants
5. Use SSA to find all functions that never return an error despite returning \`error\` in their signature
6. Build a refactoring tool that renames all instances of a type and its methods
7. Implement a complexity checker that enforces a maximum complexity per function in CI
8. Write an analyzer that detects \`fmt.Sprintf\` calls that could be replaced with \`fmt.Errorf\`

### Senior at FAANG Track

9. **Team linter suite audit.** Review the team's current lint configuration. For each rule, determine: who added it, when, why, how many diagnostics per week. Remove dead rules. Propose two new ones that catch observed bug patterns.

10. **Remote build cache rollout.** Evaluate and propose a remote build cache solution for the team. Include integration cost, CI time impact, and expected cache hit rate.

11. **CI speedup analysis.** Measure the team's CI build time across the last quarter. Identify the top three levers to speed it up (parallelism, caching, test sharding). Prioritise by ROI.

12. **Custom linter authorship playbook.** Write the team's playbook for introducing a new custom lint rule. Cover: identification, scoping, implementation, rollout, enforcement, deprecation. Publish as the internal reference.

13. **Binary-size tracking.** Wire binary size into the team's CI output. Alert on regressions greater than 5% per PR. Track the trend over time.
`;
