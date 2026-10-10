## Company Case Studies: CI/CD at Scale

Understanding how major companies have solved CI/CD challenges at massive scale can inform your own design decisions. Each company below faced unique constraints around performance, reliability, and developer experience that shaped their architecture. The code examples in this section are simplified versions of production patterns, showing how these platforms handle workflow orchestration, distributed builds, and container-based execution at scale.

### GitHub Actions: Workflow Orchestration

GitHub Actions runs millions of workflows daily:

```go
// GitHub Actions-style workflow orchestration
package actions

import (
    "context"
    "sync"
    "time"
)

// WorkflowService manages workflow execution
type WorkflowService struct {
    workflowStore   *WorkflowStore
    runnerPool      *RunnerPool
    secretsManager  *SecretsManager
    artifactStore   *ArtifactStore
    webhookService  *WebhookService
}

// Workflow represents a GitHub Actions workflow
type Workflow struct {
    ID          string            `json:"id"`
    Name        string            `json:"name"`
    On          *WorkflowTrigger  `json:"on"`
    Env         map[string]string `json:"env"`
    Jobs        map[string]*Job   `json:"jobs"`
    Concurrency *ConcurrencyConfig `json:"concurrency,omitempty"`
}

// Job represents a workflow job
type Job struct {
    Name         string              `json:"name"`
    RunsOn       string              `json:"runs-on"`
    Needs        []string            `json:"needs,omitempty"`
    If           string              `json:"if,omitempty"`
    Env          map[string]string   `json:"env,omitempty"`
    Steps        []*Step             `json:"steps"`
    Outputs      map[string]string   `json:"outputs,omitempty"`
    Strategy     *MatrixStrategy     `json:"strategy,omitempty"`
    Container    *ContainerConfig    `json:"container,omitempty"`
    Services     map[string]*Service `json:"services,omitempty"`
    TimeoutMin   int                 `json:"timeout-minutes"`
}

// Step represents a job step
type Step struct {
    ID         string            `json:"id,omitempty"`
    Name       string            `json:"name,omitempty"`
    Uses       string            `json:"uses,omitempty"`
    Run        string            `json:"run,omitempty"`
    With       map[string]string `json:"with,omitempty"`
    Env        map[string]string `json:"env,omitempty"`
    If         string            `json:"if,omitempty"`
    Shell      string            `json:"shell,omitempty"`
    WorkingDir string            `json:"working-directory,omitempty"`
}

// TriggerWorkflow initiates a workflow run
func (s *WorkflowService) TriggerWorkflow(ctx context.Context, req *WorkflowTriggerRequest) (*WorkflowRun, error) {
    // Parse workflow YAML
    workflow, err := s.workflowStore.GetWorkflow(ctx, req.RepoID, req.WorkflowPath)
    if err != nil {
        return nil, err
    }

    // Evaluate trigger conditions
    if !s.matchesTrigger(workflow.On, req.Event) {
        return nil, ErrTriggerNotMatched
    }

    // Create workflow run
    run := &WorkflowRun{
        ID:         generateRunID(),
        WorkflowID: workflow.ID,
        RepoID:     req.RepoID,
        Ref:        req.Ref,
        SHA:        req.SHA,
        Event:      req.Event,
        Status:     "queued",
        CreatedAt:  time.Now(),
    }

    // Evaluate concurrency settings
    if workflow.Concurrency != nil {
        s.handleConcurrency(ctx, run, workflow.Concurrency)
    }

    // Build job graph with dependencies
    jobGraph := s.buildJobGraph(workflow.Jobs)

    // Expand matrix jobs
    expandedJobs := s.expandMatrix(jobGraph)

    // Queue jobs that have no dependencies
    for _, job := range expandedJobs {
        if len(job.Needs) == 0 {
            s.queueJob(ctx, run, job)
        }
    }

    return run, nil
}

// ExecuteJob runs a job on an available runner
func (s *WorkflowService) ExecuteJob(ctx context.Context, run *WorkflowRun, job *Job) error {
    // Acquire runner
    runner, err := s.runnerPool.AcquireRunner(ctx, job.RunsOn)
    if err != nil {
        return err
    }
    defer s.runnerPool.ReleaseRunner(runner)

    // Prepare execution context
    execCtx := &JobExecutionContext{
        Run:       run,
        Job:       job,
        Runner:    runner,
        Secrets:   s.secretsManager.GetSecrets(ctx, run.RepoID),
        Variables: s.buildVariables(run, job),
    }

    // Start services (e.g., postgres, redis)
    if len(job.Services) > 0 {
        services, err := runner.StartServices(ctx, job.Services)
        if err != nil {
            return err
        }
        defer runner.StopServices(ctx, services)
        execCtx.ServicePorts = services
    }

    // Execute each step
    for i, step := range job.Steps {
        // Evaluate conditional
        if step.If != "" && !s.evaluateCondition(step.If, execCtx) {
            continue
        }

        stepResult, err := s.executeStep(ctx, execCtx, step)
        if err != nil {
            job.Status = "failure"
            return err
        }

        execCtx.StepOutputs[i] = stepResult.Outputs
    }

    job.Status = "success"

    // Trigger dependent jobs
    s.triggerDependentJobs(ctx, run, job)

    return nil
}

// executeStep runs a single step
func (s *WorkflowService) executeStep(ctx context.Context, execCtx *JobExecutionContext, step *Step) (*StepResult, error) {
    if step.Uses != "" {
        // Execute action
        return s.executeAction(ctx, execCtx, step)
    }

    // Execute shell command
    return execCtx.Runner.ExecuteShell(ctx, &ShellCommand{
        Script:     step.Run,
        Shell:      step.Shell,
        WorkingDir: step.WorkingDir,
        Env:        s.mergeEnv(execCtx, step.Env),
        Timeout:    time.Duration(execCtx.Job.TimeoutMin) * time.Minute,
    })
}
```

### Jenkins: Pipeline as Code

Jenkins pipeline patterns at enterprise scale:

```go
// Jenkins-style pipeline service
package jenkins

import (
    "context"
    "time"
)

// PipelineService manages Jenkins pipelines
type PipelineService struct {
    nodePool      *NodePool
    artifactStore *ArtifactStore
    credStore     *CredentialStore
    scmService    *SCMService
}

// Pipeline represents a Jenkins pipeline
type Pipeline struct {
    Name         string            `json:"name"`
    Definition   *PipelineDefinition `json:"definition"`
    Parameters   []*Parameter      `json:"parameters"`
    Triggers     []*Trigger        `json:"triggers"`
    Properties   *PipelineProperties `json:"properties"`
}

// PipelineDefinition is the Jenkinsfile equivalent
type PipelineDefinition struct {
    Agent      *AgentSpec     `json:"agent"`
    Stages     []*Stage       `json:"stages"`
    Post       *PostActions   `json:"post,omitempty"`
    Options    *PipelineOptions `json:"options,omitempty"`
    Environment map[string]string `json:"environment,omitempty"`
}

// Stage represents a pipeline stage
type Stage struct {
    Name       string            `json:"name"`
    Agent      *AgentSpec        `json:"agent,omitempty"`
    When       *WhenCondition    `json:"when,omitempty"`
    Steps      []*PipelineStep   `json:"steps"`
    Parallel   map[string]*Stage `json:"parallel,omitempty"`
    Post       *PostActions      `json:"post,omitempty"`
}

// ExecutePipeline runs a pipeline with stages
func (s *PipelineService) ExecutePipeline(ctx context.Context, pipeline *Pipeline, params map[string]string) (*PipelineRun, error) {
    run := &PipelineRun{
        ID:         generateRunID(),
        Pipeline:   pipeline.Name,
        Parameters: params,
        StartTime:  time.Now(),
        Status:     "running",
    }

    // Checkout SCM
    workspace, err := s.scmService.Checkout(ctx, pipeline.Properties.SCM)
    if err != nil {
        return nil, err
    }
    defer workspace.Cleanup()

    // Set up environment
    env := s.buildEnvironment(pipeline, params)

    // Execute stages
    for _, stage := range pipeline.Definition.Stages {
        stageResult, err := s.executeStage(ctx, run, stage, workspace, env)
        run.StageResults = append(run.StageResults, stageResult)

        if err != nil {
            run.Status = "failure"
            s.executePostActions(ctx, run, pipeline.Definition.Post, "failure")
            return run, nil
        }
    }

    run.Status = "success"
    run.EndTime = time.Now()

    // Execute post-success actions
    s.executePostActions(ctx, run, pipeline.Definition.Post, "success")

    return run, nil
}

// executeStage runs a pipeline stage
func (s *PipelineService) executeStage(ctx context.Context, run *PipelineRun, stage *Stage, workspace *Workspace, env map[string]string) (*StageResult, error) {
    result := &StageResult{
        Name:      stage.Name,
        StartTime: time.Now(),
    }

    // Evaluate when condition
    if stage.When != nil && !s.evaluateWhen(ctx, stage.When, run) {
        result.Status = "skipped"
        return result, nil
    }

    // Handle parallel stages
    if len(stage.Parallel) > 0 {
        return s.executeParallelStages(ctx, run, stage.Parallel, workspace, env)
    }

    // Acquire agent
    agent, err := s.nodePool.AcquireAgent(ctx, stage.Agent)
    if err != nil {
        result.Status = "failure"
        return result, err
    }
    defer s.nodePool.ReleaseAgent(agent)

    // Execute steps
    for _, step := range stage.Steps {
        stepResult, err := s.executeStep(ctx, agent, step, workspace, env)
        result.StepResults = append(result.StepResults, stepResult)

        if err != nil {
            result.Status = "failure"
            result.EndTime = time.Now()
            return result, err
        }
    }

    result.Status = "success"
    result.EndTime = time.Now()
    return result, nil
}
```

### CircleCI: Config-Driven Pipelines

CircleCI's orb-based pipeline system:

```go
// CircleCI-style pipeline with orbs
package circleci

import (
    "context"
    "time"
)

// CircleCIService manages CircleCI pipelines
type CircleCIService struct {
    orbRegistry    *OrbRegistry
    executorPool   *ExecutorPool
    cacheService   *CacheService
    workspaceStore *WorkspaceStore
}

// Config represents a .circleci/config.yml
type Config struct {
    Version    string               `json:"version"`
    Orbs       map[string]string    `json:"orbs,omitempty"`
    Executors  map[string]*Executor `json:"executors,omitempty"`
    Commands   map[string]*Command  `json:"commands,omitempty"`
    Jobs       map[string]*CJob     `json:"jobs"`
    Workflows  map[string]*CWorkflow `json:"workflows"`
}

// Orb represents a reusable CircleCI orb
type Orb struct {
    Name        string              `json:"name"`
    Version     string              `json:"version"`
    Description string              `json:"description"`
    Executors   map[string]*Executor `json:"executors,omitempty"`
    Commands    map[string]*Command  `json:"commands,omitempty"`
    Jobs        map[string]*CJob     `json:"jobs,omitempty"`
}

// ExecutePipeline runs a CircleCI pipeline
func (s *CircleCIService) ExecutePipeline(ctx context.Context, config *Config, trigger *PipelineTrigger) (*PipelineRun, error) {
    // Resolve orbs
    resolvedOrbs := make(map[string]*Orb)
    for alias, orbRef := range config.Orbs {
        orb, err := s.orbRegistry.GetOrb(ctx, orbRef)
        if err != nil {
            return nil, fmt.Errorf("failed to resolve orb %s: %w", orbRef, err)
        }
        resolvedOrbs[alias] = orb
    }

    // Merge orb definitions into config
    mergedConfig := s.mergeOrbs(config, resolvedOrbs)

    run := &PipelineRun{
        ID:        generatePipelineID(),
        Trigger:   trigger,
        Config:    mergedConfig,
        Status:    "running",
        StartTime: time.Now(),
    }

    // Find matching workflow
    for name, workflow := range mergedConfig.Workflows {
        if s.matchesFilters(workflow.Filters, trigger) {
            workflowRun, err := s.executeWorkflow(ctx, run, name, workflow, mergedConfig)
            run.WorkflowRuns = append(run.WorkflowRuns, workflowRun)
            if err != nil {
                run.Status = "failure"
                break
            }
        }
    }

    if run.Status == "running" {
        run.Status = "success"
    }
    run.EndTime = time.Now()

    return run, nil
}

// executeWorkflow runs workflow with job dependencies
func (s *CircleCIService) executeWorkflow(ctx context.Context, pipelineRun *PipelineRun, name string, workflow *CWorkflow, config *Config) (*WorkflowRun, error) {
    workflowRun := &WorkflowRun{
        Name:      name,
        StartTime: time.Now(),
    }

    // Build job dependency graph
    jobGraph := s.buildJobGraph(workflow.Jobs)

    // Execute jobs respecting dependencies
    completed := make(map[string]bool)
    var mu sync.Mutex

    for len(completed) < len(workflow.Jobs) {
        // Find ready jobs
        readyJobs := s.findReadyJobs(jobGraph, completed)
        if len(readyJobs) == 0 && len(completed) < len(workflow.Jobs) {
            return workflowRun, fmt.Errorf("circular dependency detected")
        }

        // Execute ready jobs in parallel
        var wg sync.WaitGroup
        for _, jobConfig := range readyJobs {
            wg.Add(1)
            go func(jc *WorkflowJobConfig) {
                defer wg.Done()

                job := config.Jobs[jc.Name]
                jobRun := s.executeJob(ctx, pipelineRun, jc.Name, job, config)

                mu.Lock()
                workflowRun.JobRuns = append(workflowRun.JobRuns, jobRun)
                completed[jc.Name] = jobRun.Status == "success"
                mu.Unlock()
            }(jobConfig)
        }
        wg.Wait()
    }

    workflowRun.EndTime = time.Now()
    return workflowRun, nil
}
```

### GitLab CI: Auto DevOps

GitLab's integrated CI/CD platform:

```go
// GitLab CI/CD service
package gitlab

import (
    "context"
    "time"
)

// GitLabCIService manages GitLab CI pipelines
type GitLabCIService struct {
    runnerManager  *RunnerManager
    registryClient *ContainerRegistry
    reviewApps     *ReviewAppService
    dast           *DASTService
}

// GitLabPipeline represents a .gitlab-ci.yml pipeline
type GitLabPipeline struct {
    Stages        []string                  `json:"stages"`
    Variables     map[string]string         `json:"variables,omitempty"`
    Default       *JobDefaults              `json:"default,omitempty"`
    Include       []*IncludeConfig          `json:"include,omitempty"`
    Jobs          map[string]*GitLabJob     `json:"jobs"`
}

// GitLabJob represents a pipeline job
type GitLabJob struct {
    Stage         string              `json:"stage"`
    Image         string              `json:"image,omitempty"`
    Script        []string            `json:"script"`
    BeforeScript  []string            `json:"before_script,omitempty"`
    AfterScript   []string            `json:"after_script,omitempty"`
    Variables     map[string]string   `json:"variables,omitempty"`
    Artifacts     *ArtifactsConfig    `json:"artifacts,omitempty"`
    Cache         *CacheConfig        `json:"cache,omitempty"`
    Services      []string            `json:"services,omitempty"`
    Rules         []*JobRule          `json:"rules,omitempty"`
    Needs         []string            `json:"needs,omitempty"`
    Environment   *EnvironmentConfig  `json:"environment,omitempty"`
    Tags          []string            `json:"tags,omitempty"`
    Retry         *RetryConfig        `json:"retry,omitempty"`
    Parallel      int                 `json:"parallel,omitempty"`
}

// AutoDevOps generates pipeline from project analysis
func (s *GitLabCIService) AutoDevOps(ctx context.Context, project *Project) (*GitLabPipeline, error) {
    // Detect project type
    projectType := s.detectProjectType(ctx, project)

    pipeline := &GitLabPipeline{
        Stages: []string{"build", "test", "review", "dast", "staging", "production"},
        Jobs:   make(map[string]*GitLabJob),
    }

    // Generate build job
    pipeline.Jobs["build"] = s.generateBuildJob(projectType)

    // Generate test jobs
    pipeline.Jobs["test"] = s.generateTestJob(projectType)
    pipeline.Jobs["code_quality"] = s.generateCodeQualityJob()
    pipeline.Jobs["container_scan"] = s.generateContainerScanJob()

    // Review apps for MRs
    pipeline.Jobs["review"] = &GitLabJob{
        Stage:  "review",
        Script: s.reviewApps.GenerateDeployScript(project),
        Environment: &EnvironmentConfig{
            Name:       "review/$CI_COMMIT_REF_SLUG",
            URL:        "https://$CI_ENVIRONMENT_SLUG.review.example.com",
            OnStop:     "stop_review",
            AutoStopIn: "1 week",
        },
        Rules: []*JobRule{
            {If: "$CI_MERGE_REQUEST_IID"},
        },
    }

    // DAST scanning
    pipeline.Jobs["dast"] = &GitLabJob{
        Stage:  "dast",
        Image:  "registry.gitlab.com/gitlab-org/security-products/dast:latest",
        Script: s.dast.GenerateScanScript(),
        Needs:  []string{"review"},
        Rules: []*JobRule{
            {If: "$CI_MERGE_REQUEST_IID"},
        },
    }

    // Staging deployment
    pipeline.Jobs["staging"] = s.generateDeployJob("staging", project)

    // Production deployment with manual approval
    pipeline.Jobs["production"] = &GitLabJob{
        Stage:  "production",
        Script: s.generateDeployScript(project, "production"),
        Environment: &EnvironmentConfig{
            Name: "production",
            URL:  "https://example.com",
        },
        Rules: []*JobRule{
            {If: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH", When: "manual"},
        },
    }

    return pipeline, nil
}
```

### Key Takeaways from Industry Leaders

| Platform | Key Innovation | Scale |
|----------|---------------|-------|
| GitHub Actions | Marketplace ecosystem, matrix builds | 100M+ runs/day |
| Jenkins | Pipeline as code, plugin ecosystem | Most deployed CI |
| CircleCI | Orbs (reusable configs), caching | Enterprise-grade |
| GitLab CI | Integrated DevSecOps, Auto DevOps | Complete platform |

---
