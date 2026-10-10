## 40.2 Custom Validators

### Business Rule Validation

`BusinessValidator` depends on repository interfaces rather than concrete types, so the uniqueness checks against the database can be mocked in unit tests without a live connection. All validation errors are collected into a slice before returning, so the client receives every field violation in a single response rather than fixing one error at a time.

```go
// ... imports omitted for brevity (context, errors)

// BusinessValidator validates business rules
type BusinessValidator struct {
    userRepo UserRepository
    orgRepo  OrganizationRepository
}

func NewBusinessValidator(userRepo UserRepository, orgRepo OrganizationRepository) *BusinessValidator {
    return &BusinessValidator{
        userRepo: userRepo,
        orgRepo:  orgRepo,
    }
}

// ValidateCreateUser checks business rules for user creation
func (v *BusinessValidator) ValidateCreateUser(ctx context.Context, input CreateUserInput) []FieldError {
    var errors []FieldError

    // Check email uniqueness
    exists, err := v.userRepo.ExistsByEmail(ctx, input.Email)
    if err != nil {
        errors = append(errors, FieldError{
            Field:   "email",
            Code:    "VALIDATION_ERROR",
            Message: "unable to validate email",
        })
    } else if exists {
        errors = append(errors, FieldError{
            Field:   "email",
            Code:    "ALREADY_EXISTS",
            Message: "email is already registered",
        })
    }

    // Check username uniqueness
    exists, err = v.userRepo.ExistsByUsername(ctx, input.Username)
    if err != nil {
        errors = append(errors, FieldError{
            Field:   "username",
            Code:    "VALIDATION_ERROR",
            Message: "unable to validate username",
        })
    } else if exists {
        errors = append(errors, FieldError{
            Field:   "username",
            Code:    "ALREADY_EXISTS",
            Message: "username is already taken",
        })
    }

    // Check password against breached passwords (hypothetical)
    if isBreachedPassword(input.Password) {
        errors = append(errors, FieldError{
            Field:   "password",
            Code:    "BREACHED_PASSWORD",
            Message: "this password has been exposed in a data breach",
        })
    }

    return errors
}

// ValidateUpdateUser checks business rules for user updates
func (v *BusinessValidator) ValidateUpdateUser(ctx context.Context, userID string, input UpdateUserInput) []FieldError {
    var errors []FieldError

    // Check email uniqueness (excluding current user)
    if input.Email != nil {
        exists, err := v.userRepo.ExistsByEmailExcluding(ctx, *input.Email, userID)
        if err != nil {
            errors = append(errors, FieldError{
                Field:   "email",
                Code:    "VALIDATION_ERROR",
                Message: "unable to validate email",
            })
        } else if exists {
            errors = append(errors, FieldError{
                Field:   "email",
                Code:    "ALREADY_EXISTS",
                Message: "email is already registered",
            })
        }
    }

    return errors
}
```

### Conditional Validation

The `required_if` tag makes card-specific fields mandatory only when `method=card`, avoiding false validation errors for bank-transfer or crypto payment flows. A struct-level validation function runs after field-level checks to assert the per-method invariants that individual field tags cannot express: a Luhn checksum on the card number, a nine-digit routing number for bank transfers, and a network-specific wallet address format for crypto.

```go
// ... imports omitted for brevity (time, github.com/go-playground/validator/v10)

// RegisterConditionalValidations sets up conditional validation rules
func RegisterConditionalValidations(v *validator.Validate) {
    // Register struct-level validation
    v.RegisterStructValidation(validatePaymentMethod, PaymentInput{})
    v.RegisterStructValidation(validateStringDateRange, StringDateRangeInput{})
}

// PaymentInput with conditional fields
type PaymentInput struct {
    Method       string `json:"method" validate:"required,oneof=card bank_transfer crypto"`

    // Card fields (required when method=card)
    CardNumber   string `json:"card_number" validate:"required_if=Method card"`
    ExpiryMonth  int    `json:"expiry_month" validate:"required_if=Method card,omitempty,min=1,max=12"`
    // No min=<year> tag here: a hardcoded year rots the moment it passes.
    // Expiry-in-the-past is a clock-dependent rule, so it belongs in the
    // struct-level function below where it can read time.Now().
    ExpiryYear   int    `json:"expiry_year" validate:"required_if=Method card,omitempty,min=1970"`
    CVV          string `json:"cvv" validate:"required_if=Method card,omitempty,len=3|len=4"`

    // Bank transfer fields
    AccountNumber string `json:"account_number" validate:"required_if=Method bank_transfer"`
    RoutingNumber string `json:"routing_number" validate:"required_if=Method bank_transfer"`

    // Crypto fields
    WalletAddress string `json:"wallet_address" validate:"required_if=Method crypto"`
    Network       string `json:"network" validate:"required_if=Method crypto,omitempty,oneof=ethereum bitcoin"`
}

func validatePaymentMethod(sl validator.StructLevel) {
    input := sl.Current().Interface().(PaymentInput)

    switch input.Method {
    case "card":
        // Additional card validation
        if !luhnCheck(input.CardNumber) {
            sl.ReportError(input.CardNumber, "CardNumber", "card_number", "luhn", "")
        }
        // Expiry is relative to now, which is why it cannot be a tag.
        now := time.Now().UTC()
        expiry := time.Date(input.ExpiryYear, time.Month(input.ExpiryMonth), 1, 0, 0, 0, 0, time.UTC).
            AddDate(0, 1, 0) // cards are valid through the end of the expiry month
        if !expiry.After(now) {
            sl.ReportError(input.ExpiryYear, "ExpiryYear", "expiry_year", "expired", "")
        }
    case "bank_transfer":
        // Validate routing number format
        if len(input.RoutingNumber) != 9 {
            sl.ReportError(input.RoutingNumber, "RoutingNumber", "routing_number", "routing_format", "")
        }
    case "crypto":
        // Validate wallet address format based on network
        if input.Network == "ethereum" && !isValidEthereumAddress(input.WalletAddress) {
            sl.ReportError(input.WalletAddress, "WalletAddress", "wallet_address", "eth_address", "")
        }
    }
}

// Cross-field validation.
//
// Note the field type. gtfield on two *string* fields compares their
// LENGTHS, not their chronology, so `EndDate string` with
// `gtfield=StartDate` fails even for a perfectly valid range because
// both "2026-01-01" and "2026-12-31" are ten bytes long. Decode into
// time.Time and gtfield does a real chronological comparison.
type DateRangeInput struct {
    StartDate time.Time `json:"start_date" validate:"required"`
    EndDate   time.Time `json:"end_date" validate:"required,gtfield=StartDate"`
}

// If the wire format must stay a string, do the comparison at struct level
// instead of reaching for gtfield.
type StringDateRangeInput struct {
    StartDate string `json:"start_date" validate:"required,datetime=2006-01-02"`
    EndDate   string `json:"end_date" validate:"required,datetime=2006-01-02"`
}

func validateStringDateRange(sl validator.StructLevel) {
    input := sl.Current().Interface().(StringDateRangeInput)

    start, err1 := time.Parse("2006-01-02", input.StartDate)
    end, err2 := time.Parse("2006-01-02", input.EndDate)
    if err1 != nil || err2 != nil {
        return // the datetime tag already reported these
    }

    if !end.After(start) {
        sl.ReportError(input.EndDate, "EndDate", "end_date", "gtfield", "StartDate")
    }
}

// Password confirmation
type PasswordChangeInput struct {
    CurrentPassword string `json:"current_password" validate:"required"`
    NewPassword     string `json:"new_password" validate:"required,min=8,nefield=CurrentPassword"`
    ConfirmPassword string `json:"confirm_password" validate:"required,eqfield=NewPassword"`
}
```

### Junior → FAANG: how to think about custom validators in your first year

The mental model that takes juniors from "I can copy a tag" to "I understand validation" is the distinction between pure and impure validators. A pure validator is a function of its inputs only, has no side effects, and always returns the same result for the same input. `validateSlug` is pure. An impure validator touches the database, calls a service, reads the clock, or generates random data. `ValidateCreateUser` above is impure because it calls `userRepo.ExistsByEmail`. Pure validators go in struct tags or struct-level functions. Impure validators go in a service with an explicit `context.Context` parameter so they can be canceled, traced, and tested with fakes. Putting a database call behind a struct tag is the architectural equivalent of hiding a network call in a getter, and it is the number one validation antipattern in Go codebases.

The worked example a hiring manager might give: "the signup endpoint is slow because we do three sequential database round-trips for uniqueness checks." The junior answer is "add an index." The mid answer is "batch the checks with a single `SELECT ... WHERE email = ? OR username = ?`." The senior answer is "uniqueness is a race condition anyway, move it to a unique constraint at the database level, catch the constraint violation error in the repository, and map it to `ALREADY_EXISTS` in the service layer." The senior answer eliminates the validator call entirely, which is the right architectural outcome. Pre-flight uniqueness checks exist to produce friendly error messages, not to enforce correctness. Enforcement is the database's job.

The `BusinessValidator` pattern above is also where context-aware validation belongs. If the rule depends on who is calling (tenant admin can set fields a regular user cannot, premium users get higher limits), the validator signature must accept the caller identity, usually via `context.Context`. Never read the identity from a global or package-level variable.

### Senior @ FAANG: cross-field rules, CQRS command validation, and the protovalidate pivot

Cross-field validation is where tag-based systems start to crack. The `validatePaymentMethod` struct-level function above is the escape hatch `go-playground/validator` offers, and it works for a handful of fields. Once you have more than three cross-field rules, the function becomes a pile of `switch` statements that nobody wants to modify. At that point you have three options. First, move to a builder-style validator (ozzo) where rules are values you can compose, name, and unit-test. Second, split the one polymorphic DTO (`PaymentInput` with card, bank, and crypto fields all at top level) into a tagged union (`PaymentInput { Method string; Details json.RawMessage }`) with a dispatch that decodes `Details` into the appropriate sub-DTO. The tagged union is strictly more correct because it makes illegal combinations unrepresentable at the type level, but it requires a two-step decode that many teams find awkward. Third, generate validators from a contract. Protovalidate expresses the rule as CEL: `field.method == "card" ? has(field.card_number) && luhn(field.card_number) : true`. The expression is type-checked at compile time of the proto, runs on both client and server, and documents the rule in the schema. For any service with more than trivial conditional validation, the protovalidate path is the staff-level default.

In CQRS architectures, the boundary between command validation and domain invariant enforcement is the single most debated topic in the Go DDD community. The rule that holds up: a command is valid if it is well-formed and the caller is authorized to issue it. A command is executable if the aggregate's current state permits the transition. Validation runs in a decorator around the command handler, using the DTOs shown here. Executability runs on the aggregate inside the handler, returning domain errors like `ErrInsufficientFunds` or `ErrAccountFrozen` that the handler then maps to HTTP codes. Conflating the two (putting balance checks in the validator because "it is still validation") couples your edge layer to your database and makes the aggregate's invariants untrustworthy in any context other than this one command. Keep them separate.

Parse-don't-validate applies with full force here. The `CreateUserInput` DTO should not be a `string` email. It should contain `Email email.Address` where `email.Address` is a type with a private field and a constructor that returns an error. Once the DTO parses, no further email validation is possible anywhere in the call stack because there is no path from raw string to `email.Address` that skips the constructor. This is the "refined types" pattern and it eliminates entire categories of validation bugs that tag-based systems leak. Go does not have first-class refined types the way Haskell or Scala do, but you can approximate them with unexported fields and package-level constructors. That is the whole point of Alexis King's essay: make illegal states unrepresentable, and validation becomes a one-time event at the edge rather than a recurring concern throughout the call graph.

Context-aware validation has one more subtlety worth calling out. Rules that depend on feature flags ("new password policy is enabled for tenant X") must resolve the flag once per request, not per field. If your validator calls `flags.Enabled(ctx, "strict_passwords")` inside a field-level function, you will incur a flag lookup on every validation and possibly get inconsistent results within a single request if the flag value changes mid-evaluation. Resolve flags at request entry, snapshot them into a value carried on the context, and have validators read from the snapshot. This is the same pattern used for currency conversion rates, time-of-day checks, and any other external signal that must be stable within a request.

Finally, i18n for validation messages. Never store human-readable strings in your validators. Store stable codes (`TOO_SHORT`, `INVALID_EMAIL`) and parameters (`{"min": 8, "actual": 3}`). Resolve to a locale at the HTTP response serialization step using `golang.org/x/text/message` and a message catalog loaded at startup. This keeps validators locale-free, lets QA assert on codes instead of on fragile English substrings, and lets localization teams update translations without touching Go code. The failure mode you are avoiding is the one where a French customer sets `Accept-Language: fr` and still gets "must be at least 8 characters," because the English string was baked into the validator at the point of failure and no amount of translation config downstream can recover the code and parameters that produced it.

---
