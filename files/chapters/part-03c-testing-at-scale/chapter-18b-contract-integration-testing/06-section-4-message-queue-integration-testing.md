## Section 4: Message Queue Integration Testing

### 4.1 Kafka Integration Tests with Testcontainers

Testing Kafka producers and consumers requires a real broker to verify serialization format, partition assignment, offset commit behavior, and consumer group rebalancing. A mock simulates none of these faithfully. Testcontainers-go's Kafka module starts a real Kafka broker (backed by KRaft or Zookeeper depending on the image version) and exposes its bootstrap address for the test suite. The test below verifies an end-to-end message flow: the producer publishes a domain event, the consumer group processes it, and the test asserts the expected side effects in the downstream database.

```go
package kafkaintegration_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	kgo "github.com/segmentio/kafka-go"
	tckgo "github.com/testcontainers/testcontainers-go/modules/kafka"
)

// KafkaTestEnvironment provides a throwaway Kafka broker.
type KafkaTestEnvironment struct {
	container *tckgo.KafkaContainer
	Brokers   []string
}

// NewKafkaTestEnvironment starts a Kafka container.
// testcontainers-go v0.42+ exposes module-level Run() - older RunContainer()
// is deprecated but still functional.
func NewKafkaTestEnvironment(ctx context.Context, t *testing.T) *KafkaTestEnvironment {
	t.Helper()

	kafkaContainer, err := tckgo.Run(ctx,
		"confluentinc/confluent-local:7.6.0",
		tckgo.WithClusterID("test-cluster"),
	)
	if err != nil {
		t.Fatalf("start kafka: %v", err)
	}

	t.Cleanup(func() {
		kafkaContainer.Terminate(ctx)
	})

	brokers, err := kafkaContainer.Brokers(ctx)
	if err != nil {
		t.Fatalf("get brokers: %v", err)
	}

	return &KafkaTestEnvironment{
		container: kafkaContainer,
		Brokers:   brokers,
	}
}

// CreateTopic creates a Kafka topic for testing.
func (e *KafkaTestEnvironment) CreateTopic(ctx context.Context, t *testing.T, topic string, partitions int) {
	t.Helper()
	conn, err := kgo.DialLeader(ctx, "tcp", e.Brokers[0], topic, 0)
	if err != nil {
		t.Fatalf("dial kafka: %v", err)
	}
	defer conn.Close()

	err = conn.CreateTopics(kgo.TopicConfig{
		Topic:             topic,
		NumPartitions:     partitions,
		ReplicationFactor: 1,
	})
	if err != nil {
		t.Logf("create topic (may already exist): %v", err)
	}
}

// TestKafkaProducerConsumer tests publish and consume round-trip.
func TestKafkaProducerConsumer(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping kafka integration test")
	}

	ctx := context.Background()
	env := NewKafkaTestEnvironment(ctx, t)

	topic := "test-events-" + fmt.Sprintf("%d", time.Now().UnixNano())
	env.CreateTopic(ctx, t, topic, 3)

	// Producer
	writer := &kgo.Writer{
		Addr:     kgo.TCP(env.Brokers...),
		Topic:    topic,
		Balancer: &kgo.LeastBytes{},
	}
	defer writer.Close()

	// Publish 5 messages
	messages := make([]kgo.Message, 5)
	for i := range messages {
		messages[i] = kgo.Message{
			Key:   []byte(fmt.Sprintf("key-%d", i)),
			Value: []byte(fmt.Sprintf(`{"event":"test","seq":%d}`, i)),
		}
	}

	if err := writer.WriteMessages(ctx, messages...); err != nil {
		t.Fatalf("write messages: %v", err)
	}

	// Consumer
	reader := kgo.NewReader(kgo.ReaderConfig{
		Brokers:     env.Brokers,
		Topic:       topic,
		GroupID:     "test-consumer-" + fmt.Sprintf("%d", time.Now().UnixNano()),
		MinBytes:    1,
		MaxBytes:    10 << 20,
		MaxWait:     500 * time.Millisecond,
		StartOffset: kgo.FirstOffset,
	})
	defer reader.Close()

	// Read 5 messages with a deadline. Assert on the decoded payload, not
	// just the count: a test that only counts messages passes even when the
	// producer publishes garbage. Section 4.5 makes this the general rule.
	type event struct {
		Event string `json:"event"`
		Seq   int    `json:"seq"`
	}

	deadline := time.Now().Add(30 * time.Second)
	seen := make(map[int]string) // seq -> key, so we can detect dupes and gaps
	for len(seen) < 5 {
		readCtx, cancel := context.WithDeadline(ctx, deadline)
		msg, err := reader.FetchMessage(readCtx)
		cancel()
		if err != nil {
			t.Fatalf("fetch message (got %d/5 so far): %v", len(seen), err)
		}

		var ev event
		if err := json.Unmarshal(msg.Value, &ev); err != nil {
			t.Fatalf("message %q is not valid JSON: %v", msg.Value, err)
		}
		if ev.Event != "test" {
			t.Errorf("seq %d: want event=test, got %q", ev.Seq, ev.Event)
		}
		if _, dup := seen[ev.Seq]; dup {
			t.Errorf("seq %d delivered more than once", ev.Seq)
		}
		seen[ev.Seq] = string(msg.Key)

		if err := reader.CommitMessages(ctx, msg); err != nil {
			t.Fatalf("commit: %v", err)
		}
	}

	// Every sequence number 0..4 must have arrived, each under its own key.
	for i := 0; i < 5; i++ {
		key, ok := seen[i]
		if !ok {
			t.Errorf("never received message with seq=%d", i)
			continue
		}
		if want := fmt.Sprintf("key-%d", i); key != want {
			t.Errorf("seq %d: want key %q, got %q", i, want, key)
		}
	}
}
```

### 4.2 RabbitMQ Integration Tests

RabbitMQ integration tests follow the same pattern as Kafka but typically verify exchange/queue topology, routing keys, dead-letter handling, and publisher confirms. The testcontainers-go RabbitMQ module starts a real broker and exposes an AMQP URL.

```go
package rabbitintegration_test

import (
	"context"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go/modules/rabbitmq"
	amqp "github.com/rabbitmq/amqp091-go"
)

func TestRabbitMQPublishConsume(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping rabbitmq integration test")
	}
	ctx := context.Background()

	rmq, err := rabbitmq.Run(ctx,
		"rabbitmq:3.13-management-alpine",
		rabbitmq.WithAdminUsername("test"),
		rabbitmq.WithAdminPassword("test"),
	)
	if err != nil {
		t.Fatalf("start rabbitmq: %v", err)
	}
	t.Cleanup(func() { _ = rmq.Terminate(ctx) })

	amqpURL, err := rmq.AmqpURL(ctx)
	if err != nil {
		t.Fatalf("amqp url: %v", err)
	}

	conn, err := amqp.Dial(amqpURL)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		t.Fatalf("channel: %v", err)
	}
	defer ch.Close()

	// Enable publisher confirms: critical for testing at-least-once guarantees.
	if err := ch.Confirm(false); err != nil {
		t.Fatalf("enable confirms: %v", err)
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))

	q, err := ch.QueueDeclare("orders", true, false, false, false, nil)
	if err != nil {
		t.Fatalf("declare: %v", err)
	}

	err = ch.PublishWithContext(ctx, "", q.Name, false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Body:         []byte(`{"order_id":"o-1"}`),
	})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case c := <-confirms:
		if !c.Ack {
			t.Fatal("publish was NACKed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no publisher confirm within timeout")
	}

	msgs, err := ch.Consume(q.Name, "", true, false, false, false, nil)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	select {
	case m := <-msgs:
		if string(m.Body) != `{"order_id":"o-1"}` {
			t.Errorf("unexpected body: %s", m.Body)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no message received")
	}
}
```

### 4.3 Schema Registry and Async Contract Testing

HTTP contract testing (Pact) covers request/response pairs. For asynchronous messaging, the contract is the *message schema*. At FAANG scale, teams pair testcontainers with a schema registry (Confluent Schema Registry, Karapace, or Apicurio for Avro and Protobuf) so producers cannot deploy messages that break existing consumers. Two approaches are worth knowing. Pact supports message pacts, which apply the consumer-driven idea to message payloads: the consumer declares the shape it can handle and the producer verifies its serializer against that expectation, with no broker involved in the test. AsyncAPI takes the specification-first route instead, describing channels and payloads in a document you can lint and validate against in CI. The choice mirrors the Pact-versus-OpenAPI trade-off from section 1: message pacts fit independently released teams, AsyncAPI fits a single owner publishing to many consumers.

> **Senior track**: Running a real Kafka broker per test is expensive. Amortize cost by starting one broker per package with `TestMain`, then give each test its own topic name (e.g., suffix with `time.Now().UnixNano()`). Avoid sharing consumer groups across tests, because rebalances will make your assertions flaky. For hermetic testing of serialization compatibility alone, prefer contract tests against the schema registry. Reserve end-to-end broker tests for routing and consumer-group behavior that only the real broker exhibits.

### 4.4 The flaky-integration-test trap

Message-queue integration tests are the most common source of flaky tests in a Go codebase, and the usual culprits are timing assumptions. Three patterns to avoid. First, `time.Sleep(1 * time.Second)` as a "just wait for it to propagate" hack. This works on a fast laptop and fails in a slow CI runner. Replace with polling on a condition ("until the consumer has processed N messages, or 10 seconds have elapsed"). Second, tests that share a topic across runs. A leftover message from a previous test run is consumed by the current test, which then fails mysteriously. Use unique topic names per test run (UUIDs or timestamps). Third, tests that do not wait for consumer group assignment. The consumer starts, the producer publishes, the consumer has not yet been assigned partitions, and the message is missed. Explicitly wait for assignment before publishing. Fixing these three patterns eliminates the vast majority of broker-test flakiness.

### 4.5 Junior → FAANG: the message-shape assertion habit

When testing a message-based integration, always assert two things separately: (1) the message was produced (check the broker or the producer's success callback), and (2) the message has the expected shape (deserialize and field-check). A test that only checks "the handler returned success" is testing the wrong thing, because the handler could have returned success while publishing a malformed message. A test that only checks "the message was received" misses schema regressions. Separating the two assertions catches both failure modes and teaches the habit of thinking about message flow as two distinct operations (publish, consume) that can fail independently.

### 4.6 Senior @ FAANG: schema evolution as a platform concern

Message schema evolution is where FAANG-scale organizations either thrive or suffer. Three practices that scale. First, every message topic has a registered schema in a schema registry (Confluent, Karapace, Apicurio), and producers fail fast if they attempt to publish a message that does not conform. Second, the CI pipeline runs compatibility checks on every PR that touches a schema: can old consumers still read new messages (backward compatibility), can new consumers still read old messages (forward compatibility), or both (full compatibility). The default policy for most message topics should be backward-compatible evolution, with explicit sign-off required to break it. Third, when a breaking change is genuinely needed, the rollout is a two-topic pattern: producers write to both old and new topic, consumers migrate to the new one over time, and the old topic is retired once metrics show zero consumers. The staff-engineer artifact is the written policy, the CI checks that enforce it, and the runbook for handling the occasional legitimate breaking change. Without this infrastructure, schema evolution becomes a source of recurring incidents. With it, incidents in this category largely disappear.

---
