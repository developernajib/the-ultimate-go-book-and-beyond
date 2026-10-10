## 100.4 Amazon SQS and SNS

### SQS Operations

SQS decouples producers and consumers through durable message queues, where each message remains invisible to other consumers for a configurable `VisibilityTimeout` period after being received, this prevents duplicate processing without requiring distributed locks. Long polling (`WaitTimeSeconds > 0`) reduces empty-receive API calls and cost by holding the connection open until a message arrives or the timeout expires. Messages must be explicitly deleted after successful processing. If the handler fails, the message becomes visible again after the visibility timeout elapses and will be redelivered, enabling at-least-once delivery semantics.

```go
package messaging

import (
    "context"
    "encoding/json"
    "fmt"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/sqs"
    "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

type SQSClient struct {
    client   *sqs.Client
    queueURL string
}

func NewSQSClient(client *sqs.Client, queueURL string) *SQSClient {
    return &SQSClient{client: client, queueURL: queueURL}
}

type Message struct {
    ID   string `json:"id"`
    Type string `json:"type"`
    Data any    `json:"data"`
}

// Send message
func (c *SQSClient) SendMessage(ctx context.Context, msg Message) error {
    body, err := json.Marshal(msg)
    if err != nil {
        return fmt.Errorf("marshal message: %w", err)
    }

    _, err = c.client.SendMessage(ctx, &sqs.SendMessageInput{
        QueueUrl:    aws.String(c.queueURL),
        MessageBody: aws.String(string(body)),
        MessageAttributes: map[string]types.MessageAttributeValue{
            "Type": {
                DataType:    aws.String("String"),
                StringValue: aws.String(msg.Type),
            },
        },
    })
    if err != nil {
        return fmt.Errorf("send message: %w", err)
    }

    return nil
}

// Send batch messages (up to 10)
func (c *SQSClient) SendBatch(ctx context.Context, messages []Message) error {
    var entries []types.SendMessageBatchRequestEntry

    for i, msg := range messages {
        body, err := json.Marshal(msg)
        if err != nil {
            return fmt.Errorf("marshal message: %w", err)
        }

        entries = append(entries, types.SendMessageBatchRequestEntry{
            Id:          aws.String(fmt.Sprintf("msg-%d", i)),
            MessageBody: aws.String(string(body)),
        })
    }

    _, err := c.client.SendMessageBatch(ctx, &sqs.SendMessageBatchInput{
        QueueUrl: aws.String(c.queueURL),
        Entries:  entries,
    })
    if err != nil {
        return fmt.Errorf("send batch: %w", err)
    }

    return nil
}

// Receive messages
func (c *SQSClient) ReceiveMessages(ctx context.Context, maxMessages int32, waitTime int32) ([]Message, []string, error) {
    result, err := c.client.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
        QueueUrl:            aws.String(c.queueURL),
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds:     waitTime, // Long polling
        VisibilityTimeout:   30,
        MessageAttributeNames: []string{"All"},
    })
    if err != nil {
        return nil, nil, fmt.Errorf("receive messages: %w", err)
    }

    var messages []Message
    var receiptHandles []string

    for _, sqsMsg := range result.Messages {
        var msg Message
        if err := json.Unmarshal([]byte(*sqsMsg.Body), &msg); err != nil {
            continue // Skip invalid messages
        }
        messages = append(messages, msg)
        receiptHandles = append(receiptHandles, *sqsMsg.ReceiptHandle)
    }

    return messages, receiptHandles, nil
}

// Delete message
func (c *SQSClient) DeleteMessage(ctx context.Context, receiptHandle string) error {
    _, err := c.client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
        QueueUrl:      aws.String(c.queueURL),
        ReceiptHandle: aws.String(receiptHandle),
    })
    return err
}

// Delete batch
func (c *SQSClient) DeleteBatch(ctx context.Context, receiptHandles []string) error {
    var entries []types.DeleteMessageBatchRequestEntry

    for i, handle := range receiptHandles {
        entries = append(entries, types.DeleteMessageBatchRequestEntry{
            Id:            aws.String(fmt.Sprintf("msg-%d", i)),
            ReceiptHandle: aws.String(handle),
        })
    }

    _, err := c.client.DeleteMessageBatch(ctx, &sqs.DeleteMessageBatchInput{
        QueueUrl: aws.String(c.queueURL),
        Entries:  entries,
    })
    return err
}

// Worker pattern
func (c *SQSClient) StartWorker(ctx context.Context, handler func(Message) error) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            messages, handles, err := c.ReceiveMessages(ctx, 10, 20)
            if err != nil {
                continue
            }

            for i, msg := range messages {
                if err := handler(msg); err != nil {
                    // Log error, message will become visible again
                    continue
                }
                // Delete successfully processed message
                c.DeleteMessage(ctx, handles[i])
            }
        }
    }
}
```

---

### Junior → FAANG: SQS and SNS as the Foundation of Async Architecture

SQS (a queue) and SNS (a topic with fan-out) solve different problems that are frequently confused. SQS ensures exactly-once processing of a message by one consumer (useful for work queues where each task should be processed once). SNS delivers a message to multiple subscribers simultaneously (useful for events that multiple services need to react to). The two are frequently used together: SNS for fan-out distribution, SQS as the buffer for each consumer.

The SQS visibility timeout is the mechanism that enables at-least-once delivery: when a consumer reads a message, it becomes invisible to other consumers for the visibility timeout duration. The consumer must delete the message after processing to prevent re-delivery. If the consumer crashes before deleting, the message becomes visible again after the timeout and is redelivered. The visibility timeout must be longer than the maximum expected processing time. Otherwise, messages are processed multiple times.

Dead letter queues (DLQ) are the failure handling mechanism: after a configured number of failed delivery attempts, messages are moved to the DLQ for inspection and reprocessing. Always configure a DLQ for production queues, and always monitor DLQ depth as an alert condition.

### Senior @ FAANG: Message Queue Architecture and Exactly-Once Semantics

At staff level, SQS and SNS are components in a larger asynchronous architecture. The design decisions that require staff-level judgment: queue partitioning (one SQS queue per message type versus a generic queue with message type routing), ordering guarantees (standard SQS provides at-least-once with no ordering guarantee, FIFO SQS provides exactly-once within a message group with ordering, at lower throughput and higher cost), and consumer concurrency (how many concurrent consumers per queue, and how the concurrency interacts with the visibility timeout and processing time variance).

Exactly-once semantics is harder to achieve than most engineers realize. SQS standard queues provide at-least-once delivery. FIFO queues provide exactly-once for a given message group ID within a 5-minute deduplication window. Achieving exactly-once end-to-end requires idempotent message processing (the consumer produces the same result when processing the same message multiple times) combined with SQS FIFO's deduplication. Designing idempotent processors is a non-trivial engineering problem that requires careful state management.

The throughput limits of SQS (3,000 messages per second for FIFO, nearly unlimited for standard) and SNS are important for capacity planning. For workloads that exceed SQS throughput limits, Kinesis Data Streams provides an ordered, partitioned streaming model with higher throughput and longer retention, at higher operational complexity. The choice between SQS and Kinesis is a data architecture decision that should be documented in an ADR with specific throughput and ordering requirements as the decision criteria.
