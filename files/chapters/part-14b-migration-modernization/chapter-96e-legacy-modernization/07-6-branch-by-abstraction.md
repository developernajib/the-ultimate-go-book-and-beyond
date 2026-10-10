## 6. Branch-by-Abstraction

Branch-by-abstraction uses a runtime switch (backed by feature flags) to select between the legacy and new implementation of a repository. The key idea is that your service layer code never changes during the migration. Instead, you inject a special "branching" repository that wraps both the legacy and new implementations behind the same interface. On every call, the branching repository checks the feature flag to decide which concrete implementation to delegate to. This means you can swap implementations for individual users, tenants, or a percentage of traffic without modifying any business logic code. It is the classic Strategy pattern combined with feature flags for runtime selection.

```go
// file: internal/repository/branching.go
package repository

import (
	"context"
	"log/slog"

	"github.com/example/gobook/internal/domain"
	"github.com/example/gobook/internal/featureflags"
)

// BranchingUserRepository delegates to either legacy or new based on feature flags.
// It implements domain.UserRepository, so the service layer needs no changes.
type BranchingUserRepository struct {
	legacy domain.UserRepository
	new    domain.UserRepository
	flags  *featureflags.Engine
	flag   featureflags.FlagName
	logger *slog.Logger
}

// NewBranchingUserRepository constructs the branching repository.
func NewBranchingUserRepository(
	legacy, new domain.UserRepository,
	flags *featureflags.Engine,
	flag featureflags.FlagName,
	logger *slog.Logger,
) *BranchingUserRepository {
	return &BranchingUserRepository{
		legacy: legacy,
		new:    new,
		flags:  flags,
		flag:   flag,
		logger: logger,
	}
}

// pick selects which repository to use based on the current flag state.
func (b *BranchingUserRepository) pick(ctx context.Context) domain.UserRepository {
	if b.flags.IsEnabled(ctx, b.flag) {
		return b.new
	}
	return b.legacy
}

func (b *BranchingUserRepository) GetByID(ctx context.Context, id domain.UserID) (*domain.User, error) {
	return b.pick(ctx).GetByID(ctx, id)
}

func (b *BranchingUserRepository) GetByEmail(ctx context.Context, email string) (*domain.User, error) {
	return b.pick(ctx).GetByEmail(ctx, email)
}

func (b *BranchingUserRepository) Create(ctx context.Context, u *domain.User) error {
	return b.pick(ctx).Create(ctx, u)
}

func (b *BranchingUserRepository) Update(ctx context.Context, u *domain.User) error {
	return b.pick(ctx).Update(ctx, u)
}

func (b *BranchingUserRepository) Delete(ctx context.Context, id domain.UserID) error {
	return b.pick(ctx).Delete(ctx, id)
}

func (b *BranchingUserRepository) List(ctx context.Context, opts domain.ListOptions) ([]*domain.User, error) {
	return b.pick(ctx).List(ctx, opts)
}

// Ensure BranchingUserRepository implements domain.UserRepository at compile time.
var _ domain.UserRepository = (*BranchingUserRepository)(nil)
```

### Junior → FAANG: Branch-by-Abstraction as the Strategy Pattern in Production

Branch-by-abstraction is a classic Strategy pattern applied at the repository layer with a feature flag as the runtime strategy selector. Understanding this connection helps you recognize the pattern in other contexts: any time you need to switch between two implementations of the same interface at runtime based on some configuration, you are implementing branch-by-abstraction.

The compile-time interface verification (`var _ domain.UserRepository = (*BranchingUserRepository)(nil)`) is an important Go idiom that deserves specific attention. This blank identifier assignment verifies at compile time that the struct implements the interface, without allocating any memory at runtime. It is the standard Go pattern for ensuring that an implementation satisfies an interface contract, and it prevents the runtime panic that would occur if the interface check was only performed when the method was first called.

For early-career engineers: notice that the service layer code does not know it is talking to a `BranchingUserRepository`. It only knows it is talking to a `domain.UserRepository`. This is the point of the pattern: business logic is not modified during the migration. The branching is entirely encapsulated in the repository layer.

### Senior @ FAANG: Branch-by-Abstraction at Scale and the Interface Evolution Problem

At senior level, branch-by-abstraction introduces an interface evolution problem that requires explicit governance. During the migration, both the legacy and new implementations must satisfy the current interface. Any change to the interface requires updating both implementations simultaneously, which creates coordination overhead that can slow the migration.

The governance practice: freeze the interface definition once branch-by-abstraction is deployed to production. Any new capability that the new implementation provides should be added as a separate interface (using Go's interface composition) rather than modifying the existing interface. This constraint feels limiting but it prevents the most common migration failure mode: interface churn that requires the legacy and new teams to coordinate every change, creating dependency that defeats the purpose of the abstraction layer.

The metric instrumentation in the branching repository is a senior-level concern that the implementation in this section correctly addresses. Every delegation to either implementation should emit metrics that distinguish between legacy and new execution, including latency and error rate per implementation. These metrics are the signal for determining when the new implementation has sufficient confidence to become the primary.

---
