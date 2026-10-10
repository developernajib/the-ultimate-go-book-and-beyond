// pkg/logger/logger.go
package logger

import (
	"fmt"
	"log"
	"strings"
)

// Logger is a simple logger interface
type Logger interface {
	Info(msg string, args ...any)
	Error(msg string, args ...any)
	Warn(msg string, args ...any)
	Debug(msg string, args ...any)
	Fatal(msg string, args ...any)
}

// New returns a new default logger (alias for Default).
func New() Logger {
	return &stdLogger{}
}

// Default returns a simple default logger
func Default() Logger {
	return &stdLogger{}
}

type stdLogger struct{}

func formatKeyValues(msg string, args []any) string {
	if len(args) == 0 {
		return msg
	}
	var b strings.Builder
	b.WriteString(msg)
	for i := 0; i < len(args); i += 2 {
		if i+1 < len(args) {
			b.WriteString(fmt.Sprintf(" %v=%v", args[i], args[i+1]))
		} else {
			b.WriteString(fmt.Sprintf(" %v", args[i]))
		}
	}
	return b.String()
}

func (l *stdLogger) Info(msg string, args ...any)  { log.Println("[INFO] " + formatKeyValues(msg, args)) }
func (l *stdLogger) Error(msg string, args ...any) { log.Println("[ERROR] " + formatKeyValues(msg, args)) }
func (l *stdLogger) Warn(msg string, args ...any)  { log.Println("[WARN] " + formatKeyValues(msg, args)) }
func (l *stdLogger) Debug(msg string, args ...any) { log.Println("[DEBUG] " + formatKeyValues(msg, args)) }
func (l *stdLogger) Fatal(msg string, args ...any) { log.Fatalln("[FATAL] " + formatKeyValues(msg, args)) }
