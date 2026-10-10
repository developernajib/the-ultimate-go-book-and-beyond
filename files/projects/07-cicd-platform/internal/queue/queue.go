package queue

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	jobQueueKey = "cicd:job_queue"
)

// ErrEmptyQueue is returned when the queue is empty
var ErrEmptyQueue = errors.New("queue is empty")

// JobMessage represents a job queued for execution
type JobMessage struct {
	JobRunID      uuid.UUID `json:"job_run_id"`
	PipelineRunID uuid.UUID `json:"pipeline_run_id"`
	Priority      int       `json:"priority"`
}

// JobQueue manages the job execution queue using Redis
type JobQueue struct {
	client *redis.Client
}

// NewRedisQueue creates a new Redis-backed job queue
func NewRedisQueue(redisURL string) (*JobQueue, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	client := redis.NewClient(opts)

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("ping redis: %w", err)
	}

	return &JobQueue{client: client}, nil
}

// Enqueue adds a job to the queue
func (q *JobQueue) Enqueue(ctx context.Context, msg *JobMessage) error {
	data := fmt.Sprintf("%s:%s:%d", msg.JobRunID.String(), msg.PipelineRunID.String(), msg.Priority)

	if err := q.client.LPush(ctx, jobQueueKey, data).Err(); err != nil {
		return fmt.Errorf("enqueue job: %w", err)
	}

	return nil
}

// Dequeue removes and returns a job from the queue
func (q *JobQueue) Dequeue(ctx context.Context) (*JobMessage, error) {
	result, err := q.client.RPop(ctx, jobQueueKey).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil, ErrEmptyQueue
		}
		return nil, fmt.Errorf("dequeue job: %w", err)
	}

	// Parse the message
	var jobRunID, pipelineRunID uuid.UUID
	var priority int

	n, parseErr := fmt.Sscanf(result, "%s:%s:%d", &jobRunID, &pipelineRunID, &priority)
	if parseErr != nil || n < 2 {
		// Try simpler parsing: just extract the job run ID
		jobRunIDStr := result
		if len(result) >= 36 {
			jobRunIDStr = result[:36]
		}
		parsedID, idErr := uuid.Parse(jobRunIDStr)
		if idErr != nil {
			return nil, fmt.Errorf("parse job message: %w", parseErr)
		}
		return &JobMessage{
			JobRunID: parsedID,
		}, nil
	}

	return &JobMessage{
		JobRunID:      jobRunID,
		PipelineRunID: pipelineRunID,
		Priority:      priority,
	}, nil
}

// Len returns the number of jobs in the queue
func (q *JobQueue) Len(ctx context.Context) (int64, error) {
	return q.client.LLen(ctx, jobQueueKey).Result()
}

// Close closes the Redis connection
func (q *JobQueue) Close() error {
	return q.client.Close()
}
