## 118D.7 AI for Learning & Skill Development

### Learning a New Go Package in 10 Minutes with AI

One of AI's most transformative uses is as a learning accelerator. Instead of spending 30 minutes reading documentation and 30 minutes writing exploratory code, you can have a focused conversation with AI that gives you working mental models in 10 minutes.

**Template: Package Learning Prompt**

```
Teach me the Go [package name] package. I'm a [level] Go developer.

In this order:
1. What problem does this package solve? (2 sentences)
2. Show me the 3 most important types/functions with a one-line explanation each
3. Give me a complete, runnable "hello world" example (< 30 lines)
4. Show me the most common real-world usage pattern (production-quality)
5. What are the 3 most common mistakes people make with this package?
6. What should I learn NEXT after understanding the basics?

Keep examples minimal but complete: they should compile and run.
```

### Example: Learning the `reflect` Package Through AI Dialogue

Reflection allows Go programs to inspect and manipulate types and values at runtime, enabling generic serialization frameworks and meta-programming. It should be used sparingly because it bypasses compile-time type safety and incurs measurable runtime overhead.

```
ENGINEER: Teach me Go's reflect package. I'm a mid-level Go engineer
who understands interfaces and type assertions but has never used
reflect.

AI:

1. WHAT IT SOLVES: The reflect package lets you inspect and manipulate
Go values at runtime when you don't know the types at compile time.
It's how encoding/json, database/sql, and testing frameworks work
with arbitrary user types.

2. KEY TYPES AND FUNCTIONS:
- reflect.TypeOf(x) - returns the Type of x (like reading a
  blueprint: what fields, methods, and kind is this?)
- reflect.ValueOf(x) - returns the Value of x (like holding the
  actual object: you can read fields, call methods, and modify it)
- reflect.Kind - an enum that tells you the underlying type category
  (Struct, Slice, Map, Ptr, etc.)

3. HELLO WORLD:
```

```go
package main

import (
	"fmt"
	"reflect"
)

type User struct {
	Name  string `json:"name" validate:"required"`
	Email string `json:"email" validate:"email"`
	Age   int    `json:"age"   validate:"min=0,max=150"`
}

func main() {
	u := User{Name: "Alice", Email: "alice@example.com", Age: 30}

	t := reflect.TypeOf(u)
	v := reflect.ValueOf(u)

	fmt.Printf("Type: %s, Kind: %s\n", t.Name(), t.Kind())

	for i := range t.NumField() {
		field := t.Field(i)
		value := v.Field(i)
		tag := field.Tag.Get("validate")
		fmt.Printf("  %s (%s) = %v [validate: %s]\n",
			field.Name, field.Type, value, tag)
	}
}
```

**AI (continued): a production pattern, struct tag-based validation.**

```go
package main

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"
)

// Validate checks struct fields against their `validate` tags.
// Supports: required, min=N, max=N for int fields.
func Validate(v any) []string {
	val := reflect.ValueOf(v)
	typ := val.Type()

	// Handle pointer types by dereferencing.
	if val.Kind() == reflect.Ptr {
		if val.IsNil() {
			return []string{"value is nil"}
		}
		val = val.Elem()
		typ = val.Type()
	}

	if val.Kind() != reflect.Struct {
		return []string{"expected a struct"}
	}

	var errors []string

	for i := range typ.NumField() {
		field := typ.Field(i)
		fieldVal := val.Field(i)
		tag := field.Tag.Get("validate")

		if tag == "" {
			continue
		}

		rules := strings.Split(tag, ",")
		for _, rule := range rules {
			if err := applyRule(field.Name, fieldVal, rule); err != "" {
				errors = append(errors, err)
			}
		}
	}

	return errors
}

func applyRule(fieldName string, val reflect.Value, rule string) string {
	switch {
	case rule == "required":
		if val.IsZero() {
			return fmt.Sprintf("%s is required", fieldName)
		}

	case strings.HasPrefix(rule, "min="):
		minStr := strings.TrimPrefix(rule, "min=")
		minVal, _ := strconv.ParseInt(minStr, 10, 64)
		if val.Kind() == reflect.Int && val.Int() < minVal {
			return fmt.Sprintf("%s must be at least %d", fieldName, minVal)
		}

	case strings.HasPrefix(rule, "max="):
		maxStr := strings.TrimPrefix(rule, "max=")
		maxVal, _ := strconv.ParseInt(maxStr, 10, 64)
		if val.Kind() == reflect.Int && val.Int() > maxVal {
			return fmt.Sprintf("%s must be at most %d", fieldName, maxVal)
		}
	}

	return ""
}

func main() {
	type Registration struct {
		Username string `validate:"required"`
		Email    string `validate:"required"`
		Age      int    `validate:"required,min=13,max=150"`
	}

	// Valid registration.
	valid := Registration{Username: "alice", Email: "alice@test.com", Age: 25}
	fmt.Println("Valid:", Validate(valid))

	// Invalid registration.
	invalid := Registration{Username: "", Email: "", Age: 5}
	fmt.Println("Invalid:", Validate(invalid))
}
```

### Understanding Unfamiliar Codebases (Joining a New Team)

When joining a new team or inheriting a codebase, AI can dramatically accelerate your ramp-up.

**Template: Codebase Understanding Prompt**

````
I just joined a team and need to understand this Go codebase. Here's
the project structure:

```
[paste tree or ls output]
```

And here's the main entry point:

```text
[paste main.go or the primary entry point]
```

Please:
1. What does this application do? (based on the structure and entry point)
2. What's the architecture pattern? (layered, hexagonal, MVC, etc.)
3. Draw me a dependency graph of the key packages
4. What are the 5 files I should read first to understand the system?
5. What external services does it depend on?
6. What testing patterns does it use?

Mark anything you are inferring from naming conventions rather than
reading directly, so I know which claims to verify first.
````

### Study Techniques: Socratic Method with AI

Instead of asking AI to explain a concept, ask it to test your understanding through questions.

**Template: Socratic Learning Prompt**

```
I want to deeply understand [concept] in Go. Instead of explaining it
to me, test my understanding through the Socratic method.

1. Ask me a question about [concept]
2. I'll answer
3. Correct any misconceptions and ask a follow-up that goes deeper
4. Continue until we've covered: [list specific subtopics]

Start with the most fundamental question and build up to advanced
edge cases. If I'm wrong, explain WHY I'm wrong before moving on.

My current understanding: [describe what you think you know]
```

> **What AI Gets Wrong**: When teaching, AI sometimes oversimplifies in ways that create false mental models. For example, it might describe channels as "like thread-safe queues" which is mostly right but misses that channels are also synchronization primitives. Ask AI to point out where its analogies break down: "Where does this analogy fail? What does this simplification miss?"

> **Pro Tip**: The fastest way to learn a new library is to tell AI your specific use case and ask for a working example that matches YOUR context, not a generic tutorial example. "Show me how to use `pgx` with connection pooling for a service that handles 500 queries/second" teaches you more in 5 minutes than reading generic docs for 30 minutes.

### Junior → FAANG: AI-Accelerated Learning as Career Velocity

The context-specific learning prompt ("how to use pgx for a service that handles 500 queries/second") is a metacognitive skill: knowing what context to provide to get learning material that is directly applicable to your situation. Generic tutorials teach generic patterns. Context-specific examples teach patterns that match your actual constraints. The engineer who learns pgx through a 500 req/sec connection pooling example understands pool sizing, connection lifetime management, and query timeout configuration as a coherent set. The engineer who learns through a generic "hello world" example understands only the basic API.

The "where does this analogy fail?" follow-up prompt is a critical thinking practice that FAANG engineers are expected to apply to all explanations, not just AI explanations. When someone says "channels are like thread-safe queues," asking where the analogy breaks down prevents the false mental model that channels are only for data transfer (they are also for synchronization). This habit of probing analogies for their limits is the intellectual rigor that distinguishes deep understanding from surface familiarity, and it is the same rigor that senior FAANG engineers apply in technical discussions.

For interview preparation specifically, context-specific learning prompts are the fastest way to learn the Go standard library sections that appear in FAANG coding interviews. "Show me how to implement a concurrent worker pool with configurable pool size, graceful shutdown, and error propagation for each worker" is a context-specific learning prompt that teaches goroutine lifecycle management in a form directly applicable to interview problems.

### Senior @ FAANG: AI-Accelerated Learning as Team Onboarding Platform

At senior level, the context-specific learning prompt pattern is a team onboarding accelerator. New engineers who join a team need to learn the team's specific technology stack (pgx with the team's specific connection pool configuration, chi with the team's specific middleware chain, testcontainers with the team's specific container lifecycle management) rather than generic patterns. Building a set of context-specific learning prompts for the team's most commonly needed skills, and including them in the onboarding documentation, reduces the time for new engineers to become productive from weeks to days.

The "analogies break down" follow-up also applies to organizational technical communication. When a staff engineer describes a new system using an analogy ("it's like a load balancer, but for AI requests"), asking "where does this analogy fail?" prevents the team from building incorrect mental models of the new system. Encouraging this kind of critical probing of analogies in design reviews and technical discussions is an organizational culture contribution that improves the quality of technical decision-making by ensuring that decisions are based on accurate understanding rather than convenient simplifications.

---
