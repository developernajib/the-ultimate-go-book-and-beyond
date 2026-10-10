// pkg/ingestion/logs/collector.go
package logs

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net"
	"os"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/pipeline"
)

// Collector collects logs from various sources
type Collector struct {
	syslogAddr string
	filePaths  []string
	parseJSON  bool
	pipeline   *pipeline.Pipeline

	syslogListener net.Listener
	fileWatcher    *fsnotify.Watcher
	fileTailers    map[string]*FileTailer

	mu      sync.RWMutex
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewCollector creates a new log collector
func NewCollector(syslogAddr string, filePaths []string, parseJSON bool, pipeline *pipeline.Pipeline) *Collector {
	return &Collector{
		syslogAddr:  syslogAddr,
		filePaths:   filePaths,
		parseJSON:   parseJSON,
		pipeline:    pipeline,
		fileTailers: make(map[string]*FileTailer),
	}
}

// Start starts the collector
func (c *Collector) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return fmt.Errorf("collector already running")
	}

	c.stopCh = make(chan struct{})

	// Start syslog listener
	if c.syslogAddr != "" {
		if err := c.startSyslog(); err != nil {
			return fmt.Errorf("starting syslog: %w", err)
		}
	}

	// Start file tailing
	if len(c.filePaths) > 0 {
		if err := c.startFileTailing(); err != nil {
			c.stopSyslog()
			return fmt.Errorf("starting file tailing: %w", err)
		}
	}

	c.running = true
	return nil
}

// startSyslog starts syslog listener
func (c *Collector) startSyslog() error {
	listener, err := net.Listen("tcp", c.syslogAddr)
	if err != nil {
		return err
	}

	c.syslogListener = listener

	c.wg.Add(1)
	go c.acceptSyslog()

	return nil
}

// acceptSyslog accepts syslog connections
func (c *Collector) acceptSyslog() {
	defer c.wg.Done()

	for {
		conn, err := c.syslogListener.Accept()
		if err != nil {
			select {
			case <-c.stopCh:
				return
			default:
				continue
			}
		}

		c.wg.Add(1)
		go c.handleSyslogConn(conn)
	}
}

// handleSyslogConn handles a syslog connection
func (c *Collector) handleSyslogConn(conn net.Conn) {
	defer c.wg.Done()
	defer conn.Close()

	scanner := bufio.NewScanner(conn)

	for scanner.Scan() {
		entry := c.parseSyslogLine(scanner.Text())
		if entry != nil {
			c.pipeline.ProcessLog(context.Background(), entry)
		}
	}
}

// parseSyslogLine parses a syslog line
func (c *Collector) parseSyslogLine(line string) *models.LogEntry {
	// Simplified syslog parsing
	// In production, use proper RFC 5424/3164 parser

	entry := &models.LogEntry{
		Timestamp: time.Now(),
		Message:   line,
		Fields:    make(map[string]any),
		Level:     models.LogLevelInfo,
	}

	// Try JSON parsing if enabled
	if c.parseJSON {
		var jsonData map[string]any
		if err := json.Unmarshal([]byte(line), &jsonData); err == nil {
			c.extractJSONFields(entry, jsonData)
			return entry
		}
	}

	return entry
}

// extractJSONFields extracts fields from JSON log
func (c *Collector) extractJSONFields(entry *models.LogEntry, data map[string]any) {
	// Extract standard fields
	if msg, ok := data["message"].(string); ok {
		entry.Message = msg
	} else if msg, ok := data["msg"].(string); ok {
		entry.Message = msg
	}

	if level, ok := data["level"].(string); ok {
		entry.Level = models.ParseLogLevel(level)
	}

	if ts, ok := data["timestamp"].(string); ok {
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			entry.Timestamp = t
		}
	}

	if service, ok := data["service"].(string); ok {
		entry.Service = service
	}

	if host, ok := data["host"].(string); ok {
		entry.Host = host
	}

	// Store all fields
	maps.Copy(entry.Fields, data)
}

// startFileTailing starts tailing log files
func (c *Collector) startFileTailing() error {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	c.fileWatcher = watcher

	// Start tailers for each file
	for _, path := range c.filePaths {
		tailer, err := NewFileTailer(path, c.parseJSON, c.pipeline)
		if err != nil {
			return fmt.Errorf("creating tailer for %s: %w", path, err)
		}

		c.fileTailers[path] = tailer

		if err := tailer.Start(); err != nil {
			return fmt.Errorf("starting tailer for %s: %w", path, err)
		}

		// Watch file for changes
		if err := watcher.Add(path); err != nil {
			return fmt.Errorf("watching %s: %w", path, err)
		}
	}

	c.wg.Add(1)
	go c.handleFileEvents()

	return nil
}

// handleFileEvents handles file system events
func (c *Collector) handleFileEvents() {
	defer c.wg.Done()

	for {
		select {
		case event, ok := <-c.fileWatcher.Events:
			if !ok {
				return
			}

			if event.Op&fsnotify.Write == fsnotify.Write {
				// File was written to, tailer will pick it up
				continue
			}

			if event.Op&fsnotify.Remove == fsnotify.Remove {
				// File was removed, restart tailer
				if tailer, ok := c.fileTailers[event.Name]; ok {
					tailer.Stop()
					// Wait for file to be recreated
				}
			}

		case err, ok := <-c.fileWatcher.Errors:
			if !ok {
				return
			}
			_ = err // Log error

		case <-c.stopCh:
			return
		}
	}
}

// Stop stops the collector
func (c *Collector) Stop(ctx context.Context) error {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return nil
	}
	c.running = false
	close(c.stopCh)
	c.mu.Unlock()

	c.stopSyslog()
	c.stopFileTailing()

	c.wg.Wait()
	return nil
}

// stopSyslog stops syslog listener
func (c *Collector) stopSyslog() {
	if c.syslogListener != nil {
		c.syslogListener.Close()
	}
}

// stopFileTailing stops file tailing
func (c *Collector) stopFileTailing() {
	if c.fileWatcher != nil {
		c.fileWatcher.Close()
	}

	for _, tailer := range c.fileTailers {
		tailer.Stop()
	}
}

// FileTailer tails a log file
type FileTailer struct {
	path      string
	parseJSON bool
	pipeline  *pipeline.Pipeline

	file    *os.File
	reader  *bufio.Reader
	stopCh  chan struct{}
	running bool
}

// NewFileTailer creates a new file tailer
func NewFileTailer(path string, parseJSON bool, pipeline *pipeline.Pipeline) (*FileTailer, error) {
	return &FileTailer{
		path:      path,
		parseJSON: parseJSON,
		pipeline:  pipeline,
	}, nil
}

// Start starts tailing the file
func (t *FileTailer) Start() error {
	file, err := os.Open(t.path)
	if err != nil {
		return err
	}

	t.file = file
	t.reader = bufio.NewReader(file)
	t.stopCh = make(chan struct{})
	t.running = true

	// Seek to end of file
	file.Seek(0, io.SeekEnd)

	go t.tailLoop()

	return nil
}

// tailLoop continuously reads from file
func (t *FileTailer) tailLoop() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			t.readLines()
		case <-t.stopCh:
			return
		}
	}
}

// readLines reads new lines from file
func (t *FileTailer) readLines() {
	for {
		line, err := t.reader.ReadString('\n')
		if err != nil {
			break
		}

		entry := t.parseLine(line)
		if entry != nil {
			t.pipeline.ProcessLog(context.Background(), entry)
		}
	}
}

// parseLine parses a log line
func (t *FileTailer) parseLine(line string) *models.LogEntry {
	entry := &models.LogEntry{
		Timestamp: time.Now(),
		Message:   line,
		Fields:    make(map[string]any),
		Level:     models.LogLevelInfo,
	}

	if t.parseJSON {
		var jsonData map[string]any
		if err := json.Unmarshal([]byte(line), &jsonData); err == nil {
			// Extract fields similar to syslog
			return entry
		}
	}

	return entry
}

// Stop stops the tailer
func (t *FileTailer) Stop() {
	if t.running {
		close(t.stopCh)
		t.running = false
	}

	if t.file != nil {
		t.file.Close()
	}
}
