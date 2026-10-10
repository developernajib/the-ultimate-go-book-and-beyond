// pkg/pipeline/sink_kafka.go
package pipeline

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/segmentio/kafka-go"
)

// KafkaSink writes to Kafka
type KafkaSink struct {
	brokers []string
	topic   string
	writer  *kafka.Writer
}

func NewKafkaSink(brokers []string, topic string) *KafkaSink {
	return &KafkaSink{
		brokers: brokers,
		topic:   topic,
	}
}

func (s *KafkaSink) Name() string {
	return fmt.Sprintf("Kafka(%s)", s.topic)
}

func (s *KafkaSink) Write(ctx context.Context, elements <-chan Element) error {
	s.writer = &kafka.Writer{
		Addr:     kafka.TCP(s.brokers...),
		Topic:    s.topic,
		Balancer: &kafka.LeastBytes{},
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case elem, ok := <-elements:
			if !ok {
				return nil
			}

			value, err := json.Marshal(elem.Value)
			if err != nil {
				return err
			}

			var key []byte
			if elem.Key != nil {
				key = fmt.Appendf(nil, "%v", elem.Key)
			}

			msg := kafka.Message{
				Key:   key,
				Value: value,
				Time:  elem.EventTime,
			}

			if err := s.writer.WriteMessages(ctx, msg); err != nil {
				return err
			}
		}
	}
}

func (s *KafkaSink) Close() error {
	if s.writer != nil {
		return s.writer.Close()
	}
	return nil
}
