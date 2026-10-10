## 83E.6 Problem 4: Snake Game

### Requirements

1. Grid of width x height
2. Snake starts at (0,0) moving right
3. Food appears at given positions
4. Snake grows when eating food
5. Game ends if snake hits wall or itself

### Implementation

The snake game implementation tests linked list or deque manipulation under real-time update constraints, a pattern that also appears in queue-based system design problems. The following Go implementation demonstrates efficient head insertion and tail removal using a doubly linked list with O(1) operations per move.

```go
package snake

type Direction int

const (
	Right Direction = iota
	Down
	Left
	Up
)

type Point struct {
	Row, Col int
}

type SnakeGame struct {
	width     int
	height    int
	food      []Point
	foodIndex int
	snake     []Point       // head is last element
	occupied  map[Point]bool
	score     int
	gameOver  bool
}

func NewSnakeGame(width, height int, food [][]int) *SnakeGame {
	foodPoints := make([]Point, len(food))
	for i, f := range food {
		foodPoints[i] = Point{f[0], f[1]}
	}

	start := Point{0, 0}
	return &SnakeGame{
		width:    width,
		height:   height,
		food:     foodPoints,
		snake:    []Point{start},
		occupied: map[Point]bool{start: true},
	}
}

// Move moves the snake in the given direction and returns the score.
// Returns -1 if game over.
func (sg *SnakeGame) Move(direction string) int {
	if sg.gameOver {
		return -1
	}

	head := sg.snake[len(sg.snake)-1]
	var newHead Point

	switch direction {
	case "R":
		newHead = Point{head.Row, head.Col + 1}
	case "D":
		newHead = Point{head.Row + 1, head.Col}
	case "L":
		newHead = Point{head.Row, head.Col - 1}
	case "U":
		newHead = Point{head.Row - 1, head.Col}
	default:
		sg.gameOver = true
		return -1
	}

	// Check wall collision
	if newHead.Row < 0 || newHead.Row >= sg.height ||
		newHead.Col < 0 || newHead.Col >= sg.width {
		sg.gameOver = true
		return -1
	}

	// Check if eating food
	eating := sg.foodIndex < len(sg.food) && sg.food[sg.foodIndex] == newHead

	if !eating {
		// Remove tail
		tail := sg.snake[0]
		sg.snake = sg.snake[1:]
		delete(sg.occupied, tail)
	} else {
		sg.foodIndex++
		sg.score++
	}

	// Check self collision (after removing tail, before adding head)
	if sg.occupied[newHead] {
		sg.gameOver = true
		return -1
	}

	// Add new head
	sg.snake = append(sg.snake, newHead)
	sg.occupied[newHead] = true

	return sg.score
}

func (sg *SnakeGame) IsGameOver() bool {
	return sg.gameOver
}

func (sg *SnakeGame) Score() int {
	return sg.score
}
```

This matches **LeetCode 353: Design Snake Game** exactly.

**Complexity:** O(1) per move. O(n) space for the snake body.


### Junior → FAANG: Snake Game LLD Basics

The Snake game LLD problem (LeetCode 353) tests your ability to model a game state with efficient data structures. The snake's body is a deque (double-ended queue): the head is added to the front on each move, and the tail is removed from the back unless the snake has eaten food (in which case the tail stays). A set of occupied positions enables O(1) collision detection. In Go, use a ring buffer or a slice-based deque for the body, and a map[Point]bool for occupied positions. The move operation computes the new head position, checks for boundary collision and self-collision, and updates the body.

### Senior @ FAANG: Snake Game at the Senior Bar: State Isolation and Testability

At the senior level, the Snake game LLD is evaluated on testability and state isolation. The game state (snake body, food positions, score) should be fully encapsulated and deterministic: given the same sequence of moves and food positions, the game should always produce the same result. This makes the game logic trivially unit-testable without any mocking. The display layer (how the grid is rendered) should be behind an interface, enabling the game logic to be tested without a UI. Senior candidates should also address the food generation strategy: deterministic food generation (for testing) versus random food generation (for production) requires a Strategy pattern that can be injected at construction time. This is the Dependency Inversion Principle applied directly to a concrete LLD problem.

---
