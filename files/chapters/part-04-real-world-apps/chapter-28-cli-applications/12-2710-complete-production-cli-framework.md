## 28.10 Complete Production CLI Framework

This section assembles the individual techniques from earlier sections into a complete, production-ready CLI framework. The code is organized into packages that you can adapt directly for your own tools.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
mycli/
├── cmd/
│   ├── root.go
│   ├── version.go
│   ├── config/
│   │   ├── config.go
│   │   ├── get.go
│   │   ├── set.go
│   │   └── list.go
│   └── completion.go
├── internal/
│   ├── config/
│   │   ├── config.go
│   │   └── xdg.go
│   ├── output/
│   │   ├── formatter.go
│   │   ├── colors.go
│   │   ├── table.go
│   │   └── progress.go
│   ├── prompt/
│   │   ├── input.go
│   │   └── confirm.go
│   └── version/
│       └── version.go
├── pkg/
│   └── api/
│       └── client.go
├── main.go
├── Makefile
├── Dockerfile
└── .goreleaser.yml
```

### internal/output/formatter.go - Output Formatter

The `Formatter` type centralizes all output rendering behind a single `Print(data)` call. It detects whether stdout is a terminal, respects the `NO_COLOR` convention, and switches between table, JSON, YAML, CSV, and plain text formats based on the `--output` flag. Functional options (`WithFormat`, `WithNoColor`, `WithWriter`) configure the formatter at construction time without bloating the constructor signature.

```go
package output

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"golang.org/x/term"
	"gopkg.in/yaml.v3"
)

// Format represents output format
type Format string

const (
	FormatTable Format = "table"
	FormatJSON  Format = "json"
	FormatYAML  Format = "yaml"
	FormatCSV   Format = "csv"
	FormatPlain Format = "plain"
)

// Formatter handles output formatting
type Formatter struct {
	writer      io.Writer
	errWriter   io.Writer
	format      Format
	noColor     bool
	width       int
	isTerminal  bool
}

// FormatterOption configures a Formatter
type FormatterOption func(*Formatter)

// WithFormat sets the output format
func WithFormat(format Format) FormatterOption {
	return func(f *Formatter) {
		f.format = format
	}
}

// WithNoColor disables colored output
func WithNoColor(noColor bool) FormatterOption {
	return func(f *Formatter) {
		f.noColor = noColor
	}
}

// WithWriter sets the output writer
func WithWriter(w io.Writer) FormatterOption {
	return func(f *Formatter) {
		f.writer = w
	}
}

// NewFormatter creates a new output formatter
func NewFormatter(opts ...FormatterOption) *Formatter {
	f := &Formatter{
		writer:    os.Stdout,
		errWriter: os.Stderr,
		format:    FormatTable,
		noColor:   os.Getenv("NO_COLOR") != "",
		width:     80,
	}

	// Check if stdout is a terminal
	if file, ok := f.writer.(*os.File); ok {
		f.isTerminal = term.IsTerminal(int(file.Fd()))
		if f.isTerminal {
			if width, _, err := term.GetSize(int(file.Fd())); err == nil {
				f.width = width
			}
		}
	}

	for _, opt := range opts {
		opt(f)
	}

	return f
}

// Print outputs data in the configured format
func (f *Formatter) Print(data any) error {
	switch f.format {
	case FormatJSON:
		return f.printJSON(data)
	case FormatYAML:
		return f.printYAML(data)
	case FormatCSV:
		return f.printCSV(data)
	case FormatPlain:
		return f.printPlain(data)
	default:
		return f.printTable(data)
	}
}

func (f *Formatter) printJSON(data any) error {
	enc := json.NewEncoder(f.writer)
	enc.SetIndent("", "  ")
	return enc.Encode(data)
}

func (f *Formatter) printYAML(data any) error {
	enc := yaml.NewEncoder(f.writer)
	enc.SetIndent(2)
	return enc.Encode(data)
}

func (f *Formatter) printCSV(data any) error {
	// Convert to [][]string for CSV output
	rows, err := toRows(data)
	if err != nil {
		return err
	}

	w := csv.NewWriter(f.writer)
	for _, row := range rows {
		if err := w.Write(row); err != nil {
			return err
		}
	}
	w.Flush()
	return w.Error()
}

func (f *Formatter) printPlain(data any) error {
	fmt.Fprintf(f.writer, "%v\n", data)
	return nil
}

func (f *Formatter) printTable(data any) error {
	rows, err := toRows(data)
	if err != nil {
		return err
	}

	if len(rows) == 0 {
		return nil
	}

	w := tabwriter.NewWriter(f.writer, 0, 0, 2, ' ', 0)

	// Print header with styling
	if len(rows) > 0 {
		header := rows[0]
		if f.isTerminal && !f.noColor {
			styledHeader := make([]string, len(header))
			for i, h := range header {
				styledHeader[i] = Bold + h + Reset
			}
			fmt.Fprintln(w, strings.Join(styledHeader, "\t"))
		} else {
			fmt.Fprintln(w, strings.Join(header, "\t"))
		}
	}

	// Print data rows
	for _, row := range rows[1:] {
		fmt.Fprintln(w, strings.Join(row, "\t"))
	}

	return w.Flush()
}

// Success prints a success message
func (f *Formatter) Success(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if f.isTerminal && !f.noColor {
		fmt.Fprintln(f.writer, Green+"✓ "+Reset+msg)
	} else {
		fmt.Fprintln(f.writer, "✓ "+msg)
	}
}

// Error prints an error message
func (f *Formatter) Error(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if f.isTerminal && !f.noColor {
		fmt.Fprintln(f.errWriter, Red+"✗ "+Reset+msg)
	} else {
		fmt.Fprintln(f.errWriter, "✗ "+msg)
	}
}

// Warning prints a warning message
func (f *Formatter) Warning(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if f.isTerminal && !f.noColor {
		fmt.Fprintln(f.errWriter, Yellow+"! "+Reset+msg)
	} else {
		fmt.Fprintln(f.errWriter, "! "+msg)
	}
}

// Info prints an info message
func (f *Formatter) Info(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if f.isTerminal && !f.noColor {
		fmt.Fprintln(f.writer, Cyan+"ℹ "+Reset+msg)
	} else {
		fmt.Fprintln(f.writer, "ℹ "+msg)
	}
}

// toRows converts data to [][]string for table/CSV output
func toRows(data any) ([][]string, error) {
	switch v := data.(type) {
	case [][]string:
		return v, nil
	case []map[string]any:
		return mapsToRows(v), nil
	case map[string]any:
		return mapsToRows([]map[string]any{v}), nil
	default:
		// Try to marshal and unmarshal to handle structs
		jsonData, err := json.Marshal(data)
		if err != nil {
			return nil, err
		}

		var result []map[string]any
		if err := json.Unmarshal(jsonData, &result); err != nil {
			// Single object
			var single map[string]any
			if err := json.Unmarshal(jsonData, &single); err != nil {
				return nil, err
			}
			result = []map[string]any{single}
		}

		return mapsToRows(result), nil
	}
}

func mapsToRows(maps []map[string]any) [][]string {
	if len(maps) == 0 {
		return nil
	}

	// Extract headers from first map
	var headers []string
	for k := range maps[0] {
		headers = append(headers, k)
	}

	rows := [][]string{headers}

	for _, m := range maps {
		row := make([]string, len(headers))
		for i, h := range headers {
			row[i] = fmt.Sprintf("%v", m[h])
		}
		rows = append(rows, row)
	}

	return rows
}
```

### internal/output/progress.go - Progress Indicators

Progress indicators keep users informed during long-running operations such as file transfers or API polling. A simple spinner or progress bar written to a TTY should be suppressed automatically when stdout is redirected to a pipe or file.

```go
package output

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

// Spinner displays an animated spinner
type Spinner struct {
	writer    io.Writer
	message   string
	frames    []string
	interval  time.Duration
	active    bool
	mu        sync.Mutex
	stopCh    chan struct{}
	doneCh    chan struct{}
	isTerminal bool
}

// SpinnerStyle defines spinner animation frames
type SpinnerStyle int

const (
	SpinnerDots SpinnerStyle = iota
	SpinnerLine
	SpinnerCircle
	SpinnerArrow
)

var spinnerFrames = map[SpinnerStyle][]string{
	SpinnerDots:   {"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
	SpinnerLine:   {"-", "\\", "|", "/"},
	SpinnerCircle: {"◐", "◓", "◑", "◒"},
	SpinnerArrow:  {"←", "↖", "↑", "↗", "→", "↘", "↓", "↙"},
}

// NewSpinner creates a new spinner
func NewSpinner(message string, style SpinnerStyle) *Spinner {
	s := &Spinner{
		writer:   os.Stderr,
		message:  message,
		frames:   spinnerFrames[style],
		interval: 100 * time.Millisecond,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}

	if file, ok := s.writer.(*os.File); ok {
		s.isTerminal = term.IsTerminal(int(file.Fd()))
	}

	return s
}

// Start begins the spinner animation
func (s *Spinner) Start() {
	s.mu.Lock()
	if s.active {
		s.mu.Unlock()
		return
	}
	s.active = true
	s.mu.Unlock()

	go func() {
		defer close(s.doneCh)

		frame := 0
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()

		for {
			select {
			case <-s.stopCh:
				s.clear()
				return
			case <-ticker.C:
				s.mu.Lock()
				if s.isTerminal {
					fmt.Fprintf(s.writer, "\r%s %s", s.frames[frame], s.message)
				}
				frame = (frame + 1) % len(s.frames)
				s.mu.Unlock()
			}
		}
	}()
}

// Stop stops the spinner
func (s *Spinner) Stop() {
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return
	}
	s.active = false
	s.mu.Unlock()

	close(s.stopCh)
	<-s.doneCh
}

// StopWithSuccess stops the spinner with a success message
func (s *Spinner) StopWithSuccess(message string) {
	s.Stop()
	if s.isTerminal {
		fmt.Fprintf(s.writer, "\r%s✓%s %s\n", Green, Reset, message)
	} else {
		fmt.Fprintf(s.writer, "✓ %s\n", message)
	}
}

// StopWithError stops the spinner with an error message
func (s *Spinner) StopWithError(message string) {
	s.Stop()
	if s.isTerminal {
		fmt.Fprintf(s.writer, "\r%s✗%s %s\n", Red, Reset, message)
	} else {
		fmt.Fprintf(s.writer, "✗ %s\n", message)
	}
}

// UpdateMessage updates the spinner message
func (s *Spinner) UpdateMessage(message string) {
	s.mu.Lock()
	s.message = message
	s.mu.Unlock()
}

func (s *Spinner) clear() {
	if s.isTerminal {
		fmt.Fprintf(s.writer, "\r%s\r", strings.Repeat(" ", len(s.message)+5))
	}
}

// ProgressBar displays a progress bar
type ProgressBar struct {
	writer     io.Writer
	total      int64
	current    int64
	width      int
	prefix     string
	isTerminal bool
	mu         sync.Mutex
	startTime  time.Time
}

// NewProgressBar creates a new progress bar
func NewProgressBar(total int64, prefix string) *ProgressBar {
	p := &ProgressBar{
		writer:    os.Stderr,
		total:     total,
		width:     40,
		prefix:    prefix,
		startTime: time.Now(),
	}

	if file, ok := p.writer.(*os.File); ok {
		p.isTerminal = term.IsTerminal(int(file.Fd()))
		if width, _, err := term.GetSize(int(file.Fd())); err == nil && width > 80 {
			p.width = 60
		}
	}

	return p
}

// Add increments the progress
func (p *ProgressBar) Add(n int64) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.current += n
	if p.current > p.total {
		p.current = p.total
	}

	p.render()
}

// Set sets the current progress
func (p *ProgressBar) Set(n int64) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.current = n
	if p.current > p.total {
		p.current = p.total
	}

	p.render()
}

// Finish completes the progress bar
func (p *ProgressBar) Finish() {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.current = p.total
	p.render()

	if p.isTerminal {
		fmt.Fprintln(p.writer)
	}
}

func (p *ProgressBar) render() {
	if !p.isTerminal {
		return
	}

	percent := float64(p.current) / float64(p.total)
	filled := int(percent * float64(p.width))

	bar := strings.Repeat("█", filled) + strings.Repeat("░", p.width-filled)

	elapsed := time.Since(p.startTime)
	var eta string
	if p.current > 0 {
		remaining := time.Duration(float64(elapsed) / percent * (1 - percent))
		eta = fmt.Sprintf("ETA: %s", formatDuration(remaining))
	} else {
		eta = "ETA: --:--"
	}

	fmt.Fprintf(p.writer, "\r%s [%s] %.1f%% %s",
		p.prefix, bar, percent*100, eta)
}

func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	m := d / time.Minute
	s := (d % time.Minute) / time.Second
	return fmt.Sprintf("%02d:%02d", m, s)
}

// MultiProgress manages multiple progress bars
type MultiProgress struct {
	writer     io.Writer
	bars       []*ProgressBar
	mu         sync.Mutex
	isTerminal bool
}

// NewMultiProgress creates a new multi-progress display
func NewMultiProgress() *MultiProgress {
	mp := &MultiProgress{
		writer: os.Stderr,
	}

	if file, ok := mp.writer.(*os.File); ok {
		mp.isTerminal = term.IsTerminal(int(file.Fd()))
	}

	return mp
}

// AddBar adds a progress bar to the display
func (mp *MultiProgress) AddBar(total int64, prefix string) *ProgressBar {
	mp.mu.Lock()
	defer mp.mu.Unlock()

	bar := NewProgressBar(total, prefix)
	mp.bars = append(mp.bars, bar)
	return bar
}

// WithSpinner executes a function with a spinner
func WithSpinner(ctx context.Context, message string, fn func() error) error {
	spinner := NewSpinner(message, SpinnerDots)
	spinner.Start()

	errCh := make(chan error, 1)
	go func() {
		errCh <- fn()
	}()

	select {
	case err := <-errCh:
		if err != nil {
			spinner.StopWithError(err.Error())
		} else {
			spinner.StopWithSuccess(message + " completed")
		}
		return err
	case <-ctx.Done():
		spinner.StopWithError("canceled")
		return ctx.Err()
	}
}
```

### internal/prompt/input.go - User Input Prompts

The `prompt` package provides reusable functions for collecting user input: plain text, required fields, passwords (with hidden echo), single-select menus, multi-select lists, and an editor launcher for longer text. Each function reads from stdin and returns a clean value, handling trimming and default substitution internally. The `Editor` function writes a default value to a temp file, opens the user's `$EDITOR`, and reads back the result after the editor exits.

```go
package prompt

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// Input prompts for text input
func Input(label string, defaultValue string) string {
	if defaultValue != "" {
		fmt.Printf("%s [%s]: ", label, defaultValue)
	} else {
		fmt.Printf("%s: ", label)
	}

	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)

	if input == "" {
		return defaultValue
	}
	return input
}

// InputRequired prompts for required text input
func InputRequired(label string) string {
	for {
		value := Input(label, "")
		if value != "" {
			return value
		}
		fmt.Println("This field is required.")
	}
}

// Password prompts for password input (hidden)
func Password(label string) (string, error) {
	fmt.Printf("%s: ", label)

	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println() // New line after hidden input

	if err != nil {
		return "", err
	}

	return string(password), nil
}

// Confirm prompts for yes/no confirmation
func Confirm(label string, defaultYes bool) bool {
	var suffix string
	if defaultYes {
		suffix = "[Y/n]"
	} else {
		suffix = "[y/N]"
	}

	fmt.Printf("%s %s: ", label, suffix)

	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.ToLower(strings.TrimSpace(input))

	if input == "" {
		return defaultYes
	}

	return input == "y" || input == "yes"
}

// Select prompts for selection from options
func Select(label string, options []string) (int, string) {
	fmt.Println(label)
	for i, opt := range options {
		fmt.Printf("  %d) %s\n", i+1, opt)
	}

	for {
		fmt.Print("Select option: ")
		reader := bufio.NewReader(os.Stdin)
		input, _ := reader.ReadString('\n')
		input = strings.TrimSpace(input)

		choice, err := strconv.Atoi(input)
		if err == nil && choice >= 1 && choice <= len(options) {
			return choice - 1, options[choice-1]
		}

		fmt.Println("Invalid selection. Please try again.")
	}
}

// MultiSelect prompts for multiple selections
func MultiSelect(label string, options []string) []int {
	fmt.Println(label + " (comma-separated numbers)")
	for i, opt := range options {
		fmt.Printf("  %d) %s\n", i+1, opt)
	}

	fmt.Print("Select options: ")
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')

	var selected []int
	parts := strings.Split(strings.TrimSpace(input), ",")

	for _, part := range parts {
		choice, err := strconv.Atoi(strings.TrimSpace(part))
		if err == nil && choice >= 1 && choice <= len(options) {
			selected = append(selected, choice-1)
		}
	}

	return selected
}

// Editor opens an editor for multiline input
func Editor(defaultValue string) (string, error) {
	// Create temp file
	tmpfile, err := os.CreateTemp("", "input-*.txt")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmpfile.Name())

	// Write default value
	if defaultValue != "" {
		tmpfile.WriteString(defaultValue)
	}
	tmpfile.Close()

	// Get editor from environment
	editor := os.Getenv("EDITOR")
	if editor == "" {
		editor = os.Getenv("VISUAL")
	}
	if editor == "" {
		editor = "vi"
	}

	// Open editor
	cmd := exec.Command(editor, tmpfile.Name())
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return "", err
	}

	// Read result
	content, err := os.ReadFile(tmpfile.Name())
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(string(content)), nil
}
```

### cmd/root.go - Root Command

The root command ties everything together. It registers global flags (`--config`, `--verbose`, `--output`, `--no-color`), initializes configuration via Viper in `PersistentPreRunE`, and sets up the output formatter that subcommands share. The `Execute` function creates a cancellable context and listens for `SIGINT`/`SIGTERM` so that any long-running subcommand can clean up gracefully on Ctrl+C.

```go
package cmd

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"

	"github.com/yourorg/mycli/internal/config"
	"github.com/yourorg/mycli/internal/output"
)

var (
	cfgFile   string
	verbose   bool
	format    string
	noColor   bool
	formatter *output.Formatter
)

var rootCmd = &cobra.Command{
	Use:   "mycli",
	Short: "A professional CLI application",
	Long: `mycli is a feature-rich command-line application demonstrating
best practices for building professional CLIs in Go.

Features:
  - Multiple output formats (table, JSON, YAML, CSV)
  - Configuration management
  - Interactive prompts
  - Shell completions`,
	SilenceUsage:  true,
	SilenceErrors: true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		// Initialize configuration
		if err := initConfig(); err != nil {
			return err
		}

		// Initialize output formatter
		outputFormat := output.Format(format)
		formatter = output.NewFormatter(
			output.WithFormat(outputFormat),
			output.WithNoColor(noColor),
		)

		return nil
	},
}

// Execute runs the root command
func Execute() {
	ctx, cancel := context.WithCancel(context.Background())

	// Handle signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigCh
		cancel()
	}()

	if err := rootCmd.ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}

func init() {
	// Persistent flags (available to all commands)
	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default $HOME/.config/mycli/config.yaml)")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "verbose output")
	rootCmd.PersistentFlags().StringVarP(&format, "output", "o", "table", "output format (table, json, yaml, csv)")
	rootCmd.PersistentFlags().BoolVar(&noColor, "no-color", false, "disable colored output")

	// Bind flags to viper
	viper.BindPFlag("verbose", rootCmd.PersistentFlags().Lookup("verbose"))
	viper.BindPFlag("output", rootCmd.PersistentFlags().Lookup("output"))

	// Add commands
	rootCmd.AddCommand(versionCmd)
	rootCmd.AddCommand(completionCmd)
}

func initConfig() error {
	if cfgFile != "" {
		viper.SetConfigFile(cfgFile)
	} else {
		paths := config.GetXDGPaths("mycli")

		viper.AddConfigPath(paths.Config)
		viper.AddConfigPath(".")
		viper.SetConfigType("yaml")
		viper.SetConfigName("config")
	}

	// Environment variables
	viper.SetEnvPrefix("MYCLI")
	viper.AutomaticEnv()

	// Read config file
	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return fmt.Errorf("failed to read config: %w", err)
		}
	}

	if verbose {
		if configFile := viper.ConfigFileUsed(); configFile != "" {
			fmt.Fprintln(os.Stderr, "Using config file:", configFile)
		}
	}

	return nil
}

// GetFormatter returns the global formatter
func GetFormatter() *output.Formatter {
	return formatter
}
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
.PHONY: all build run test clean install release lint fmt help

# Build variables
BINARY_NAME=mycli
VERSION?=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT=$(shell git rev-parse --short HEAD 2>/dev/null || echo "none")
BUILD_TIME=$(shell date -u '+%Y-%m-%d_%H:%M:%S')
LDFLAGS=-ldflags "-s -w \
	-X github.com/yourorg/mycli/internal/version.Version=$(VERSION) \
	-X github.com/yourorg/mycli/internal/version.Commit=$(COMMIT) \
	-X github.com/yourorg/mycli/internal/version.BuildTime=$(BUILD_TIME)"

# Go commands
GOCMD=go
GOBUILD=$(GOCMD) build
GOTEST=$(GOCMD) test
GOGET=$(GOCMD) get
GOMOD=$(GOCMD) mod
GOFMT=gofmt

all: lint test build
```

### Junior to FAANG: assembling the framework

The layout above is the reference directory structure. Memorize it. `main.go` is three lines, `cmd/` holds Cobra command definitions, `internal/` holds reusable logic, `pkg/` holds code you intentionally expose to external importers. If you are unsure whether a file belongs in `internal` or `pkg`, the answer is `internal`. Only move it to `pkg` when an external consumer has asked.

Trace one command end to end. `mycli config set key value`. Flow. `main.go` calls `cmd.Execute()`. Cobra walks the tree to `cmd/config/set.go`. `PersistentPreRunE` initializes config via `internal/config` and builds the `Formatter`. `RunE` calls into `pkg/api/client.go` (or `internal/` if this is a leaf tool). Client returns a value. `Formatter.Success(...)` writes to stdout. Any error returned becomes the process exit. Each step is isolated and testable.

Worked example. You want to add `mycli users list`. Steps. Create `cmd/users/list.go` with a `newListCmd(deps)` constructor. Register it in `cmd/users/users.go` under a `users` group command. Put list logic in `internal/users/service.go` with a `List(ctx) ([]User, error)` function that takes an injected `internal/users.Repository` interface. Pass the formatter through. Write table tests for the service (mocked repository), a Cobra test for the command (fake service), and a golden file test for the JSON output. Four files, two hundred lines, and you have a production-ready subcommand.

Interview entry point. "Walk me through the layering of a well-designed CLI." Name the five layers. Entry point (main). Parser (cmd). Orchestration (internal services). Domain (internal/pkg). I/O (output/prompt). Be able to name what imports what and why (internal never imports cmd, pkg never imports internal, main imports only cmd).

### Senior at FAANG: the framework as organizational contract

At staff level, the framework above is not a snippet to copy. It is an ADR that becomes the standard for every CLI your org ships. Staff concerns.

Monorepo versus polyrepo for CLI collection. If your org has 20 tools, sharing the framework is a win. Create a `cliframework` module with the `output`, `prompt`, `config`, and `telemetry` packages. Every CLI imports it. Upgrades propagate via dependabot. The tradeoff. A bug in the framework breaks 20 tools at once. Mitigation. Version the framework module, rolling upgrades, canary one CLI before promoting.

Telemetry integration as a framework concern. The framework should ship with a telemetry package that subcommands opt into. Record command path, exit code category, duration bucket, format used, flag names (not values). Respect DO_NOT_TRACK. Publish schema. Every tool using the framework inherits compliant telemetry. The alternative, each team rolls their own, leads to inconsistent collection and privacy violations.

Feature flags integration. Commands should be gated by feature flags resolved from config. `if !flags.Enabled("experimental.deploy") { return errCommandNotAvailable }`. The framework exposes a `flags.Enabled(key)` function that reads from config, env, and remote feature flag service. It is the same idea behind `gcloud`'s alpha and beta release tracks: experimental surface is explicitly opted into, never on by default.

Error taxonomy. The framework defines error types. `errutil.UserError(msg)`, `errutil.ConfigError(msg)`, `errutil.NetworkError(msg)`, `errutil.InternalError(err)`. Each maps to a stable exit code range. The formatter prints them differently (user errors get no stack trace, internal errors hint at filing a bug). Consistency across 20 tools matters more than cleverness in any one.

Logger policy. The framework must not include a logger that writes to stdout. Only the formatter writes to stdout. The logger writes to stderr in verbose mode, to a file in always-on mode, and is structured JSON in CI mode. `slog` from the standard library is the target. Ban printf logging in reviews.

Plugin boundary. If your framework supports plugins, the boundary is a JSON-over-stdio protocol (like LSP) or an out-of-process subcommand invocation (like kubectl-*). Never Go plugins (`plugin` package). The framework publishes a plugin protocol spec and a plugin SDK. Versioned separately from the core so that plugin authors can target a stable API while core evolves.

Context propagation. Every command receives a `context.Context` via `cmd.Context()`. The framework adds request IDs, telemetry spans, and cancellation on `SIGINT`. Business logic must accept `ctx` and respect cancellation. The framework's `PersistentPreRunE` starts the root span, `PersistentPostRunE` closes it. This is how tracing flows through every command for free.

Output schema registry. Every command that emits `-o json` registers its output schema at init time. A `mycli schemas list` subcommand prints the registry. CI validates all goldens against registered schemas. Breaking changes detected automatically. This is the single most valuable framework-level feature, and almost no tool does it, which is why machine output evolves unpredictably.

Lifecycle hooks beyond Cobra. The framework exposes `OnStart`, `OnExit`, `OnPanic`, `OnSignal` hooks above Cobra's PreRunE/PostRunE. Telemetry flush hooks register with `OnExit`. Crash reporting hooks register with `OnPanic`. Graceful shutdown registers with `OnSignal`. The command author opts in without rewriting infrastructure per command.

Cross-team contribution model. When 20 teams contribute to one CLI, you need a RFC process for new top-level commands. Template. Context, proposed grammar, flags, output schema, deprecation of any existing commands, rollout plan. Review by the CLI platform team. This prevents grammar drift (`mycli deploy` vs `mycli deployment create` vs `mycli apps create`) and ensures consistent UX. The review is 30 minutes. The avoided chaos is immeasurable.

Governance metrics. Track binary size per release, startup time P99, command invocation count by path, exit code distribution, version adoption curve. Publish a dashboard. Set budgets and alerts. When startup time regresses by 50ms after a merge, someone is paged, because users notice immediately.

Multi-year roadmap. Year one. Ship the framework, migrate 3 tools, establish conventions. Year two. Migrate remaining tools, add plugin boundary, establish SLAs for the framework team. Year three. Ship v2 with breaking changes, run migration tooling, deprecate v1. Staff engineers own this roadmap across multiple org changes.

Staff archetype. The CLI platform lead is the staff role that owns the framework, governance, and conventions. Reports to a director who owns developer productivity. Partners with the security team on supply chain, with the SRE team on observability, with the docs team on generated output. One of the highest-value roles in a developer tools org, often invisible until the framework breaks.

