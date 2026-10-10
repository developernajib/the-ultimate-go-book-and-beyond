## 53B.2 The Ripple Component Model

Ripple components are declared with the `component` keyword rather than as functions that return JSX. This one-line change has consequences that ripple through the entire authoring experience (pun intended).

### A Minimal Component

```typescript
// Button.ripple
component Button(props: { text: string; onClick: () => void }) {
  <button onClick={props.onClick}>
    {props.text}
  </button>
}
```

Compare to the React equivalent:

```tsx
// Button.tsx
function Button(props: { text: string; onClick: () => void }): JSX.Element {
  return (
    <button onClick={props.onClick}>
      {props.text}
    </button>
  );
}
```

Three differences matter.

**No `return` statement.** The component body is the template. There is no ambiguity about whether you are returning JSX, returning null, or doing something conditional.

**No `JSX.Element` return type.** Ripple's `component` keyword is a language-level construct, so the type checker already knows the body is a render output.

**No implicit closure-per-render.** In React, every render re-creates every arrow function, every inline object, every inline JSX. Ripple's compiled output only updates the specific DOM nodes whose reactive dependencies changed. You do not need `useCallback` or `useMemo` to avoid re-renders, because the render model is already fine-grained.

### State and Reactivity

The core primitive is `track`:

```typescript
import { track } from 'ripple';

component Counter() {
  let &[count] = track(0);

  <button onClick={() => count++}>
    Clicks: {count}
  </button>
}
```

The `&[count]` syntax is **lazy destructuring**. It reads like a normal destructuring pattern (`let [count]`) but the `&` tells the compiler that `count` is a reactive binding. Reading `count` automatically subscribes the current reactive context, and writing `count = value` (or `count++`) triggers updates to every subscriber.

Internally,, `track(0)` returns a `Tracked<number>` object with a `.value` accessor. You can access it the long way:

```typescript
const counter = track(0);
counter.value++;
// and in JSX: {counter.value}
```

The lazy destructuring form is shorter and reads more like idiomatic JavaScript, but the explicit form preserves reactivity across function boundaries. In practice, use `&[]` for local reactive state and `.value` access when passing trackers to helper functions that the compiler cannot inline.

### Derived State

Derived values are just `track` calls that receive a function:

```typescript
component Summary() {
  let &[firstName] = track('Jane');
  let &[lastName]  = track('Doe');
  let &[fullName]  = track(() => firstName + ' ' + lastName);

  <p>Hello, {fullName}!</p>
}
```

The second form of `track` takes a function and creates a memoized derived value. Whenever `firstName` or `lastName` changes, `fullName` recomputes automatically. This replaces React's `useMemo` with dependency arrays.

### Reactive Collections

Ripple ships four reactive collection primitives that track mutation without requiring you to call a setter:

| Type | Stdlib analogue | Usage |
|------|----------------|-------|
| `RippleArray<T>` | `Array<T>` | Push, pop, splice, index assignment, all reactive |
| `RippleObject<T>` | `Record<string, T>` | Key get/set tracked |
| `RippleMap<K, V>` | `Map<K, V>` | Set, delete, clear tracked |
| `RippleSet<T>` | `Set<T>` | Add, delete, clear tracked |

Example:

```typescript
import { RippleArray } from 'ripple';

component TodoList() {
  const todos = new RippleArray<string>(['Buy milk', 'Write chapter']);

  <ul>
    for (const todo of todos) {
      <li>{todo}</li>
    }
  </ul>

  <button onClick={() => todos.push('New task')}>Add</button>
  <button onClick={() => todos.pop()}>Remove last</button>
}
```

Compare to React, where you would write `const [todos, setTodos] = useState([...])` and then `setTodos(prev => [...prev, 'New task'])` for every mutation. The Ripple form is shorter and matches how JavaScript developers already think about arrays.

### Control Flow Inside the Template

Ripple does not invent new directives. It uses native JavaScript control flow inside the component body, and the compiler turns those constructs into fine-grained reactive updates:

```typescript
component UserCard(props: { user: User | null; loading: boolean }) {
  if (props.loading) {
    <div class="skeleton">Loading...</div>
  } else if (props.user) {
    <div class="card">
      <h2>{props.user.name}</h2>
      <p>{props.user.email}</p>
    </div>
  } else {
    <div class="empty">No user selected</div>
  }
}
```

### Error Boundaries Without Extra API

Because Ripple uses native `try/catch`, error boundaries fall out naturally:

```typescript
component SafeUserCard(props: { userId: string }) {
  try {
    <UserCard userId={props.userId} />
  } catch (error) {
    <div class="error">
      Something went wrong: {error.message}
    </div>
  }
}
```

React needs class components or `react-error-boundary` for the same pattern. Ripple's approach matches how JavaScript developers already think about error handling.

### Scoped CSS

Ripple supports scoped CSS at the component level. Styles defined inside a component apply only to that component's DOM, without BEM discipline or CSS modules build setup:

```typescript
component Card() {
  <style>
    .card {
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 16px;
    }
  </style>

  <div class="card">
    <slot />
  </div>
}
```

This matches Svelte's scoped-CSS approach and removes one of the largest classes of CSS-specificity bugs in production SPAs.

### Junior → FAANG: Building Mental Models for Reactive Primitives

The hardest conceptual jump when moving from React to a fine-grained reactive framework is that there is no longer a "render function" that runs top-to-bottom on every state change. In React, you can read your component like a recipe: every render, the whole function runs, and you get new output. In Ripple, the component body runs once during initialization, and after that, only the specific DOM mutations whose reactive source changed execute again.

The practical consequence: reading a Ripple component is not the same as tracing a React render. You have to follow the reactive graph, not the call stack. To build that skill, work through these exercises before going further.

Exercise one: in the `Counter` component, what exactly updates when `count` increments? Answer: only the text node `Clicks: {count}`. The `<button>` element itself does not re-render. The `onClick` handler is the same function reference it was on initialization.

Exercise two: in the `Summary` component, what triggers `fullName` to recompute? Answer: any write to `firstName` or `lastName`. The `track(() => firstName + ' ' + lastName)` call establishes subscriptions at initialization time by reading both trackers.

Exercise three: why does `RippleArray.push` trigger an update but `Array.push` on a plain array inside a component would not? Answer: `RippleArray` wraps the mutation methods to notify subscribers. A plain `Array` has no notification mechanism.

Getting these three right is the entry-level signal for a Ripple (or any fine-grained reactive) interview question. The follow-up question is always: "What happens if you pass a `Tracked<T>` into a helper function that reads `.value` after an `await`?" That leads directly into the async-boundary reactivity section in Chapter 53B.5.

### Senior @ FAANG: Component Model as API Contract and Platform Boundary

The `component` keyword is not just syntactic sugar. It is a compiler-enforced boundary that separates reactive context from non-reactive code. That boundary has architectural implications that are invisible at small scale and highly visible at platform scale.

Consider a large SPA with 300 components across 8 product teams. In React, any function that follows the rules of hooks is effectively a component. The distinction between a "hook" and a "utility function" is a convention, not an enforcement. Lint rules enforce naming (`use` prefix) but do not prevent teams from calling hooks from non-hook contexts at runtime. The result is that the component model is porous: a utility library author who adds a `useState` call has silently changed the calling requirements of their function without a type error.

Ripple's `component` keyword changes this. The reactive context is lexically scoped to the `component` body. A function outside a `component` block that tries to read a tracked value will get the value but will not subscribe, and the compiler can warn. That boundary is enforceable at the type level, which means the platform team can write lint rules or static analysis to prevent the "utility function that secretly requires a reactive context" class of bug.

For senior engineers designing a component architecture: the lazy destructuring syntax (`&[count]`) is a visual marker of reactive bindings. At code review, any `&[]` outside a `component` block is an immediate question. Building a code-review checklist around these syntactic markers is faster than reading component logic line by line.

The scoped CSS section is also a platform concern. CSS specificity bugs in large SPAs are not random. They are systemic. They emerge from the gap between component-scoped CSS intent and global CSS output. Ripple's scoped CSS eliminates the gap by design. If you are a platform engineer migrating a legacy SPA to Ripple, the CSS migration order matters: migrate leaf components first, build system-of-record styles inside those components, and then progressively remove the global stylesheet rather than maintaining both in parallel. Running both in parallel for more than one release cycle guarantees specificity conflicts.

The derived-state pattern with `track(() => ...)` replacing `useMemo` with dependency arrays is a correctness improvement that has governance implications. React's `useMemo` is frequently misused in two ways: used when not needed (premature optimization) and omitted when needed (correctness bug from stale closures). Because Ripple's derived state is always a subscription and never a manual dependency list, the correctness failure mode disappears. The performance question (is this derived value computed too often?) becomes the only remaining question, and the answer is always "it recomputes exactly as often as its sources change." That determinism is what makes derived state in Ripple safe to delegate to junior engineers without the "you forgot a dependency" code-review tax.

---
