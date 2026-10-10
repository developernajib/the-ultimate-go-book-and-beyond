package parser

import "time"

// PipelineConfig represents the parsed .pipeline.yaml
type PipelineConfig struct {
	Name          string              `yaml:"name"`
	Description   string              `yaml:"description,omitempty"`
	On            TriggerConfig       `yaml:"on"`
	Env           map[string]string   `yaml:"env,omitempty"`
	Variables     map[string]string   `yaml:"variables,omitempty"`
	Cache         *CacheConfig        `yaml:"cache,omitempty"`
	Stages        []StageConfig       `yaml:"stages"`
	Matrix        *MatrixConfig       `yaml:"matrix,omitempty"`
	Notifications *NotificationConfig `yaml:"notifications,omitempty"`
}

// TriggerConfig defines when the pipeline runs
type TriggerConfig struct {
	Push             *PushTrigger        `yaml:"push,omitempty"`
	PullRequest      *PullRequestTrigger `yaml:"pull_request,omitempty"`
	Schedule         []ScheduleTrigger   `yaml:"schedule,omitempty"`
	WorkflowDispatch bool                `yaml:"workflow_dispatch,omitempty"`
}

type PushTrigger struct {
	Branches []string `yaml:"branches,omitempty"`
	Tags     []string `yaml:"tags,omitempty"`
	Paths    []string `yaml:"paths,omitempty"`
}

type PullRequestTrigger struct {
	Branches []string `yaml:"branches,omitempty"`
	Types    []string `yaml:"types,omitempty"` // opened, synchronize, reopened
}

type ScheduleTrigger struct {
	Cron string `yaml:"cron"`
}

// StageConfig represents a pipeline stage
type StageConfig struct {
	Name      string      `yaml:"name"`
	Condition string      `yaml:"condition,omitempty"`
	Parallel  int         `yaml:"parallel,omitempty"`
	Jobs      []JobConfig `yaml:"jobs"`
}

// JobConfig represents a job within a stage
type JobConfig struct {
	Name         string            `yaml:"name"`
	Image        string            `yaml:"image"`
	DependsOn    []string          `yaml:"depends_on,omitempty"`
	Condition    string            `yaml:"condition,omitempty"`
	Timeout      time.Duration     `yaml:"timeout,omitempty"`
	Retry        *RetryConfig      `yaml:"retry,omitempty"`
	Env          map[string]string `yaml:"env,omitempty"`
	Secrets      []string          `yaml:"secrets,omitempty"`
	Services     []ServiceConfig   `yaml:"services,omitempty"`
	Cache        *CacheConfig      `yaml:"cache,omitempty"`
	BeforeScript []string          `yaml:"before_script,omitempty"`
	Steps        []StepConfig      `yaml:"steps"`
	AfterScript  []string          `yaml:"after_script,omitempty"`
	Artifacts    *ArtifactConfig   `yaml:"artifacts,omitempty"`
}

// StepConfig represents a single step in a job
type StepConfig struct {
	Name    string            `yaml:"name,omitempty"`
	Run     string            `yaml:"run,omitempty"`
	Shell   string            `yaml:"shell,omitempty"` // bash, sh, powershell
	Env     map[string]string `yaml:"env,omitempty"`
	WorkDir string            `yaml:"work_dir,omitempty"`
}

// ServiceConfig represents a service container (e.g., database)
type ServiceConfig struct {
	Name    string            `yaml:"name"`
	Image   string            `yaml:"image"`
	Env     map[string]string `yaml:"env,omitempty"`
	Ports   []string          `yaml:"ports,omitempty"`
	Options []string          `yaml:"options,omitempty"` // Docker options
}

// CacheConfig defines cache behavior
type CacheConfig struct {
	Paths []string `yaml:"paths"`
	Key   string   `yaml:"key,omitempty"`
}

// ArtifactConfig defines artifact collection
type ArtifactConfig struct {
	Paths    []string      `yaml:"paths"`
	Name     string        `yaml:"name,omitempty"`
	ExpireIn time.Duration `yaml:"expire_in,omitempty"`
}

// RetryConfig defines retry behavior
type RetryConfig struct {
	Max     int           `yaml:"max"`
	Backoff time.Duration `yaml:"backoff,omitempty"`
}

// MatrixConfig defines matrix builds
type MatrixConfig struct {
	Include []map[string]string `yaml:"include"`
}

// NotificationConfig defines notification settings
type NotificationConfig struct {
	Email   []string `yaml:"email,omitempty"`
	Slack   string   `yaml:"slack,omitempty"`
	Webhook string   `yaml:"webhook,omitempty"`
}
