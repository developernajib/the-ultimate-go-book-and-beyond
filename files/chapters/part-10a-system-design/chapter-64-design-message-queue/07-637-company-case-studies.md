## 64.7 Company Case Studies

### Apache Kafka at LinkedIn

LinkedIn processes over 7 trillion messages per day through Kafka (as detailed by Jay Kreps, Neha Narkhede, and Jun Rao in *"Kafka: a Distributed Messaging System for Log Processing"*, NetDB 2011, and the LinkedIn Engineering Blog), using it as the central nervous system for activity stream processing, metrics collection, and data pipeline interconnection. Their usage pattern relies heavily on schema-versioned events validated against a schema registry, enabling producers and consumers to evolve independently without breaking each other's deserialization. The following implementation models LinkedIn's pattern of multi-topic event routing with schema enforcement and exactly-once processing semantics.

```go
// linkedin/kafka_patterns.go
package linkedin

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "github.com/segmentio/kafka-go"
)

// LinkedInEventProcessor handles LinkedIn's activity stream
type LinkedInEventProcessor struct {
    readers    map[string]*kafka.Reader // topic -> reader
    writers    map[string]*kafka.Writer
    schema     *SchemaRegistry
    processors map[string]EventHandler
}

type ActivityEvent struct {
    EventID     string                 `json:"event_id"`
    ActorURN    string                 `json:"actor_urn"`
    VerbType    string                 `json:"verb_type"`
    ObjectURN   string                 `json:"object_urn"`
    Timestamp   time.Time              `json:"timestamp"`
    Attributes  map[string]any `json:"attributes"`
}

// ProcessActivityStream handles real-time activity processing
func (p *LinkedInEventProcessor) ProcessActivityStream(ctx context.Context) error {
    reader := p.readers["activity-stream"]

    for {
        msg, err := reader.FetchMessage(ctx)
        if err != nil {
            return err
        }

        // Schema validation with Avro
        event, err := p.schema.Decode(msg.Value, "activity-event")
        if err != nil {
            // Dead letter queue for malformed messages
            p.sendToDeadLetter(ctx, msg, err)
            reader.CommitMessages(ctx, msg)
            continue
        }

        activity := event.(*ActivityEvent)

        // Fan-out to multiple derived streams
        var wg sync.WaitGroup
        errCh := make(chan error, 4)

        // 1. Update news feed
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := p.updateNewsFeed(ctx, activity); err != nil {
                errCh <- err
            }
        }()

        // 2. Update notification system
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := p.triggerNotifications(ctx, activity); err != nil {
                errCh <- err
            }
        }()

        // 3. Update analytics
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := p.recordAnalytics(ctx, activity); err != nil {
                errCh <- err
            }
        }()

        // 4. Update search index
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := p.updateSearchIndex(ctx, activity); err != nil {
                errCh <- err
            }
        }()

        wg.Wait()
        close(errCh)

        // Commit only if all processors succeeded
        hasError := false
        for err := range errCh {
            if err != nil {
                hasError = true
                break
            }
        }

        if !hasError {
            reader.CommitMessages(ctx, msg)
        }
    }
}
```

### Amazon SQS/SNS Patterns

Amazon's managed messaging services (detailed in the AWS Architecture Center whitepaper *"Fanout Event Architecture with Amazon SNS and Amazon SQS"* and Werner Vogels' architecture analyses on asynchronous messaging at scale) split into two complementary products: SNS for fan-out publish/subscribe (one message delivered to many subscribers) and SQS for point-to-point work queues (each message processed by exactly one consumer). The common pattern combines both: SNS publishes an event to a topic, which fans it out to multiple SQS queues, each consumed by a different downstream service. Visibility timeout on SQS provides at-least-once semantics, a message becomes invisible to other consumers while being processed and reappears if the consumer does not delete it before the timeout.

```go
// amazon/sqs_patterns.go
package amazon

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "time"

    "github.com/aws/aws-sdk-go-v2/aws"
    "github.com/aws/aws-sdk-go-v2/service/sns"
    snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
    "github.com/aws/aws-sdk-go-v2/service/sqs"
)

// AmazonMessaging implements fanout with SNS and processing with SQS
type AmazonMessaging struct {
    snsClient *sns.Client
    sqsClient *sqs.Client
    topicARNs map[string]string
    queueURLs map[string]string
}

// OrderEvent demonstrates event-driven architecture
type OrderEvent struct {
    OrderID    string    `json:"order_id"`
    CustomerID string    `json:"customer_id"`
    Action     string    `json:"action"` // created, updated, shipped, delivered
    Timestamp  time.Time `json:"timestamp"`
    Data       OrderData `json:"data"`
}

// FanOutOrder publishes order event to SNS for fanout
func (m *AmazonMessaging) FanOutOrder(ctx context.Context, event *OrderEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return err
    }

    // A map index expression is not addressable, so copy to a local
    // before taking its address for the *string field.
    topicARN := m.topicARNs["order-events"]

    // Publish to SNS topic (fans out to multiple SQS queues)
    _, err = m.snsClient.Publish(ctx, &sns.PublishInput{
        TopicArn: &topicARN,
        Message:  aws.String(string(data)),
        MessageAttributes: map[string]snstypes.MessageAttributeValue{
            "event_type": {
                DataType:    aws.String("String"),
                StringValue: aws.String(event.Action),
            },
        },
    })

    return err
}

// ProcessOrderQueue processes messages with visibility timeout handling
func (m *AmazonMessaging) ProcessOrderQueue(ctx context.Context, queueName string, handler func(*OrderEvent) error) error {
    queueURL := m.queueURLs[queueName]

    for {
        result, err := m.sqsClient.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
            QueueUrl:            &queueURL,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds:     20, // Long polling
            VisibilityTimeout:   30,
        })
        if err != nil {
            return err
        }

        for _, msg := range result.Messages {
            // Extend visibility timeout for long-running processing
            go m.extendVisibility(ctx, queueURL, *msg.ReceiptHandle)

            var event OrderEvent
            if err := json.Unmarshal([]byte(*msg.Body), &event); err != nil {
                continue
            }

            if err := handler(&event); err != nil {
                // Message will become visible again after timeout
                continue
            }

            // Delete successfully processed message
            m.sqsClient.DeleteMessage(ctx, &sqs.DeleteMessageInput{
                QueueUrl:      &queueURL,
                ReceiptHandle: msg.ReceiptHandle,
            })
        }
    }
}

func (m *AmazonMessaging) extendVisibility(ctx context.Context, queueURL, receiptHandle string) {
    ticker := time.NewTicker(20 * time.Second)
    defer ticker.Stop()

    for range ticker.C {
        _, err := m.sqsClient.ChangeMessageVisibility(ctx, &sqs.ChangeMessageVisibilityInput{
            QueueUrl:          &queueURL,
            ReceiptHandle:     &receiptHandle,
            VisibilityTimeout: 30,
        })
        if err != nil {
            return // Message was deleted or visibility extension failed
        }
    }
}
```

### RabbitMQ at Uber

Uber leverages RabbitMQ (detailed in the Uber Engineering Blog on reliable messaging architectures and task dispatch platforms) for inter-service communication where the broker-based model (push delivery with acknowledgments) is a better fit than Kafka's pull-based log. RabbitMQ's exchange-routing model lets Uber define complex routing topologies: direct exchanges for point-to-point commands, topic exchanges for pattern-based event subscription, and dead-letter exchanges for failed message quarantine. The implementation below models Uber's pattern of exchange-per-service with per-consumer retry policies and automatic dead-letter routing after retry exhaustion.

```go
// uber/rabbitmq_patterns.go
package uber

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    amqp "github.com/rabbitmq/amqp091-go"
)

// UberRabbitMQ implements reliable messaging patterns
type UberRabbitMQ struct {
    conn       *amqp.Connection
    channel    *amqp.Channel
    confirms   chan amqp.Confirmation
    deliveries <-chan amqp.Delivery
}

// PublishWithConfirm ensures message delivery with publisher confirms
func (r *UberRabbitMQ) PublishWithConfirm(ctx context.Context, exchange, routingKey string, message any) error {
    data, err := json.Marshal(message)
    if err != nil {
        return err
    }

    // Enable publisher confirms
    if err := r.channel.Confirm(false); err != nil {
        return err
    }

    r.confirms = r.channel.NotifyPublish(make(chan amqp.Confirmation, 1))

    // Publish message
    err = r.channel.PublishWithContext(ctx,
        exchange,
        routingKey,
        true,  // mandatory - return if no queue
        false, // immediate
        amqp.Publishing{
            DeliveryMode: amqp.Persistent,
            ContentType:  "application/json",
            Body:         data,
            Timestamp:    time.Now(),
            MessageId:    generateMessageID(),
        },
    )
    if err != nil {
        return err
    }

    // Wait for confirmation
    select {
    case confirm := <-r.confirms:
        if !confirm.Ack {
            return fmt.Errorf("message not acknowledged")
        }
        return nil
    case <-time.After(5 * time.Second):
        return fmt.Errorf("confirmation timeout")
    }
}

// ConsumeWithManualAck processes messages with manual acknowledgment
func (r *UberRabbitMQ) ConsumeWithManualAck(ctx context.Context, queue string, handler func([]byte) error) error {
    msgs, err := r.channel.Consume(
        queue,
        "",    // consumer tag
        false, // auto-ack = false for manual ack
        false, // exclusive
        false, // no-local
        false, // no-wait
        nil,
    )
    if err != nil {
        return err
    }

    for msg := range msgs {
        // Process message
        err := handler(msg.Body)

        if err != nil {
            // Reject and requeue
            msg.Nack(false, true)
            continue
        }

        // Acknowledge successful processing
        msg.Ack(false)
    }

    return nil
}
```

---

### Junior -> FAANG: What These Case Studies Reveal About Real-World Queue Usage

Each case study here illustrates a different dimension of message queue usage that textbooks underemphasize.

LinkedIn's schema registry pattern solves the versioning problem that becomes painful after the first production incident: a producer team changes a field name, and consumers start failing with deserialization errors. A schema registry with backward-compatibility enforcement catches this in CI before the change reaches production. The Avro schema registry checks that the new schema can still deserialize messages written with the old schema, so old and new consumers can coexist during a rolling deployment.

The Amazon SNS/SQS fanout pattern illustrates the separation of routing logic from processing logic. SNS owns the question "who should receive this event?" SQS owns the question "when does each receiver process it?" This separation means you can add a new subscriber (a new SQS queue subscribed to the SNS topic) without modifying the producer code at all, which is the Open-Closed principle applied at the infrastructure level.

RabbitMQ's publisher confirms pattern (shown in the Uber example) is the equivalent of Kafka's `acks=1` but for broker-based queues. Without confirms, a producer that calls `Publish` and receives no error has only confirmed that the message reached RabbitMQ's socket buffer, not that it was durably written to disk. The confirm waits for the broker's explicit acknowledgment that the message is persisted.

### Senior @ FAANG: Choosing the Right Queue for the Right Workload

The architectural decision between Kafka, RabbitMQ, and SQS is not a preference, it is a workload analysis. Senior engineers are expected to articulate the trade-offs precisely.

Kafka's log-based model is optimal when: consumers need to replay messages (audit, reprocessing after a bug fix), multiple independent consumer groups need the same data (analytics and fraud detection reading the same payment events), throughput exceeds 100K messages per second, or message order within a partition is a correctness requirement. Kafka's weakness is operational complexity: partition management, rebalancing, offset tracking, and schema registry all require dedicated expertise.

RabbitMQ's broker-based model is optimal when: routing logic is complex (messages must be routed based on multiple attributes, not just a topic key), per-message TTL and priority are needed, or the team lacks the operational capacity to manage a Kafka cluster. RabbitMQ's weakness is that it is not designed for replay: once a message is consumed and acknowledged, it is gone. Consumer groups with independent offsets are not a native concept.

SQS is optimal when: the team wants zero operational overhead and replay is not required. Standard queues offer effectively unlimited throughput (the 3,000 messages per second figure is the FIFO-queue limit with batching, not a standard-queue cap), so throughput is rarely the deciding constraint, ordering and exactly-once needs are. SQS's visibility timeout model is simpler than Kafka's offset model but less flexible: you cannot easily "seek back" to reprocess a batch of messages.

The staff-level question is not which queue to use, it is how to abstract the queue choice behind an interface so that the team can switch providers without rewriting consumer code. The `MessageSource` and `MessageSink` interfaces in the exercise section of this chapter are the right starting point. A Kafka adapter, a RabbitMQ adapter, and an in-memory adapter all implement the same interface, and the business logic never imports a queue-specific package.