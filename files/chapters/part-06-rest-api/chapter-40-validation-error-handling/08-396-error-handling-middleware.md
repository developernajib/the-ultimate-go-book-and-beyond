## 40.6 Error Handling Middleware

### Error Handler Middleware

The `ErrorHandler` wraps handlers that return `error` values and translates those errors into structured HTTP responses. It checks for `RequestError` (parsing failures), `DomainError` (business logic failures), and context errors (cancellation, timeout) in order, falling through to a generic 500 for anything unexpected. In development mode it includes the raw error message, and in production it returns an opaque "unexpected error" to avoid leaking internals.

**Error wrapping and inspection.** Wrap with `fmt.Errorf("loading user %d: %w", id, err)` so callers can still `errors.Is(err, ErrNotFound)` or `errors.As(err, &pgErr)` through the chain. When a single operation can produce multiple independent failures (e.g. a batch of field validations, or a cleanup step that fails while another error is already in flight), `errors.Join(err1, err2, ...)` (Go 1.20+) returns a multi-error that both `errors.Is` and `errors.As` walk correctly, so no custom aggregate type is needed. Go 1.26 added `errors.AsType[E error](err error) (E, bool)`, which collapses the two-line declare-then-`errors.As` dance into `if reqErr, ok := errors.AsType[*RequestError](err); ok { ... }`. Log the full wrapped chain with `slog.Error("...", "err", err)` and return a sanitized message to the client. Never echo the raw wrapped error across the trust boundary.

```go
// ... imports omitted for brevity (context, errors, log/slog, net/http, runtime/debug)

// ErrorHandler wraps handlers with error handling
type ErrorHandler struct {
    logger *slog.Logger
    isDev  bool
}

func NewErrorHandler(logger *slog.Logger, isDev bool) *ErrorHandler {
    return &ErrorHandler{
        logger: logger,
        isDev:  isDev,
    }
}

// Handler type that returns an error
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Wrap converts error-returning handler to http.HandlerFunc
func (eh *ErrorHandler) Wrap(fn HandlerFunc) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        if err := fn(w, r); err != nil {
            eh.handleError(w, r, err)
        }
    }
}

func (eh *ErrorHandler) handleError(w http.ResponseWriter, r *http.Request, err error) {
    requestID := GetRequestID(r.Context())

    // Check for request errors (parsing, validation)
    var reqErr *RequestError
    if errors.As(err, &reqErr) {
        if reqErr.Field != "" {
            ValidationErrorResponse(w, r, []ErrorDetail{{
                Field:   reqErr.Field,
                Code:    reqErr.Code,
                Message: reqErr.Message,
            }})
        } else {
            ErrorResponse(w, r, reqErr.Status, reqErr.Code, reqErr.Message)
        }
        return
    }

    // Check for domain errors
    var domainErr *DomainError
    if errors.As(err, &domainErr) {
        MapErrorToResponse(w, r, domainErr)
        return
    }

    // Check for context cancellation
    if errors.Is(err, context.Canceled) {
        // Client disconnected, don't log as error
        eh.logger.Debug("request canceled", "request_id", requestID)
        return
    }

    if errors.Is(err, context.DeadlineExceeded) {
        eh.logger.Warn("request timeout", "request_id", requestID)
        ErrorResponse(w, r, http.StatusGatewayTimeout, "TIMEOUT", "Request timeout")
        return
    }

    // Unexpected error
    eh.logger.Error("unexpected error",
        "error", err,
        "request_id", requestID,
        "path", r.URL.Path,
        "method", r.Method,
    )

    if eh.isDev {
        // Include error details in development
        ErrorResponse(w, r, http.StatusInternalServerError, "INTERNAL_ERROR", err.Error())
    } else {
        InternalError(w, r)
    }
}

// Recovery middleware recovers from panics
func (eh *ErrorHandler) Recovery(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if err := recover(); err != nil {
                requestID := GetRequestID(r.Context())

                eh.logger.Error("panic recovered",
                    "error", err,
                    "request_id", requestID,
                    "stack", string(debug.Stack()),
                )

                InternalError(w, r)
            }
        }()

        next.ServeHTTP(w, r)
    })
}
```

### Handler with Error Return

With the `ErrorHandler.Wrap` adapter in place, handlers return `error` instead of writing error responses directly. Each handler follows the same pattern: decode the request body, run struct-tag validation, run business-rule validation, call the service layer. Parsing and validation errors are handled inline with early returns, and service-layer errors propagate up to the middleware for centralized mapping.

```go
// ... imports omitted for brevity (net/http, github.com/go-chi/chi/v5)

type UserHandler struct {
    service   UserService
    validator *BusinessValidator
    eh        *ErrorHandler
}

// Register routes with error handling
func (h *UserHandler) RegisterRoutes(r chi.Router) {
    r.Get("/", h.eh.Wrap(h.List))
    r.Post("/", h.eh.Wrap(h.Create))
    r.Get("/{id}", h.eh.Wrap(h.Get))
    r.Put("/{id}", h.eh.Wrap(h.Update))
    r.Delete("/{id}", h.eh.Wrap(h.Delete))
}

func (h *UserHandler) Create(w http.ResponseWriter, r *http.Request) error {
    var input CreateUserInput

    // Parse body
    if err := DecodeJSONBody(w, r, &input); err != nil {
        return err // RequestError handled by middleware
    }

    // Struct validation. Note the name: `verrs`, not `errors`, because
    // `errors` would shadow the standard library package for the rest of
    // the scope and quietly break any errors.Is/errors.As added later.
    if verrs := Validate(input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    // Business validation
    if verrs := h.validator.ValidateCreateUser(r.Context(), input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    // Create user
    user, err := h.service.Create(r.Context(), input)
    if err != nil {
        return err // Domain error handled by middleware
    }

    WriteJSON(w, http.StatusCreated, Response{Data: user})
    return nil
}

func (h *UserHandler) Get(w http.ResponseWriter, r *http.Request) error {
    pv := NewPathValidator(r)
    userID := pv.UUID("id")

    if pv.HasErrors() {
        ValidationErrorResponse(w, r, pv.Errors())
        return nil
    }

    user, err := h.service.GetByID(r.Context(), userID)
    if err != nil {
        return err
    }

    WriteJSON(w, http.StatusOK, Response{Data: user})
    return nil
}

func (h *UserHandler) Update(w http.ResponseWriter, r *http.Request) error {
    pv := NewPathValidator(r)
    userID := pv.UUID("id")

    if pv.HasErrors() {
        ValidationErrorResponse(w, r, pv.Errors())
        return nil
    }

    var input UpdateUserInput
    if err := DecodeJSONBody(w, r, &input); err != nil {
        return err
    }

    if verrs := Validate(input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    if verrs := h.validator.ValidateUpdateUser(r.Context(), userID, input); len(verrs) > 0 {
        ValidationErrorResponse(w, r, toErrorDetails(verrs))
        return nil
    }

    user, err := h.service.Update(r.Context(), userID, input)
    if err != nil {
        return err
    }

    WriteJSON(w, http.StatusOK, Response{Data: user})
    return nil
}
```

### Junior → FAANG: Prerequisites and Worked Example

The mental model you need first is that Go does not have exceptions. Errors are values that flow back up the call stack one return at a time, and a handler that does not explicitly propagate an error will silently swallow it. The `HandlerFunc` signature `func(w, r) error` above is how you add an implicit propagation channel on top of the standard `http.HandlerFunc`, and the `Wrap` adapter is what bridges the two worlds. You need to understand `defer` and `recover` well enough to explain why the `Recovery` middleware registers its `defer` before calling `next.ServeHTTP`. If the order were reversed, a panic in the handler would crash the goroutine, and the HTTP server would close the connection abruptly instead of returning a 500 response. You also need to know that `recover()` only works inside a deferred function and only catches panics in the same goroutine, which is why a goroutine launched inside a handler must install its own recovery or it will take down the whole process.

Sentinel errors versus typed errors is the second foundational distinction. A sentinel is a package-level variable like `var ErrNotFound = errors.New("not found")` compared with `errors.Is`. A typed error is a struct that carries fields, compared with `errors.As`. You use sentinels for "one of a fixed set of outcomes" (not found, unauthorized, conflict) and typed errors for "same outcome but with context" (validation failed on these fields, database rejected this constraint). The code above uses both: `context.Canceled` as a sentinel, `*RequestError` and `*DomainError` as typed errors. Getting this split right in your first design review is a visible senior signal even at L3.

Worked example. You get paged because the error rate dashboard shows a spike in 500s on `GET /users/{id}`. You pull a trace and see the handler logged `unexpected error` with message `pq: canceling statement due to user request`. Translation: the client disconnected mid-query, the context was canceled, the database driver returned a cancel error, and the handler classified it as a 500 because the error did not match any of the `errors.Is` branches. Fix: add `errors.Is(err, context.Canceled)` matching on wrapped driver errors, and prefer to check `r.Context().Err()` before logging at Error level. The broader lesson is that any error handler that treats client-caused conditions as Error-severity will page you during every traffic spike and desensitize you to real 500s.

Interview entry-points. What is the difference between panic and error? Panic unwinds the stack running deferred functions, crosses goroutine boundaries only via re-panic, and is reserved for genuinely unrecoverable conditions. Errors are normal return values. A web handler should never panic as a normal control flow mechanism. Why does the middleware call `debug.Stack()` at recovery time rather than letting the runtime print it? Because `debug.Stack()` returns the stack as a `[]byte` so you can attach it to a structured log field, ship it to your log aggregator, scrub it if needed, and gate it by environment. Why gate error message bodies by `isDev`? Because raw error messages routinely leak schema names, table column names, file paths, and internal service URLs, all of which accelerate an attacker's reconnaissance phase.

### Senior @ FAANG: Error Contracts, Observability, and Incident Economics

At staff level, error handling is where reliability engineering and security engineering meet product engineering. The first discipline is the error catalog as a versioned artifact. Every error code your service can emit is registered in a central repository with the HTTP status, the client-visible message template, the retryability class (retryable, retryable-after-delay, never-retry), and the severity class (user error, infrastructure, security event). The registry is the source of truth that generates the error enum in every client SDK, the developer portal documentation, and the alert routing table. Without this, each service invents its own codes, client teams write bespoke parsing per service, and you spend years unwinding drift. The catalog also enforces that security-sensitive outcomes (authentication failure, authorization failure, rate limit) share a common shape so SIEM rules work uniformly.

The second discipline is PII scrubbing as a default in the error path. A validator that emits `Value: "user@example.com is already taken"` just leaked an email into an error log that feeds a broader-access datastore than your PII store. The scrubber runs as a final transform before serialization and before log emission, taking the typed error, walking its fields via reflection or a generated visitor, and redacting anything tagged `pii:"email"` or `pii:"phone"`. The implementation choice is whether to scrub on the write path (cheaper, permanent, risk of over-redaction) or on the read path (allows audit use cases but every reader must honor the tag). The industry trend in 2026 is write-path scrubbing for error logs specifically, because error logs flow to the widest population of engineers and the regret cost of a leak is asymmetric.

The third discipline is error sampling tied to cardinality. A path like `/healthz` failing at 10k rps will flood your log pipeline within minutes. The solution is a tiered sampler keyed on the tuple `(route_template, error_code)`. The first occurrence per tuple per minute is always logged at full fidelity. Subsequent occurrences are sampled with a reservoir that guarantees you keep a representative example every minute plus a count. The count feeds a metric, not the log. This pattern survives contact with incidents because during an outage you still get the first occurrence with full context, plus an accurate rate, without blowing the budget. Implement this as a middleware that wraps `slog.Handler` rather than as a per-call rate check, so the sampling policy is uniform across services.

The fourth discipline is stack trace governance. Stack traces are diagnostic gold and security risk in the same string. They reveal package layout, third-party dependency versions, and sometimes cryptographic material from stack-allocated buffers. The rule: stack traces go to the internal observability store only, never to the client, never to any log that has a path to customer-facing tools like a support console. The `Recovery` middleware above already does this, but the review is whether every ad hoc `log.Printf("err: %+v", err)` in the codebase honors it. The tooling answer is a custom `golangci-lint` analyzer that forbids `%+v` on errors outside of an allowlist of `*_internal.go` files. The organizational answer is a quarterly sweep that greps for the anti-pattern and opens a tracking ticket per occurrence.

The fifth discipline is error-budget accounting wired into the handler. Every `handleError` invocation emits a metric `http_server_errors_total` with labels `route`, `method`, `status_class`, and `error_code`. The SLO system computes the burn rate over rolling windows (1h, 6h, 24h, 72h) and fires a multi-window multi-burn-rate alert when the budget consumption rate would exhaust the monthly budget before the window closes. Standard Google SRE Workbook pattern, implemented once at the middleware, inherited by every service. Without this tie-in, error handling is local and reactive. With it, a rise in validation 400s contributes nothing to the error budget (they are client errors) while a rise in 500s draws down budget proportional to impact, which aligns engineering priorities with customer experience instead of with gut feel.

The sixth discipline is automated incident creation on 5xx spikes. The pipeline is: metrics detect anomaly, alert fires, on-call receives page, runbook is linked, incident channel is auto-created with the last N sampled error logs pre-posted. Getting this right requires that the error middleware attaches a stable `incident_correlation_id` (often the trace ID plus a coarse time bucket) so the auto-posted logs actually cluster on the same root cause rather than fragmenting across unrelated 5xxs that happened to coincide. The subtle failure mode is when a client retry storm inflates a single root-cause 500 into a 50x volume spike, training your incident responders to mute the alert. Mitigation is to count unique trace IDs, not request IDs, in the spike detector.

The seventh discipline is typed errors across service boundaries. When service A calls service B via gRPC, errors cross a serialization boundary and `errors.Is` breaks unless you have a shared error module that knows how to reconstitute typed errors from the gRPC status details. The industry-standard approach is to use `google.rpc.Status` with the `ErrorInfo` detail populated with your error code from the catalog, and provide a client-side unwrapper that rebuilds the typed error. This preserves the `errors.As` ergonomic across the wire and means retry logic, circuit breakers, and observability attributes all work identically whether the error originated in-process or three services away. The same principle applies to HTTP with Problem Details for HTTP APIs (RFC 9457), where the `type` URI plus extension fields carry the catalog code.

---
