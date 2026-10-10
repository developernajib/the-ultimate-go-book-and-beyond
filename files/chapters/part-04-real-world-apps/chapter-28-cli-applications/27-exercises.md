## Exercises

These exercises build on the patterns covered in this chapter. The first focuses on structured subcommands with persistent storage, the most common type of internal tool. The second builds an interactive REPL, which requires readline integration and runtime command dispatch.

### Exercise 1: Build a Complete Task Manager CLI

Create a task management CLI with full CRUD operations.

**Requirements:**
- Commands: add, list, done, delete, edit
- Persistent storage (JSON/SQLite)
- Multiple output formats
- Due date support with filtering

**Solution:**

```go
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// Task represents a todo item
type Task struct {
	ID          int       `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Done        bool      `json:"done"`
	DueDate     time.Time `json:"due_date,omitempty"`
	Priority    int       `json:"priority"`
	Tags        []string  `json:"tags,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	CompletedAt time.Time `json:"completed_at,omitempty"`
}

// TaskStore manages task persistence
type TaskStore struct {
	path  string
	tasks []Task
}

func NewTaskStore() *TaskStore {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, ".tasks.json")
	store := &TaskStore{path: path}
	store.load()
	return store
}

func (s *TaskStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	json.Unmarshal(data, &s.tasks)
}

func (s *TaskStore) save() error {
	data, err := json.MarshalIndent(s.tasks, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0644)
}

func (s *TaskStore) Add(title string, opts ...TaskOption) *Task {
	task := &Task{
		ID:        s.nextID(),
		Title:     title,
		CreatedAt: time.Now(),
		Priority:  2, // Default medium priority
	}

	for _, opt := range opts {
		opt(task)
	}

	s.tasks = append(s.tasks, *task)
	s.save()
	return task
}

func (s *TaskStore) nextID() int {
	max := 0
	for _, t := range s.tasks {
		if t.ID > max {
			max = t.ID
		}
	}
	return max + 1
}

func (s *TaskStore) List(filter TaskFilter) []Task {
	var result []Task
	for _, t := range s.tasks {
		if filter(t) {
			result = append(result, t)
		}
	}
	return result
}

func (s *TaskStore) Get(id int) *Task {
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			return &s.tasks[i]
		}
	}
	return nil
}

func (s *TaskStore) Complete(id int) error {
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			s.tasks[i].Done = true
			s.tasks[i].CompletedAt = time.Now()
			return s.save()
		}
	}
	return fmt.Errorf("task %d not found", id)
}

func (s *TaskStore) Delete(id int) error {
	for i := range s.tasks {
		if s.tasks[i].ID == id {
			s.tasks = append(s.tasks[:i], s.tasks[i+1:]...)
			return s.save()
		}
	}
	return fmt.Errorf("task %d not found", id)
}

type TaskOption func(*Task)
type TaskFilter func(Task) bool

func WithDueDate(d time.Time) TaskOption {
	return func(t *Task) { t.DueDate = d }
}

func WithPriority(p int) TaskOption {
	return func(t *Task) { t.Priority = p }
}

func WithTags(tags []string) TaskOption {
	return func(t *Task) { t.Tags = tags }
}

func AllTasks(t Task) bool { return true }

func PendingTasks(t Task) bool { return !t.Done }

func CompletedTasks(t Task) bool { return t.Done }

func DueToday(t Task) bool {
	if t.Done || t.DueDate.IsZero() {
		return false
	}
	now := time.Now()
	return t.DueDate.Year() == now.Year() &&
		t.DueDate.YearDay() == now.YearDay()
}

func Overdue(t Task) bool {
	if t.Done || t.DueDate.IsZero() {
		return false
	}
	return t.DueDate.Before(time.Now())
}

// CLI Implementation
var (
	store      *TaskStore
	outputFmt  string
	showAll    bool
	dueFilter  string
	tagFilter  string
)

func main() {
	store = NewTaskStore()

	rootCmd := &cobra.Command{
		Use:   "task",
		Short: "A simple task manager",
	}

	rootCmd.PersistentFlags().StringVarP(&outputFmt, "output", "o", "table", "Output format")

	// Add command
	addCmd := &cobra.Command{
		Use:   "add [title]",
		Short: "Add a new task",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			title := strings.Join(args, " ")
			var opts []TaskOption

			if due, _ := cmd.Flags().GetString("due"); due != "" {
				d, err := parseDate(due)
				if err != nil {
					return err
				}
				opts = append(opts, WithDueDate(d))
			}

			if priority, _ := cmd.Flags().GetInt("priority"); priority > 0 {
				opts = append(opts, WithPriority(priority))
			}

			if tags, _ := cmd.Flags().GetStringSlice("tags"); len(tags) > 0 {
				opts = append(opts, WithTags(tags))
			}

			task := store.Add(title, opts...)
			fmt.Printf("Created task #%d: %s\n", task.ID, task.Title)
			return nil
		},
	}
	addCmd.Flags().StringP("due", "d", "", "Due date (today, tomorrow, YYYY-MM-DD)")
	addCmd.Flags().IntP("priority", "p", 2, "Priority (1=high, 2=medium, 3=low)")
	addCmd.Flags().StringSliceP("tags", "t", nil, "Tags")

	// List command
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List tasks",
		RunE: func(cmd *cobra.Command, args []string) error {
			filter := selectFilter()
			tasks := store.List(filter)

			// Sort by priority then due date
			sort.Slice(tasks, func(i, j int) bool {
				if tasks[i].Priority != tasks[j].Priority {
					return tasks[i].Priority < tasks[j].Priority
				}
				return tasks[i].DueDate.Before(tasks[j].DueDate)
			})

			return printTasks(tasks)
		},
	}
	listCmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show all tasks including completed")
	listCmd.Flags().StringVar(&dueFilter, "due", "", "Filter by due (today, overdue, week)")
	listCmd.Flags().StringVar(&tagFilter, "tag", "", "Filter by tag")

	// Done command
	doneCmd := &cobra.Command{
		Use:   "done [id]",
		Short: "Mark task as done",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, _ := strconv.Atoi(args[0])
			if err := store.Complete(id); err != nil {
				return err
			}
			fmt.Printf("Completed task #%d\n", id)
			return nil
		},
	}

	// Delete command
	deleteCmd := &cobra.Command{
		Use:   "delete [id]",
		Short: "Delete a task",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id, _ := strconv.Atoi(args[0])
			if err := store.Delete(id); err != nil {
				return err
			}
			fmt.Printf("Deleted task #%d\n", id)
			return nil
		},
	}

	rootCmd.AddCommand(addCmd, listCmd, doneCmd, deleteCmd)

	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func selectFilter() TaskFilter {
	if showAll {
		return AllTasks
	}

	switch dueFilter {
	case "today":
		return DueToday
	case "overdue":
		return Overdue
	default:
		return PendingTasks
	}
}

func printTasks(tasks []Task) error {
	if outputFmt == "json" {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(tasks)
	}

	if len(tasks) == 0 {
		fmt.Println("No tasks found.")
		return nil
	}

	fmt.Printf("%-4s %-5s %-40s %-12s %s\n", "ID", "DONE", "TITLE", "DUE", "TAGS")
	fmt.Println(strings.Repeat("-", 80))

	for _, t := range tasks {
		done := " "
		if t.Done {
			done = "✓"
		}

		due := ""
		if !t.DueDate.IsZero() {
			due = t.DueDate.Format("2006-01-02")
			if Overdue(t) {
				due = "\033[31m" + due + "\033[0m" // Red for overdue
			}
		}

		tags := strings.Join(t.Tags, ", ")

		fmt.Printf("%-4d [%s]  %-40s %-12s %s\n", t.ID, done, truncate(t.Title, 40), due, tags)
	}

	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-3] + "..."
}

func parseDate(s string) (time.Time, error) {
	now := time.Now()
	switch s {
	case "today":
		return time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 0, now.Location()), nil
	case "tomorrow":
		tomorrow := now.AddDate(0, 0, 1)
		return time.Date(tomorrow.Year(), tomorrow.Month(), tomorrow.Day(), 23, 59, 59, 0, now.Location()), nil
	default:
		return time.Parse("2006-01-02", s)
	}
}
```

### Exercise 2: Build an Interactive REPL

Create a REPL shell with history, completions, and help.

**Solution:**

```go
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/chzyer/readline"
)

type REPL struct {
	rl       *readline.Instance
	commands map[string]Command
	history  []string
}

type Command struct {
	Name        string
	Description string
	Handler     func(args []string) error
	Completer   func(line string) []string
}

func NewREPL() (*REPL, error) {
	r := &REPL{
		commands: make(map[string]Command),
	}

	// Register built-in commands
	r.RegisterCommand(Command{
		Name:        "help",
		Description: "Show help for commands",
		Handler: func(args []string) error {
			if len(args) > 0 {
				if cmd, ok := r.commands[args[0]]; ok {
					fmt.Printf("%s - %s\n", cmd.Name, cmd.Description)
					return nil
				}
				return fmt.Errorf("unknown command: %s", args[0])
			}

			fmt.Println("Available commands:")
			for name, cmd := range r.commands {
				fmt.Printf("  %-15s %s\n", name, cmd.Description)
			}
			return nil
		},
	})

	r.RegisterCommand(Command{
		Name:        "exit",
		Description: "Exit the REPL",
		Handler: func(args []string) error {
			fmt.Println("Goodbye!")
			os.Exit(0)
			return nil
		},
	})

	r.RegisterCommand(Command{
		Name:        "history",
		Description: "Show command history",
		Handler: func(args []string) error {
			for i, cmd := range r.history {
				fmt.Printf("%4d  %s\n", i+1, cmd)
			}
			return nil
		},
	})

	// Create readline instance
	completer := readline.NewPrefixCompleter(r.buildCompleter()...)

	rl, err := readline.NewEx(&readline.Config{
		Prompt:            "> ",
		HistoryFile:       "/tmp/.myrepl_history",
		AutoComplete:      completer,
		InterruptPrompt:   "^C",
		EOFPrompt:         "exit",
		HistorySearchFold: true,
	})
	if err != nil {
		return nil, err
	}

	r.rl = rl
	return r, nil
}

func (r *REPL) buildCompleter() []readline.PrefixCompleterInterface {
	var items []readline.PrefixCompleterInterface
	for name := range r.commands {
		items = append(items, readline.PcItem(name))
	}
	return items
}

func (r *REPL) RegisterCommand(cmd Command) {
	r.commands[cmd.Name] = cmd
}

func (r *REPL) Run() {
	defer r.rl.Close()

	fmt.Println("Welcome to MyREPL. Type 'help' for available commands.")

	for {
		line, err := r.rl.Readline()
		if err != nil { // EOF or interrupt
			break
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		r.history = append(r.history, line)

		parts := strings.Fields(line)
		cmdName := parts[0]
		args := parts[1:]

		if cmd, ok := r.commands[cmdName]; ok {
			if err := cmd.Handler(args); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			}
		} else {
			fmt.Fprintf(os.Stderr, "Unknown command: %s. Type 'help' for available commands.\n", cmdName)
		}
	}
}

func main() {
	repl, err := NewREPL()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Register custom commands
	repl.RegisterCommand(Command{
		Name:        "echo",
		Description: "Echo arguments back",
		Handler: func(args []string) error {
			fmt.Println(strings.Join(args, " "))
			return nil
		},
	})

	repl.RegisterCommand(Command{
		Name:        "calc",
		Description: "Simple calculator (add, sub, mul, div)",
		Handler: func(args []string) error {
			if len(args) != 3 {
				return fmt.Errorf("usage: calc <num1> <op> <num2>")
			}
			a, _ := strconv.ParseFloat(args[0], 64)
			b, _ := strconv.ParseFloat(args[2], 64)

			var result float64
			switch args[1] {
			case "+", "add":
				result = a + b
			case "-", "sub":
				result = a - b
			case "*", "mul":
				result = a * b
			case "/", "div":
				if b == 0 {
					return fmt.Errorf("division by zero")
				}
				result = a / b
			default:
				return fmt.Errorf("unknown operator: %s", args[1])
			}

			fmt.Printf("%.2f\n", result)
			return nil
		},
	})

	repl.Run()
}
```

Both exercises can be extended further: add `--output json` support to the task manager, implement tab-completion for task IDs in the REPL, or add signal handling for graceful shutdown.

### Junior to FAANG: working through these exercises

Exercise 1 teaches persistence, subcommand wiring, filtering, and output formatting. Do not copy the solution. Type it out, run it, break it, fix it. Stretch goals that cement the learning. Add a `--output=json` mode with a versioned envelope. Add golden file tests for the table output. Add a `--config` flag to change the store location. Handle the store file being locked by another process. Add Ctrl+C handling that flushes the store before exit.

Bug in the solution that you should find and fix. `os.WriteFile(s.path, data, 0644)` is too permissive for a user file that may contain sensitive task data. Should be 0600. The save is not atomic. A crash mid-write truncates the file. Use `renameio` or equivalent to write atomically.

Exercise 2 teaches REPL loops, readline integration, dynamic dispatch, and history. Stretch goals. Add persistent history across sessions. Add tab completion for arguments, not just commands. Add multi-line input with line continuation. Add syntax highlighting on the prompt. Add `!prefix` history recall like bash.

Both exercises are interview-scale problems. You should be able to produce exercise 1 in 45 minutes from a blank editor if asked. Exercise 2 in 60 minutes. Practice until you can.

Interview entry point. "Design a task manager CLI." This is a common onsite question. Structure the answer. Commands (add, list, done, delete, edit). Storage (JSON for simplicity, migrate to SQLite when scale demands). Output formats (table, JSON, YAML). Config (XDG compliant location). Error handling (typed errors with exit codes). Testing strategy (unit tests on store, golden tests on output). Delivery this list in 90 seconds and then dive into implementation.

### Senior at FAANG: exercises reframed at staff level

Staff engineers do not write task managers from scratch. They review them. Take the exercise 1 solution and write a staff-level code review. Here is what you would flag.

Global state. `store`, `outputFmt`, `showAll` as package-level vars prevents concurrent testing and makes refactoring fragile. Refactor. Inject dependencies into command constructors.

Error handling. `strconv.Atoi(args[0])` ignores the error. A non-numeric ID silently becomes 0, which may match an existing task or fail inscrutably. Wrap with validation.

Output contracts. The JSON emitter lacks an envelope and schema version. Add `{"apiVersion": "task.v1", "kind": "TaskList", "items": [...]}`. Version the schema. Test it.

Concurrency. Two invocations of `task add` race on the file. Use file locking (`flock` on Unix) or atomic rename pattern. Without it, one task is lost occasionally.

Permissions. `0644` leaks task contents to other users on multi-user systems. Use `0600`.

Color leakage. The `\033[31m` for overdue leaks into pipes. Gate on TTY. Respect `NO_COLOR`.

Signal handling. No cleanup on Ctrl+C. A save in progress is interrupted. Add signal handler that waits for in-flight writes.

Internationalization. Dates hardcoded to `2006-01-02`. Users in some locales prefer `02/01/2006`. Accept both on input, emit ISO on output (with a flag for locale-specific display).

Telemetry gaps. No instrumentation of which commands are run, no error categorization, no duration tracking. Add structured logging to `$XDG_STATE_HOME/task/log.jsonl`.

Testing gaps. No tests at all. Write. Unit tests for the store. Cobra tests for each command. Integration tests against the compiled binary. Golden file tests for table and JSON output. Race detection. Fault injection for corrupted store file.

Distribution. The example has no GoReleaser config, no signing, no packaging. In a staff PR review, you would block until these exist.

Staff engineer exercise. Take this review list and produce an RFC titled "Task Manager CLI v2 refactor." Scope, timeline, rollback plan, telemetry plan, migration plan for existing users. Review in a design doc meeting. Execute over 3 sprints. This is what staff engineers actually do with exercise-scale code.

Multi-year thinking. After task manager v2 ships, what is v3. Maybe a sync layer with a cloud backend. Maybe plugins for integrations (GitHub issues, Jira). Maybe a TUI mode with Bubble Tea. Each is an RFC, a quarter of work, a rollout plan, a deprecation of v2 features. Staff engineers write roadmaps spanning multiple versions.

REPL exercise at staff level. When should a tool have a REPL versus one-shot commands. Answer. REPL is appropriate when the session has persistent state (connected to a database, stateful protocol). One-shot is appropriate when every invocation is independent. `mysql` has a REPL because the connection is stateful. `kubectl` does not because every command is independent. Writing a REPL is easy. Knowing when not to is the staff skill.

Final exercise for staff practice. Audit any real-world CLI you use. `docker`, `kubectl`, `gh`, `aws`, `gcloud`. For each, list three design decisions you agree with, three you disagree with, and the ADR you would write to change one of the disagreements. This is the staff exercise that sharpens taste and judgment better than any code kata.

