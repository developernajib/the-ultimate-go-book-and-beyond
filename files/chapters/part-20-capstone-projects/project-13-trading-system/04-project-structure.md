## Project Structure

Organizing a trading system into well-separated packages is critical for maintainability and testability. The layout below follows Go's standard project structure conventions: the `cmd/` directory holds entry points for different executables, `internal/` contains business logic that should not be imported by external projects, and `pkg/` provides reusable libraries like lock-free data structures and memory pools. This separation ensures that each component can be developed, tested, and deployed independently.

```
trading-system/
├── cmd/
│   ├── trader/              # Main trading application
│   ├── backtester/          # Backtesting engine
│   └── simulator/           # Market simulator
├── internal/
│   ├── orderbook/           # Order book implementation
│   ├── matching/            # Order matching engine
│   ├── orders/              # Order types and management
│   ├── risk/                # Risk management
│   ├── strategy/            # Trading strategies
│   ├── market/              # Market data handling
│   ├── exchange/            # Exchange connectors
│   ├── position/            # Position tracking
│   ├── persistence/         # Database operations
│   └── metrics/             # Monitoring and metrics
├── pkg/
│   ├── lockfree/            # Lock-free data structures
│   ├── pool/                # Memory pools
│   └── types/               # Core types
├── configs/
│   ├── config.yaml          # Main configuration
│   └── strategies/          # Strategy configs
├── migrations/              # Database migrations
└── testdata/               # Test market data
```
