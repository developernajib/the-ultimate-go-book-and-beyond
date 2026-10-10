package logger

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestFormatKeyValues(t *testing.T) {
	tests := []struct {
		name     string
		msg      string
		args     []any
		expected string
	}{
		{
			name:     "no args",
			msg:      "hello world",
			args:     nil,
			expected: "hello world",
		},
		{
			name:     "key value pairs",
			msg:      "starting server",
			args:     []any{"addr", ":8080", "env", "prod"},
			expected: "starting server addr=:8080 env=prod",
		},
		{
			name:     "odd number of args",
			msg:      "warning event",
			args:     []any{"code", 500, "extra"},
			expected: "warning event code=500 extra",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatKeyValues(tt.msg, tt.args)
			if got != tt.expected {
				t.Errorf("got %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestStdLogger(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(log.Default().Writer())

	l := New()
	l.Info("testing info", "key", "value")
	out := buf.String()
	if !strings.Contains(out, "[INFO] testing info key=value") {
		t.Errorf("unexpected output: %q", out)
	}
}
