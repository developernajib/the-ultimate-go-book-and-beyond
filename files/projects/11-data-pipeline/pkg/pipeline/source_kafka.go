// pkg/pipeline/source_kafka.go
package pipeline

import (
    "context"
    "encoding/json"
    "fmt"
    "time"

    "github.com/segmentio/kafka-go"
)

// KafkaSource reads from Kafka
type KafkaSource struct {
    brokers []string
    topic   string
    groupID string
    reader  *kafka.Reader
}

func NewKafkaSource(brokers []string, topic, groupID string) *KafkaSource {
    return &KafkaSource{
        brokers: brokers,
        topic:   topic,
        groupID: groupID,
    }
}

func (s *KafkaSource) Name() string {
    return fmt.Sprintf("Kafka(%s)", s.topic)
}

func (s *KafkaSource) Read(ctx context.Context) (<-chan Element, error) {
    s.reader = kafka.NewReader(kafka.ReaderConfig{
        Brokers:  s.brokers,
        Topic:    s.topic,
        GroupID:  s.groupID,
        MinBytes: 10e3, // 10KB
        MaxBytes: 10e6, // 10MB
    })

    out := make(chan Element, 100)

    go func() {
        defer close(out)
        defer s.reader.Close()

        for {
            msg, err := s.reader.FetchMessage(ctx)
            if err != nil {
                if err == context.Canceled || err == context.DeadlineExceeded {
                    return
                }
                // Log error and continue
                continue
            }

            // Parse message
            var value any
            if err := json.Unmarshal(msg.Value, &value); err != nil {
                value = string(msg.Value)
            }

            elem := Element{
                Value:     value,
                Key:       string(msg.Key),
                Timestamp: time.Now(),
                EventTime: msg.Time,
            }

            select {
            case out <- elem:
                // Commit message
                if err := s.reader.CommitMessages(ctx, msg); err != nil {
                    // Log error
                }
            case <-ctx.Done():
                return
            }
        }
    }()

    return out, nil
}

func (s *KafkaSource) EstimateSize() int64 {
    return -1 // Unbounded
}

func (s *KafkaSource) Split(desiredBundles int) ([]Source, error) {
    // Could split by partition
    return nil, fmt.Errorf("splitting not supported for Kafka source")
}

func (s *KafkaSource) GetWatermarkEstimator() WatermarkEstimator {
    return NewBoundedOutOfOrdernessWatermark(5 * time.Second)
}
