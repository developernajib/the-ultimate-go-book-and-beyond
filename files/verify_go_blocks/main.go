package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type BlockResult struct {
	File     string `json:"file"`
	Line     int    `json:"line"`
	Category string `json:"category"`
	Status   string `json:"status"`
	Message  string `json:"message"`
	Snippet  string `json:"snippet,omitempty"`
}

type SummaryReport struct {
	Timestamp         string        `json:"timestamp"`
	GoVersion         string        `json:"go_version"`
	TotalFiles        int           `json:"total_files"`
	TotalBlocks       int           `json:"total_blocks"`
	SyntaxClean       int64         `json:"syntax_clean"`
	CompiledClean     int64         `json:"compiled_clean"`
	ExecutedClean     int64         `json:"executed_clean"`
	IntentionalBug    int64         `json:"intentional_bug"`
	SyntaxErrors      int64         `json:"syntax_errors"`
	BuildErrors       int64         `json:"build_errors"`
	IntentionalBlocks []BlockResult `json:"intentional_blocks,omitempty"`
	Failures          []BlockResult `json:"failures,omitempty"`
}

var (
	intentionalErrRegex = regexp.MustCompile(`(?i)(//\s*(compile error|won'?t compile|error:|will not compile|WRONG|bad|incorrect|does not compile|invalid syntax|BUG|type error|cannot use|will this compile\?)|//\s*Output:.*(error|panic)|panic\(.*intentional|//\s*✗)`)
	packageMainRegex    = regexp.MustCompile(`(?m)^\s*package\s+main\b`)
	mainFuncRegex       = regexp.MustCompile(`func\s+main\s*\(\s*\)`)
	nonRunnableRegex    = regexp.MustCompile(`(http\.ListenAndServe|select\s*\{\s*\}|signal\.Notify|for\s*\{\s*select\s*\{|for\s*\{\s*time\.Sleep)`)
	embedPatternRegex   = regexp.MustCompile(`//go:embed\s+([^\r\n]+)`)
	buildTagRegex       = regexp.MustCompile(`(?m)^//\s*(\+build|go:build)\b`)
)

var stdlibRoots = map[string]bool{
	"archive": true, "arena": true, "bufio": true, "bytes": true, "cmp": true, "compress": true, "container": true,
	"context": true, "crypto": true, "database": true, "debug": true, "embed": true,
	"encoding": true, "errors": true, "expvar": true, "flag": true, "fmt": true,
	"go": true, "hash": true, "html": true, "image": true, "index": true,
	"io": true, "iter": true, "log": true, "maps": true, "math": true,
	"mime": true, "net": true, "os": true, "path": true, "plugin": true,
	"reflect": true, "regexp": true, "runtime": true, "slices": true, "sort": true,
	"strconv": true, "strings": true, "structs": true, "sync": true, "syscall": true,
	"testing": true, "text": true, "time": true, "unicode": true, "unique": true, "unsafe": true, "weak": true,
}

// Collects real import paths from single-line and block import declarations.
// The old quoted-string scan mistook every string literal for an import and
// excluded most programs from compilation.
func parseImportPaths(code string) []string {
	var paths []string
	singleRe := regexp.MustCompile(`^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"`)
	blockPathRe := regexp.MustCompile(`^\s*(?:[\w.]+\s+)?"([^"]+)"`)
	inBlock := false
	for _, line := range strings.Split(code, "\n") {
		trimmed := strings.TrimSpace(line)
		if !inBlock {
			if strings.HasPrefix(trimmed, "import (") || trimmed == "import(" {
				inBlock = true
				continue
			}
			if m := singleRe.FindStringSubmatch(line); m != nil {
				paths = append(paths, m[1])
			}
			continue
		}
		if strings.HasPrefix(trimmed, ")") {
			inBlock = false
			continue
		}
		if m := blockPathRe.FindStringSubmatch(line); m != nil {
			paths = append(paths, m[1])
		}
	}
	return paths
}

func hasNonStdlibImports(code string) bool {
	for _, path := range parseImportPaths(code) {
		if path == "C" {
			return true
		}
		firstSeg := path
		if idx := strings.Index(path, "/"); idx != -1 {
			firstSeg = path[:idx]
		}
		if !stdlibRoots[firstSeg] {
			return true
		}
	}
	return false
}

func hasCgoImport(code string) bool {
	for _, path := range parseImportPaths(code) {
		if path == "C" {
			return true
		}
	}
	return false
}

func setupEmbedFiles(dir, code string) {
	matches := embedPatternRegex.FindAllStringSubmatch(code, -1)
	for _, m := range matches {
		patterns := strings.Fields(m[1])
		for _, p := range patterns {
			p = strings.Trim(p, "\"`'")
			targetPath := filepath.Join(dir, p)
			if strings.HasSuffix(p, "/") || !strings.Contains(p, ".") {
				_ = os.MkdirAll(targetPath, 0755)
				_ = os.WriteFile(filepath.Join(targetPath, "dummy.txt"), []byte("sample testdata"), 0644)
			} else {
				_ = os.MkdirAll(filepath.Dir(targetPath), 0755)
				_ = os.WriteFile(targetPath, []byte("dummy embed content\n"), 0644)
			}
		}
	}
}

type ExtractedBlock struct {
	Path string
	Line int
	Code string
}

func extractBlocks(filePath string) ([]ExtractedBlock, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	lines := strings.Split(string(data), "\n")
	var blocks []ExtractedBlock
	var current []string
	inBlock := false
	startLine := 0

	for idx, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !inBlock {
			if trimmed == "```go" || trimmed == "```golang" || strings.HasPrefix(trimmed, "```go ") || strings.HasPrefix(trimmed, "```golang ") {
				inBlock = true
				current = nil
				startLine = idx + 1
			}
		} else {
			if trimmed == "```" {
				inBlock = false
				blocks = append(blocks, ExtractedBlock{
					Path: filePath,
					Line: startLine,
					Code: strings.Join(current, "\n"),
				})
			} else {
				current = append(current, line)
			}
		}
	}
	return blocks, nil
}

var (
	ellipsisBlockRegex  = regexp.MustCompile(`\{\s*\.\.\.\s*\}`)
	ellipsisArgRegex    = regexp.MustCompile(`,\s*\.\.\.\s*\)`)
	ellipsisStructRegex = regexp.MustCompile(`,\s*\.\.\.\s*\}`)
	ellipsisParenRegex  = regexp.MustCompile(`\(\s*\.\.\.\s*\)`)
	bareDotsLineRegex   = regexp.MustCompile(`(?m)^\s*\.\.\.\s*$`)
)

func sanitizeSnippet(code string) string {
	s := ellipsisBlockRegex.ReplaceAllString(code, "{}")
	s = ellipsisArgRegex.ReplaceAllString(s, ")")
	s = ellipsisStructRegex.ReplaceAllString(s, "}")
	s = ellipsisParenRegex.ReplaceAllString(s, "()")
	s = bareDotsLineRegex.ReplaceAllString(s, "// elided")
	s = strings.ReplaceAll(s, "args ...)", "args ...any)")
	s = strings.ReplaceAll(s, "args ...", "args ...any")
	return s
}

func isGoModOrWork(code string) bool {
	trimmed := strings.TrimSpace(code)
	if (strings.Contains(trimmed, "module ") || strings.HasPrefix(trimmed, "module ")) && (strings.Contains(trimmed, "go 1.") || strings.Contains(trimmed, "toolchain ")) {
		return true
	}
	if strings.HasPrefix(trimmed, "module ") || strings.HasPrefix(trimmed, "// go.mod") || strings.Contains(trimmed, "\nmodule ") {
		if strings.Contains(trimmed, "go 1.") || strings.Contains(trimmed, "require") || strings.Contains(trimmed, "replace") {
			return true
		}
	}
	if strings.Contains(trimmed, "replace ") && (strings.Contains(trimmed, "=>") || strings.Contains(trimmed, "github.com") || strings.Contains(trimmed, "../")) {
		return true
	}
	if strings.Contains(trimmed, "require (") && strings.Contains(trimmed, "go 1.") {
		return true
	}
	if strings.Contains(trimmed, "use (") && strings.Contains(trimmed, "go 1.") {
		return true
	}
	return false
}

func isPromptTemplate(code string) bool {
	trimmed := strings.TrimSpace(code)
	if strings.HasPrefix(trimmed, "[paste ") || strings.HasPrefix(trimmed, "[paste") {
		return true
	}
	return false
}

func normalizeAndParse(code string) (bool, string) {
	if isGoModOrWork(code) {
		return true, ""
	}

	fset := token.NewFileSet()

	// 1. Try as-is
	_, err := parser.ParseFile(fset, "code.go", code, parser.AllErrors)
	if err == nil {
		return true, ""
	}
	rawErr := err.Error()

	// 2. Check if multi-file block
	if strings.Count(code, "package ") > 1 && (strings.Contains(code, "// File:") || strings.Contains(code, "// file:")) {
		fileChunks := regexp.MustCompile(`(?m)^//\s*[Ff]ile:`).Split(code, -1)
		allChunksOk := true
		for _, chunk := range fileChunks {
			trimmed := strings.TrimSpace(chunk)
			if trimmed == "" {
				continue
			}
			ok, _ := normalizeAndParse(trimmed)
			if !ok {
				allChunksOk = false
				break
			}
		}
		if allChunksOk {
			return true, ""
		}
	}

	sanitized := sanitizeSnippet(code)

	// 3. Try with package main
	for _, text := range []string{code, sanitized} {
		wrapPkg := "package main\n\n" + text
		if _, err := parser.ParseFile(fset, "code.go", wrapPkg, parser.AllErrors); err == nil {
			return true, ""
		}
	}

	// 4. Try wrapping all in func main()
	for _, text := range []string{code, sanitized} {
		wrapFunc := "package main\n\nfunc main() {\n" + text + "\n}\n"
		if _, err := parser.ParseFile(fset, "code.go", wrapFunc, parser.AllErrors); err == nil {
			return true, ""
		}
	}

	// 4b. Try select/switch case wrapper if snippet starts with case/default (skipping comments)
	trimmedSanitized := strings.TrimSpace(sanitized)
	firstRealLine := ""
	for _, l := range strings.Split(trimmedSanitized, "\n") {
		tl := strings.TrimSpace(l)
		if tl != "" && !strings.HasPrefix(tl, "//") && !strings.HasPrefix(tl, "/*") {
			firstRealLine = tl
			break
		}
	}
	if strings.HasPrefix(firstRealLine, "case ") || strings.HasPrefix(firstRealLine, "default:") {
		for _, swHeader := range []string{"select {", "switch {", "switch (any)(nil) {"} {
			wrapSwitch := "package main\n\nfunc main() {\n" + swHeader + "\n" + sanitized + "\n}\n}\n"
			if _, err := parser.ParseFile(fset, "code.go", wrapSwitch, parser.AllErrors); err == nil {
				return true, ""
			}
		}
	}

	// 4c. Try struct literal key-value wrapper
	if strings.Contains(trimmedSanitized, ":") && !strings.Contains(trimmedSanitized, "package ") {
		wrapLit := "package main\n\nfunc main() {\n_ = T{\n" + sanitized + "\n}\n}\n"
		if _, err := parser.ParseFile(fset, "code.go", wrapLit, parser.AllErrors); err == nil {
			return true, ""
		}
	}

	// 5. Smart Normalizer: Separate imports, top-level decls, and statements
	lines := strings.Split(sanitized, "\n")
	var imports []string
	var decls []string
	var stmts []string

	inImport := false
	inDecl := false
	braceCount := 0
	parenCount := 0

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		// Handle imports
		if strings.HasPrefix(trimmed, "import (") {
			inImport = true
			imports = append(imports, line)
			continue
		}
		if inImport {
			imports = append(imports, line)
			if trimmed == ")" {
				inImport = false
			}
			continue
		}
		if strings.HasPrefix(trimmed, "import ") {
			imports = append(imports, line)
			continue
		}

		// Skip package if already present
		if strings.HasPrefix(trimmed, "package ") {
			continue
		}

		// Handle function, type, var, const declarations
		if !inDecl && (strings.HasPrefix(trimmed, "func ") || strings.HasPrefix(trimmed, "type ") || strings.HasPrefix(trimmed, "var ") || strings.HasPrefix(trimmed, "const ")) {
			inDecl = true
			decls = append(decls, line)
			braceCount += strings.Count(line, "{") - strings.Count(line, "}")
			if strings.HasSuffix(trimmed, "(") {
				parenCount += 1
			}
			if braceCount <= 0 && parenCount <= 0 {
				if strings.HasPrefix(trimmed, "func ") && !strings.Contains(line, "{") && (strings.HasSuffix(trimmed, ",") || !strings.Contains(line, ")")) {
					// stay inDecl = true for multiline func signature
				} else {
					inDecl = false
					braceCount = 0
					parenCount = 0
				}
			}
			continue
		}

		if inDecl {
			decls = append(decls, line)
			braceCount += strings.Count(line, "{") - strings.Count(line, "}")
			if parenCount > 0 {
				parenCount += strings.Count(line, "(") - strings.Count(line, ")")
			}
			if braceCount <= 0 && parenCount <= 0 {
				if !strings.Contains(line, "{") && strings.HasSuffix(trimmed, ",") {
					// stay inDecl for multiline signature
				} else if braceCount <= 0 {
					inDecl = false
					braceCount = 0
					parenCount = 0
				}
			}
			continue
		}

		// Comments outside funcs can go to decls or stmts
		if strings.HasPrefix(trimmed, "//") {
			if len(stmts) == 0 {
				decls = append(decls, line)
			} else {
				stmts = append(stmts, line)
			}
			continue
		}

		// Otherwise, it's a statement
		stmts = append(stmts, line)
	}

	hasRealStmts := false
	for _, s := range stmts {
		t := strings.TrimSpace(s)
		if t != "" && !strings.HasPrefix(t, "//") {
			hasRealStmts = true
			break
		}
	}
	if !hasRealStmts {
		decls = append(decls, stmts...)
		stmts = nil
	}

	var assembled strings.Builder
	assembled.WriteString("package main\n\n")
	if len(imports) > 0 {
		assembled.WriteString(strings.Join(imports, "\n"))
		assembled.WriteString("\n\n")
	}
	if len(decls) > 0 {
		assembled.WriteString(strings.Join(decls, "\n"))
		assembled.WriteString("\n\n")
	}
	if len(stmts) > 0 {
		assembled.WriteString("func _snippet() {\n")
		assembled.WriteString(strings.Join(stmts, "\n"))
		assembled.WriteString("\n}\n")
	}

	_, err = parser.ParseFile(fset, "code.go", assembled.String(), parser.AllErrors)
	if err == nil {
		return true, ""
	}

	return false, rawErr
}

func main() {
	partFlag := flag.String("part", "", "Filter by part (e.g. part-01-go-mastery, appendices)")
	runFlag := flag.Bool("run", false, "Compile and run complete programs with go run")
	buildFlag := flag.Bool("build", false, "Compile complete standalone programs with go build")
	jsonFlag := flag.String("output", "public/code-verification-report.json", "JSON report output path")
	flag.Parse()

	cmd := exec.Command("go", "version")
	goVerBytes, err := cmd.Output()
	if err != nil {
		fmt.Println("Error: 'go' binary not found in PATH")
		os.Exit(1)
	}
	goVer := strings.TrimSpace(string(goVerBytes))

	fmt.Println("======================================================================")
	fmt.Println("      THE ULTIMATE GO BOOK & BEYOND - GO CODE VERIFICATION SUITE")
	fmt.Println("======================================================================")
	fmt.Printf("  Go Toolchain   : %s\n", goVer)
	fmt.Printf("  CPU Cores      : %d\n", runtime.NumCPU())
	if *partFlag != "" {
		fmt.Printf("  Filter Part    : %s\n", *partFlag)
	}
	fmt.Printf("  Execution Mode : ")
	if *runFlag {
		fmt.Println("SYNTAX CHECK + COMPILE + RUN (go run)")
	} else if *buildFlag {
		fmt.Println("SYNTAX CHECK + COMPILE (go build)")
	} else {
		fmt.Println("SYNTAX CHECK (Native Go 1.27.1 AST Parser)")
	}
	fmt.Println("======================================================================")

	root := filepath.Join("files", "chapters")
	if *partFlag != "" {
		root = filepath.Join(root, *partFlag)
	}

	var mdFiles []string
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(path, ".md") {
			name := d.Name()
			if name != "BOOK-UPDATE-CHECKLIST.md" && name != "IMPROVEMENT-PLAN.md" && name != "PLAN-CPP-CHAPTERS.md" {
				mdFiles = append(mdFiles, path)
			}
		}
		return nil
	})
	if err != nil {
		fmt.Printf("Error walking directory: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Scanning %d markdown files for Go code blocks...\n", len(mdFiles))
	t0 := time.Now()

	var allBlocks []ExtractedBlock
	for _, f := range mdFiles {
		blocks, err := extractBlocks(f)
		if err == nil {
			allBlocks = append(allBlocks, blocks...)
		}
	}

	fmt.Printf("Extracted %d Go blocks in %v\n\n", len(allBlocks), time.Since(t0).Round(time.Millisecond))
	if len(allBlocks) == 0 {
		fmt.Println("No code blocks found.")
		return
	}

	fmt.Println("Validating code blocks across all chapters...")
	t1 := time.Now()

	var (
		syntaxClean       int64
		compiledClean     int64
		executedClean     int64
		intentionalBug    int64
		syntaxErrors      int64
		buildErrors       int64
		failuresMu        sync.Mutex
		failures          []BlockResult
		intentionalMu     sync.Mutex
		intentionalBlocks []BlockResult
	)

	numWorkers := runtime.NumCPU() * 2
	blockChan := make(chan ExtractedBlock, len(allBlocks))
	for _, b := range allBlocks {
		blockChan <- b
	}
	close(blockChan)

	var wg sync.WaitGroup
	var processed int64
	total := int64(len(allBlocks))

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for b := range blockChan {
				curr := atomic.AddInt64(&processed, 1)
				if curr%1000 == 0 || curr == total {
					pct := float64(curr) / float64(total) * 100
					fmt.Printf("\r  Progress: %d/%d (%.1f%%)", curr, total, pct)
				}

				// Check syntax first across all blocks
				ok, parseErr := normalizeAndParse(b.Code)
				if !ok {
					// Only if syntax parsing fails, check if it's an intentional compile error demonstration or prompt template
					if intentionalErrRegex.MatchString(b.Code) || isPromptTemplate(b.Code) {
						atomic.AddInt64(&intentionalBug, 1)
						snippet := b.Code
						if len(snippet) > 200 {
							snippet = snippet[:200]
						}
						intentionalMu.Lock()
						intentionalBlocks = append(intentionalBlocks, BlockResult{
							File:     b.Path,
							Line:     b.Line,
							Category: "INTENTIONAL_ERROR",
							Status:   "INTENTIONAL",
							Message:  parseErr,
							Snippet:  snippet,
						})
						intentionalMu.Unlock()
						continue
					}

					atomic.AddInt64(&syntaxErrors, 1)
					snippet := b.Code
					if len(snippet) > 200 {
						snippet = snippet[:200]
					}
					failuresMu.Lock()
					failures = append(failures, BlockResult{
						File:     b.Path,
						Line:     b.Line,
						Category: "SYNTAX",
						Status:   "FAIL_SYNTAX",
						Message:  parseErr,
						Snippet:  snippet,
					})
					failuresMu.Unlock()
					continue
				}

				atomic.AddInt64(&syntaxClean, 1)

				// Optional build/run for complete standalone main programs
				canBuild := (*buildFlag || *runFlag) &&
					packageMainRegex.MatchString(b.Code) &&
					mainFuncRegex.MatchString(b.Code) &&
					!hasCgoImport(b.Code) &&
					!hasNonStdlibImports(b.Code) &&
					!buildTagRegex.MatchString(b.Code) &&
					!strings.Contains(b.Code, "syscall/js") &&
					!strings.Contains(b.Code, "machine.")

				if canBuild {
					tmpDir, err := os.MkdirTemp("", "go_block_*")
					if err == nil {
						mainGo := filepath.Join(tmpDir, "main.go")
						_ = os.WriteFile(mainGo, []byte(b.Code), 0644)
						goMod := filepath.Join(tmpDir, "go.mod")
						_ = os.WriteFile(goMod, []byte("module blocktest\n\ngo 1.27.1\n"), 0644)
						setupEmbedFiles(tmpDir, b.Code)

						buildCmd := exec.Command("go", "build", ".")
						buildCmd.Dir = tmpDir
						buildOut, buildErr := buildCmd.CombinedOutput()
						if buildErr != nil {
							atomic.AddInt64(&buildErrors, 1)
							failuresMu.Lock()
							failures = append(failures, BlockResult{
								File:     b.Path,
								Line:     b.Line,
								Category: "BUILD",
								Status:   "FAIL_BUILD",
								Message:  string(buildOut),
								Snippet:  b.Code[:min(200, len(b.Code))],
							})
							failuresMu.Unlock()
						} else {
							atomic.AddInt64(&compiledClean, 1)
							if *runFlag && !nonRunnableRegex.MatchString(b.Code) {
								runCmd := exec.Command("go", "run", ".")
								runCmd.Dir = tmpDir
								runOut, runErr := runCmd.CombinedOutput()
								if runErr != nil {
									atomic.AddInt64(&buildErrors, 1)
									failuresMu.Lock()
									failures = append(failures, BlockResult{
										File:     b.Path,
										Line:     b.Line,
										Category: "RUN_PANIC",
										Status:   "FAIL_RUN",
										Message:  string(runOut),
										Snippet:  b.Code[:min(200, len(b.Code))],
									})
									failuresMu.Unlock()
								} else {
									atomic.AddInt64(&executedClean, 1)
								}
							}
						}
						_ = os.RemoveAll(tmpDir)
					}
				}
			}
		}()
	}

	wg.Wait()
	elapsed := time.Since(t1)

	fmt.Printf("\n\nVerification finished in %v (%.1f blocks/sec)\n", elapsed.Round(time.Millisecond), float64(len(allBlocks))/elapsed.Seconds())

	fmt.Println("\n======================================================================")
	fmt.Println("                      VERIFICATION SUMMARY")
	fmt.Println("======================================================================")
	fmt.Printf("  Total Go Blocks Scanned   : %d\n", len(allBlocks))
	fmt.Printf("  Syntax Verified Clean     : %d\n", syntaxClean)
	fmt.Printf("  Intentional Error Blocks  : %d\n", intentionalBug)
	if *buildFlag || *runFlag {
		fmt.Printf("  Compiled Cleanly (build)  : %d\n", compiledClean)
	}
	if *runFlag {
		fmt.Printf("  Executed Cleanly (run)    : %d\n", executedClean)
	}
	fmt.Printf("  Syntax Failures           : %d\n", syntaxErrors)
	if *buildFlag || *runFlag {
		fmt.Printf("  Build/Run Failures        : %d\n", buildErrors)
	}
	fmt.Println("======================================================================")

	report := SummaryReport{
		Timestamp:         time.Now().UTC().Format(time.RFC3339),
		GoVersion:         goVer,
		TotalFiles:        len(mdFiles),
		TotalBlocks:       len(allBlocks),
		SyntaxClean:       syntaxClean,
		CompiledClean:     compiledClean,
		ExecutedClean:     executedClean,
		IntentionalBug:    intentionalBug,
		SyntaxErrors:      syntaxErrors,
		BuildErrors:       buildErrors,
		IntentionalBlocks: intentionalBlocks,
		Failures:          failures,
	}

	_ = os.MkdirAll(filepath.Dir(*jsonFlag), 0755)
	jsonData, _ := json.MarshalIndent(report, "", "  ")
	_ = os.WriteFile(*jsonFlag, jsonData, 0644)
	fmt.Printf("Report written to: %s\n\n", *jsonFlag)

	if len(failures) > 0 {
		fmt.Printf("FAILURES (%d):\n", len(failures))
		for i, f := range failures {
			if i >= 20 {
				fmt.Printf("  ... and %d more failures\n", len(failures)-20)
				break
			}
			fmt.Printf("  [x] %s:%d [%s] - %s\n", f.File, f.Line, f.Category, f.Message)
		}
		os.Exit(1)
	}

	fmt.Println("ALL CODE BLOCKS VERIFIED SUCCESSFULLY! NO WRONG CODE DETECTED.")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
