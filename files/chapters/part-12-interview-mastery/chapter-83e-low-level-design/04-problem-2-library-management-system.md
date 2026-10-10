## 83E.4 Problem 2: Library Management System

### Requirements

1. Track books, members, and librarians
2. Members can search, borrow, and return books
3. Maximum 5 books per member at a time
4. Late return fees
5. Book reservations when all copies are borrowed

### Implementation

The library management system exercises composite entity modeling, books, members, loans, reservations, and requires careful state machine design for the borrow/return/reserve lifecycle. The following implementation models each domain concept as an interface, enabling independent testing and future extension.

```go
package library

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// --- Enums ---

type BookStatus int

const (
	Available BookStatus = iota
	Borrowed
	Reserved
)

type MemberStatus int

const (
	Active MemberStatus = iota
	Suspended
)

// --- Interfaces ---

type BookSearcher interface {
	SearchByTitle(title string) []*Book
	SearchByAuthor(author string) []*Book
	SearchByISBN(isbn string) *Book
}

type LendingService interface {
	Borrow(memberID, bookID string) (*Loan, error)
	Return(loanID string) (int64, error) // returns late fee in cents
	Reserve(memberID, bookID string) (*Reservation, error)
}

// --- Entities ---

type Book struct {
	ID     string
	Title  string
	Author string
	ISBN   string
	Status BookStatus
}

type Member struct {
	ID           string
	Name         string
	Email        string
	Status       MemberStatus
	ActiveLoans  int
	MaxLoans     int
}

type Loan struct {
	ID         string
	BookID     string
	MemberID   string
	BorrowDate time.Time
	DueDate    time.Time
	ReturnDate *time.Time
}

type Reservation struct {
	ID       string
	BookID   string
	MemberID string
	Created  time.Time
}

// --- Library ---

type Library struct {
	mu           sync.Mutex
	books        map[string]*Book
	members      map[string]*Member
	loans        map[string]*Loan
	reservations map[string][]*Reservation // bookID -> queue
	nextID       int
	loanPeriod   time.Duration
	lateFeePerDay int64 // cents
}

type LibraryConfig struct {
	LoanPeriodDays int
	LateFeePerDay  int64
	MaxLoansPerMember int
}

func NewLibrary(cfg LibraryConfig) *Library {
	return &Library{
		books:         make(map[string]*Book),
		members:       make(map[string]*Member),
		loans:         make(map[string]*Loan),
		reservations:  make(map[string][]*Reservation),
		loanPeriod:    time.Duration(cfg.LoanPeriodDays) * 24 * time.Hour,
		lateFeePerDay: cfg.LateFeePerDay,
	}
}

func (lib *Library) genID(prefix string) string {
	lib.nextID++
	return fmt.Sprintf("%s-%d", prefix, lib.nextID)
}

func (lib *Library) AddBook(title, author, isbn string) *Book {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	book := &Book{
		ID:     lib.genID("B"),
		Title:  title,
		Author: author,
		ISBN:   isbn,
		Status: Available,
	}
	lib.books[book.ID] = book
	return book
}

func (lib *Library) RegisterMember(name, email string) *Member {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	member := &Member{
		ID:       lib.genID("M"),
		Name:     name,
		Email:    email,
		Status:   Active,
		MaxLoans: 5,
	}
	lib.members[member.ID] = member
	return member
}

func (lib *Library) SearchByTitle(title string) []*Book {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	var results []*Book
	for _, book := range lib.books {
		if book.Title == title {
			results = append(results, book)
		}
	}
	return results
}

func (lib *Library) SearchByAuthor(author string) []*Book {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	var results []*Book
	for _, book := range lib.books {
		if book.Author == author {
			results = append(results, book)
		}
	}
	return results
}

func (lib *Library) SearchByISBN(isbn string) *Book {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	for _, book := range lib.books {
		if book.ISBN == isbn {
			return book
		}
	}
	return nil
}

func (lib *Library) Borrow(memberID, bookID string) (*Loan, error) {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	member, ok := lib.members[memberID]
	if !ok {
		return nil, errors.New("member not found")
	}
	if member.Status != Active {
		return nil, errors.New("member account is suspended")
	}
	if member.ActiveLoans >= member.MaxLoans {
		return nil, fmt.Errorf("member has reached max loans (%d)", member.MaxLoans)
	}

	book, ok := lib.books[bookID]
	if !ok {
		return nil, errors.New("book not found")
	}
	if book.Status != Available {
		return nil, errors.New("book is not available")
	}

	// Check if someone else has a reservation
	if reservations, exists := lib.reservations[bookID]; exists && len(reservations) > 0 {
		if reservations[0].MemberID != memberID {
			return nil, errors.New("book is reserved by another member")
		}
		// This member has the reservation - remove it
		lib.reservations[bookID] = reservations[1:]
	}

	now := time.Now()
	loan := &Loan{
		ID:         lib.genID("L"),
		BookID:     bookID,
		MemberID:   memberID,
		BorrowDate: now,
		DueDate:    now.Add(lib.loanPeriod),
	}

	book.Status = Borrowed
	member.ActiveLoans++
	lib.loans[loan.ID] = loan

	return loan, nil
}

func (lib *Library) Return(loanID string) (int64, error) {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	loan, ok := lib.loans[loanID]
	if !ok {
		return 0, errors.New("loan not found")
	}
	if loan.ReturnDate != nil {
		return 0, errors.New("book already returned")
	}

	now := time.Now()
	loan.ReturnDate = &now

	book := lib.books[loan.BookID]
	member := lib.members[loan.MemberID]
	member.ActiveLoans--

	// Check reservations
	if reservations, exists := lib.reservations[book.ID]; exists && len(reservations) > 0 {
		book.Status = Reserved
	} else {
		book.Status = Available
	}

	// Calculate late fee
	var fee int64
	if now.After(loan.DueDate) {
		overdueDays := int64(now.Sub(loan.DueDate).Hours() / 24)
		if overdueDays < 1 {
			overdueDays = 1
		}
		fee = overdueDays * lib.lateFeePerDay
	}

	return fee, nil
}

func (lib *Library) Reserve(memberID, bookID string) (*Reservation, error) {
	lib.mu.Lock()
	defer lib.mu.Unlock()

	if _, ok := lib.members[memberID]; !ok {
		return nil, errors.New("member not found")
	}
	book, ok := lib.books[bookID]
	if !ok {
		return nil, errors.New("book not found")
	}
	if book.Status == Available {
		return nil, errors.New("book is available - borrow it directly")
	}

	reservation := &Reservation{
		ID:       lib.genID("R"),
		BookID:   bookID,
		MemberID: memberID,
		Created:  time.Now(),
	}
	lib.reservations[bookID] = append(lib.reservations[bookID], reservation)

	return reservation, nil
}
```

### SOLID Analysis

- **S:** Search, lending, and reservation logic are separated.
- **O:** New book categories or fee structures can be added via new types.
- **L:** The `BookSearcher` and `LendingService` interfaces define interchangeable contracts.
- **I:** Search and lending are separate interfaces - a search-only service need not implement lending.
- **D:** Consumers depend on interfaces, not the concrete `Library` struct.


### Junior → FAANG: Library Management System LLD Basics

The library management system problem covers inventory management, member management, and borrowing workflows. Entities: Library, Book, BookItem (a physical copy), Member, LibraryCard, BookLending. Key behaviors: search catalog, check out a book item, return a book item, reserve a book, compute and collect fines for late returns. Model BookItem separately from Book because multiple copies of the same book can exist, each with independent availability status.

### Senior @ FAANG: Library Management System at the Senior Bar: State Machine and Notification

At the senior level, the library system LLD should model the book item lifecycle as an explicit state machine: Available, Reserved, CheckedOut, Lost. State transitions are triggered by actions (checkout, return, declare lost), and illegal transitions (checking out an already-checked-out book) should be rejected with clear errors. In Go, this is represented as a typed constant for state and a transition table or switch statement that validates state changes. The notification concern is also senior-level: how do you notify a member when their reserved book becomes available? This requires an Observer pattern or an event-driven notification service, which the senior candidate should design as a separate concern from the inventory management logic.

---
