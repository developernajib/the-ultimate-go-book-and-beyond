export default `## 2.8 Putting It All Together

The following program brings together every concept from this chapter. It's a contact book CLI tool that stores contacts in memory:

\`\`\`go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"
)

// Contact represents a person in the contact book
type Contact struct {
    Name  string
    Email string
    Phone string
}

// ContactBook holds all contacts and provides operations on them
type ContactBook struct {
    contacts []Contact
}

// NewContactBook creates an empty contact book
func NewContactBook() *ContactBook {
    return &ContactBook{
        contacts: make([]Contact, 0),
    }
}

// Add inserts a new contact into the book
func (cb *ContactBook) Add(name, email, phone string) {
    contact := Contact{
        Name:  name,
        Email: email,
        Phone: phone,
    }
    cb.contacts = append(cb.contacts, contact)
    fmt.Printf("Added: %s\\n", name)
}

// Search finds contacts whose name contains the query (case-insensitive)
func (cb *ContactBook) Search(query string) []Contact {
    results := make([]Contact, 0)
    query = strings.ToLower(query)

    for _, c := range cb.contacts {
        if strings.Contains(strings.ToLower(c.Name), query) {
            results = append(results, c)
        }
    }
    return results
}

// List prints all contacts
func (cb *ContactBook) List() {
    if len(cb.contacts) == 0 {
        fmt.Println("No contacts yet.")
        return
    }

    fmt.Printf("\\n%-20s %-25s %-15s\\n", "Name", "Email", "Phone")
    fmt.Println(strings.Repeat("-", 60))

    for _, c := range cb.contacts {
        fmt.Printf("%-20s %-25s %-15s\\n", c.Name, c.Email, c.Phone)
    }
    fmt.Println()
}

// Count returns the number of contacts
func (cb *ContactBook) Count() int {
    return len(cb.contacts)
}

func main() {
    book := NewContactBook()
    scanner := bufio.NewScanner(os.Stdin)

    fmt.Println("Contact Book, type 'help' for commands")

    for {
        fmt.Print("> ")
        if !scanner.Scan() {
            break
        }

        input := strings.TrimSpace(scanner.Text())
        if input == "" {
            continue
        }

        parts := strings.SplitN(input, " ", 2)
        command := strings.ToLower(parts[0])

        switch command {
        case "add":
            fmt.Print("Name: ")
            scanner.Scan()
            name := strings.TrimSpace(scanner.Text())

            fmt.Print("Email: ")
            scanner.Scan()
            email := strings.TrimSpace(scanner.Text())

            fmt.Print("Phone: ")
            scanner.Scan()
            phone := strings.TrimSpace(scanner.Text())

            if name == "" {
                fmt.Println("Error: name cannot be empty")
                continue
            }

            book.Add(name, email, phone)

        case "list":
            book.List()

        case "search":
            if len(parts) < 2 {
                fmt.Println("Usage: search <query>")
                continue
            }
            results := book.Search(parts[1])
            if len(results) == 0 {
                fmt.Printf("No contacts matching '%s'\\n", parts[1])
            } else {
                fmt.Printf("Found %d contact(s):\\n", len(results))
                for _, c := range results {
                    fmt.Printf("  %s, %s, %s\\n", c.Name, c.Email, c.Phone)
                }
            }

        case "count":
            fmt.Printf("%d contact(s)\\n", book.Count())

        case "help":
            fmt.Println("Commands: add, list, search <query>, count, quit")

        case "quit", "exit":
            fmt.Println("Goodbye!")
            return

        default:
            fmt.Printf("Unknown command: %s (type 'help')\\n", command)
        }
    }
}
\`\`\`

**Run it:**

\`\`\`bash
\$ go run main.go
Contact Book, type 'help' for commands
> add
Name: Alice Johnson
Email: alice@example.com
Phone: 555-0101
Added: Alice Johnson
> add
Name: Bob Smith
Email: bob@example.com
Phone: 555-0102
Added: Bob Smith
> list

Name                 Email                     Phone
------------------------------------------------------------
Alice Johnson        alice@example.com         555-0101
Bob Smith            bob@example.com           555-0102

> search alice
Found 1 contact(s):
  Alice Johnson, alice@example.com, 555-0101
> quit
Goodbye!
\`\`\`

**What this program demonstrates:**
- Package structure and imports
- Structs with methods (value and pointer receivers)
- Slices (dynamic contact list)
- Maps concepts (would use for fast lookup in a real app)
- Control flow (for loop, switch, if/else)
- Error handling (input validation)
- String operations from the standard library
- The constructor pattern (\`NewContactBook\`)

You now have enough Go to read and understand the rest of this book. The next chapter covers the mental model shifts experienced developers need to make, and Chapter 4 explores Go's type system in depth.

### Read the Code Like a Reviewer

The contact book program above is intentionally idiomatic but it is not production-grade. A senior reviewer would flag at least the following before merging it. Working through these is the most efficient way to internalise the gap between "compiles and runs" and "ready for the world".

1. **No persistence.** The program loses every contact on exit. The next iteration would either serialise to JSON on every mutation or back the \`ContactBook\` with a small embedded database (\`bbolt\`, \`badger\`, or SQLite via \`modernc.org/sqlite\`). The choice is a function of the workload. For a CLI used by one user, JSON is fine. For a long-running service, even an in-process database is more honest than ad-hoc file IO.
2. **\`Search\` is O(n) over a slice.** For a few hundred contacts this is invisible. For a hundred thousand it becomes the user-perceived bottleneck. A real implementation would maintain a secondary index, either a \`map[string][]int\` of lower-cased name tokens to contact indexes, or an inverted index for substring matching, or delegate to a real search library. The point of bringing this up at the syntax level is not to write the index here. It is to notice that the data structure choice is the design decision, and the rest is implementation.
3. **No concurrency safety.** \`ContactBook\` would not survive concurrent calls to \`Add\` from two goroutines. As written it is fine because \`main\` uses it from one goroutine, but the moment a second goroutine appears (an HTTP handler, a background sync, a periodic flush), the unprotected slice mutation becomes a data race. The fix in idiomatic Go is to either guard the contacts slice with a \`sync.Mutex\` field or refactor the API to communicate through a channel. Concurrency is Chapter 7. The point here is that the data structure on its own does not declare its threading expectations and the reader has to infer them from usage.
4. **\`bufio.Scanner\` has a default buffer limit.** A line longer than 64KB makes \`Scanner.Scan\` return false silently with \`Scanner.Err()\` returning \`bufio.ErrTooLong\`. This program never checks \`scanner.Err()\` after the loop ends, so a too-long line ends the session with no diagnostic. Real input handling either reads with \`bufio.Reader.ReadString('\\n')\` (no length cap by default) or sets \`scanner.Buffer\` to an appropriate size and checks the error.
5. **Input validation.** The program checks that \`name\` is non-empty but allows any string for email and phone. A real version would validate email with a stricter regex or with \`net/mail.ParseAddress\`, and would normalise phone numbers with a library or with a deliberate canonicalisation pass. The validation pattern (validate at the boundary, store canonical form) is a recurring senior-level theme that this program intentionally simplifies for teaching.
6. **Error path returns.** The handlers \`continue\` on validation failure but never communicate error context to the user beyond the printed line. For a CLI this is acceptable. For a library function it would be wrong. The lesson is that the right error-handling shape is determined by the consumer, and a library that printed to stdout would be unusable from any caller.

### How to Reproduce This From a Blank File (Junior Track)

The single most useful exercise you can do with this program is to delete it and rewrite it from scratch in a fresh \`main.go\`, with no reference. The first attempt will probably take an hour and produce a program that does not compile. The second attempt, after looking up the parts you got wrong, will take 30 minutes. By the fourth attempt, you can do it in 15 minutes and the muscle memory of \`go mod init\`, \`package main\`, \`func main\`, struct definition, method receivers, and the scanner loop has internalised. This is the level of fluency a FAANG-entry phone screen for a Go-team role assumes you have. The first hour is the investment. The fluency is the dividend.

A useful variation when you reach the second or third repeat: change the storage. Re-implement \`ContactBook\` backed by a \`map[string]Contact\` keyed by name, and notice which methods change shape, which become simpler, and which become harder. Then try a \`map[string]*Contact\` and notice the difference. The reflection on which choice fits which question is itself the teaching surface that an interviewer will probe in the follow-up to "build me a contact book CLI".

### How to Use This in Onboarding (Senior Track)

For a Go onboarding programme, the contact book program is the right shape for a day-one or day-two exercise but not for week one's capstone. The day-one version is "type this in, run it, change two things, demo it". The week-one version is "extend this with persistence, validation, concurrency safety, and tests, and write a 500-word design note explaining your choices". The week-two version is "deploy it as an HTTP service behind a reverse proxy, add structured logging with \`log/slog\`, expose \`/healthz\` and \`/metrics\`, and write the runbook". The contact book is a vehicle, not the destination. Used at the right cadence it is one of the better Go onboarding artefacts because it is small enough to hold in your head and rich enough to teach every layer of the stack a Go service touches.
`;
