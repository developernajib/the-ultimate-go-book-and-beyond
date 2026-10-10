## Question 18: Identify Issues in Code

**Level**: Senior

**Question**: Review this code and list all issues:

```go
func ProcessUsers(users []User) error {
    var wg sync.WaitGroup
    errors := []error{}

    for _, user := range users {
        wg.Add(1)
        go func() {
            defer wg.Done()
            if err := process(user); err != nil {
                errors = append(errors, err)
            }
        }()
    }

    wg.Wait()

    if len(errors) > 0 {
        return errors[0]
    }
    return nil
}
```

**Answer - Issues**:

1. **Data race on `user` variable** (loop variable capture)
2. **Data race on `errors` slice** (concurrent append)
3. **Error handling loses information** (only returns first error)
4. **No goroutine limit** (could spawn millions of goroutines)
5. **Missing error aggregation**

**Fixed Version**:

```go
func ProcessUsers(users []User) error {
    var wg sync.WaitGroup
    errCh := make(chan error, len(users))
    sem := make(chan struct{}, 10)  // Limit to 10 concurrent

    for _, user := range users {
        wg.Add(1)
        sem <- struct{}{}  // Acquire semaphore

        go func(u User) {  // Pass user as parameter
            defer wg.Done()
            defer func() { <-sem }()  // Release semaphore

            if err := process(u); err != nil {
                errCh <- err
            }
        }(user)
    }

    wg.Wait()
    close(errCh)

    // Collect all errors
    var errs []error
    for err := range errCh {
        errs = append(errs, err)
    }

    if len(errs) > 0 {
        return fmt.Errorf("processing failed with %d errors: %v", len(errs), errs[0])
    }
    return nil
}
```

**Companies that asked this**: Google, Meta, Amazon, Uber

---
