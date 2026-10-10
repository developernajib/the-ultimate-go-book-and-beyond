## Part 10: Testing and Deployment

Testing a distributed system is fundamentally different from testing a monolithic application. You need integration tests that verify services work correctly together, end-to-end tests that simulate real user workflows across multiple services, and load tests that ensure the system performs well under realistic traffic. This section covers all of these testing strategies and also shows you how to package your services for production deployment using Docker and Kubernetes.

### 10.1 Integration Tests

**services/order/tests/integration/order_saga_test.go**

```go
package integration

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/yourusername/ecommerce/services/order/internal/domain"
	"github.com/yourusername/ecommerce/services/order/internal/saga"
)

func TestOrderSaga_CreateOrder(t *testing.T) {
	ctx := context.Background()

	// Start PostgreSQL container
	postgres, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "postgres:18-alpine",
			ExposedPorts: []string{"5432/tcp"},
			Env: map[string]string{
				"POSTGRES_DB":       "test_db",
				"POSTGRES_USER":     "postgres",
				"POSTGRES_PASSWORD": "postgres",
			},
			WaitingFor: wait.ForLog("database system is ready to accept connections"),
		},
		Started: true,
	})
	require.NoError(t, err)
	defer postgres.Terminate(ctx)

	// Start NATS container
	nats, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "nats:latest",
			ExposedPorts: []string{"4222/tcp"},
			Cmd:          []string{"-js"},
			WaitingFor:   wait.ForListeningPort("4222/tcp"),
		},
		Started: true,
	})
	require.NoError(t, err)
	defer nats.Terminate(ctx)

	// Setup services
	// ... (initialize repositories, clients, saga)

	// Test successful order creation
	t.Run("successful order creation", func(t *testing.T) {
		order := &domain.Order{
			ID:     uuid.New(),
			UserID: uuid.New(),
			Items: []domain.OrderItem{
				{
					ID:         uuid.New(),
					ProductID:  uuid.New(),
					Quantity:   2,
					UnitPrice:  decimal.NewFromFloat(29.99),
					TotalPrice: decimal.NewFromFloat(59.98),
					Currency:   "USD",
				},
			},
			Subtotal: decimal.NewFromFloat(59.98),
			Total:    decimal.NewFromFloat(59.98),
			Currency: "USD",
		}

		// Create order
		created, err := orderSaga.CreateOrder(ctx, order)
		require.NoError(t, err)
		assert.NotNil(t, created)
		assert.Equal(t, domain.OrderStatusPaymentPending, created.Status)
		assert.NotEqual(t, uuid.Nil, created.InventoryReservationID)
		assert.NotEmpty(t, created.PaymentIntentID)
	})

	// Test insufficient inventory
	t.Run("insufficient inventory", func(t *testing.T) {
		order := &domain.Order{
			ID:     uuid.New(),
			UserID: uuid.New(),
			Items: []domain.OrderItem{
				{
					ID:         uuid.New(),
					ProductID:  uuid.New(),
					Quantity:   1000, // More than available
					UnitPrice:  decimal.NewFromFloat(29.99),
					TotalPrice: decimal.NewFromFloat(29990),
					Currency:   "USD",
				},
			},
			Subtotal: decimal.NewFromFloat(29990),
			Total:    decimal.NewFromFloat(29990),
			Currency: "USD",
		}

		// Create order should fail
		_, err := orderSaga.CreateOrder(ctx, order)
		assert.Error(t, err)
	})
}

func TestOrderSaga_CancelOrder(t *testing.T) {
	// Similar setup...

	t.Run("successful order cancellation", func(t *testing.T) {
		// Create an order first
		order := createTestOrder(t)

		// Cancel order
		err := orderSaga.CancelOrder(ctx, order.ID, "customer request")
		require.NoError(t, err)

		// Verify order status
		canceled, err := orderRepo.GetByID(ctx, order.ID)
		require.NoError(t, err)
		assert.Equal(t, domain.OrderStatusCanceled, canceled.Status)
	})
}
```

### 10.2 Load Testing with K6

**tests/load/checkout_flow.js**

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 100 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'http://localhost:8080/api/v1';

export default function () {
  // 1. Browse products
  let productsRes = http.get(`${BASE_URL}/products`);
  check(productsRes, {
    'products listed': (r) => r.status === 200,
    'has products': (r) => JSON.parse(r.body).products.length > 0,
  });

  let products = JSON.parse(productsRes.body).products;
  let product = products[Math.floor(Math.random() * products.length)];

  sleep(1);

  // 2. Add to cart
  let cartRes = http.post(
    `${BASE_URL}/cart/items`,
    JSON.stringify({
      product_id: product.id,
      quantity: Math.floor(Math.random() * 3) + 1,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.USER_TOKEN}`,
      },
    }
  );
  check(cartRes, {
    'item added to cart': (r) => r.status === 200,
  });

  sleep(1);

  // 3. Get cart
  let getCartRes = http.get(`${BASE_URL}/cart`, {
    headers: {
      'Authorization': `Bearer ${__ENV.USER_TOKEN}`,
    },
  });
  check(getCartRes, {
    'cart retrieved': (r) => r.status === 200,
  });

  sleep(1);

  // 4. Create order
  let orderRes = http.post(
    `${BASE_URL}/orders`,
    JSON.stringify({
      shipping_address: {
        street_address: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94102',
        country: 'US',
      },
      billing_address: {
        street_address: '123 Main St',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94102',
        country: 'US',
      },
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${__ENV.USER_TOKEN}`,
      },
    }
  );
  check(orderRes, {
    'order created': (r) => r.status === 201,
    'has payment intent': (r) => JSON.parse(r.body).payment_intent_id !== '',
  });

  sleep(2);
}
```

Run with:
```bash
k6 run tests/load/checkout_flow.js
```

### 10.3 Kubernetes Deployment

**k8s/product-service-deployment.yaml**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: product-service
  labels:
    app: product-service
spec:
  replicas: 3
  selector:
    matchLabels:
      app: product-service
  template:
    metadata:
      labels:
        app: product-service
    spec:
      containers:
      - name: product-service
        image: your-registry/product-service:latest
        ports:
        - containerPort: 50051
        env:
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: product-db-secret
              key: host
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: product-db-secret
              key: password
        - name: NATS_URL
          value: "nats://nats:4222"
        - name: JAEGER_ENDPOINT
          value: "http://jaeger-collector:14268/api/traces"
        resources:
          requests:
            memory: "256Mi"
            cpu: "200m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          grpc:
            port: 50051
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          grpc:
            port: 50051
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: product-service
spec:
  selector:
    app: product-service
  ports:
  - port: 50051
    targetPort: 50051
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: product-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: product-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

---

### Junior → FAANG: Integration Testing for Distributed Systems

Testing a Saga (the order checkout flow that spans multiple services) requires a test environment where all services run simultaneously. The integration test in this chapter exercises the full Saga by calling the Order Service and verifying that the downstream effects (inventory reservation, payment processing, notification) occur correctly.

For entry-level roles, having written integration tests for a distributed system is a strong differentiator. Most candidates have only written unit tests. Being able to describe what you tested, how you set up the test environment, and what failure cases you covered shows practical distributed systems experience.

End-to-end tests that simulate a complete user journey (register, browse products, add to cart, checkout, receive confirmation) are the highest-value tests for a production readiness check. They are also the slowest. Run them in CI but not on every commit: gate them on pre-production deployments.

### Senior @ FAANG: Testing Strategy as a Release Gate

At senior level, the testing strategy is part of the release process. Each release must pass a defined set of gates before reaching production: unit tests (fast, run on every commit), integration tests (slower, run on every PR merge), end-to-end tests (slowest, run before production deploy), and smoke tests (run in production immediately after deploy to verify basic health).

Saga testing requires specific attention to failure scenarios. Test that when the Payment Service returns a failure, the inventory reservation is released and the order transitions to Canceled state. Test that when the Notification Service is unavailable, the order still completes and the notification is retried asynchronously. These failure path tests are what distinguish a tested distributed system from one that "works in the happy path."

Kubernetes deployment testing (verifying that the HPA triggers correctly at the configured CPU threshold, that rolling deploys complete without dropping requests, that PodDisruptionBudgets prevent simultaneous eviction of too many instances) requires a production-like environment with realistic load. These tests are expensive to run but essential before a new service goes to production for the first time.

---
