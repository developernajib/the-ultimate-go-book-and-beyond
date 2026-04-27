export default `## Learning Objectives

1. **Understand unsafe.Pointer rules** - the five operations and why violating them corrupts memory
2. **Use unsafe for legitimate zero-copy operations** - string↔[]byte conversion, struct field access
3. **Master reflect.Type** - inspect types, fields, methods, and tags at runtime
4. **Master reflect.Value** - read and write values, call functions, create instances dynamically
5. **Build real tools with reflect** - struct tag parsers, generic deep-copy, dynamic validators
6. **Understand reflect performance** - allocations, interface boxing, and when to cache results

### Detailed Outcomes

**Mid-level engineer**

- Recognise \`unsafe\` and \`reflect\` on sight and decide whether the use case is legitimate.
- Write type-safe, caching code that uses \`reflect\` once at initialisation and directly thereafter.
- Articulate why generics replace reflection in most modern Go code.

**Senior engineer**

- Evaluate proposals that reach for \`unsafe\` and decide whether the performance claim justifies the risk.
- Identify reflection-heavy code that should be replaced by code generation.
- Read standard library source that uses \`unsafe\` and explain the safety invariants to the team.

**Staff or Principal engineer**

- Set the team's discipline: when is \`unsafe\` allowed, when is \`reflect\` allowed, when should it be replaced.
- Anticipate the operational cost of runtime reflection in hot paths and guide the architecture away from it.

---
`;
