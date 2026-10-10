## OOD Problems in C++

Object-oriented design problems test whether you can translate verbal requirements into a coherent class hierarchy. At FAANG, these are typically 35-45 minute problems where you are expected to design classes, discuss trade-offs, and produce working code. Each solution here includes the key design decisions and a complete implementation.

---

### Problem 1: Parking Lot

**Requirements**: Design a multi-level parking lot. Supports motorcycles, cars, and trucks. Each level has spots of three sizes: small, medium, large. A vehicle can only park in a spot of its size or larger. Track available spots per level. Entry/exit gates issue and redeem tickets.

**Key design decisions:**
- Separate `Vehicle` hierarchy from `ParkingSpot` hierarchy, they are independent
- Spot availability tracked with `std::atomic<int>` for thread safety
- Ticket stores level+spot to enable O(1) retrieval on exit

```
ParkingLot
  └── Level[]
        └── ParkingSpot[]
              └── Vehicle* (nullptr if empty)
Vehicle (abstract)
  ├── Motorcycle
  ├── Car
  └── Truck
Ticket
  └── level, spot index, entry time
```

```cpp
#include <vector>
#include <string>
#include <atomic>
#include <chrono>
#include <optional>
#include <memory>
#include <mutex>
#include <cassert>

enum class VehicleSize { Small, Medium, Large };
enum class SpotSize    { Small, Medium, Large };

struct Vehicle {
    std::string  plate;
    VehicleSize  size;
    virtual ~Vehicle() = default;
};

struct Motorcycle : Vehicle { Motorcycle(std::string p) { plate=std::move(p); size=VehicleSize::Small;  } };
struct Car        : Vehicle { Car(std::string p)        { plate=std::move(p); size=VehicleSize::Medium; } };
struct Truck      : Vehicle { Truck(std::string p)      { plate=std::move(p); size=VehicleSize::Large;  } };

bool fits(VehicleSize vs, SpotSize ss) {
    return static_cast<int>(vs) <= static_cast<int>(ss);
}

struct Ticket {
    std::string plate;
    int         level;
    int         spot_index;
    std::chrono::steady_clock::time_point entry;
};

class ParkingSpot {
    SpotSize           size_;
    const Vehicle*     occupant_ = nullptr;
    mutable std::mutex mu_;
public:
    explicit ParkingSpot(SpotSize s) : size_(s) {}

    bool try_park(const Vehicle& v) {
        std::lock_guard lock{mu_};
        if (occupant_ || !fits(v.size, size_)) return false;
        occupant_ = &v;
        return true;
    }

    bool vacate(const std::string& plate) {
        std::lock_guard lock{mu_};
        if (!occupant_ || occupant_->plate != plate) return false;
        occupant_ = nullptr;
        return true;
    }

    bool is_free() const {
        std::lock_guard lock{mu_};
        return occupant_ == nullptr;
    }

    SpotSize size() const { return size_; }
};

class Level {
    int                    id_;
    std::vector<ParkingSpot> spots_;
    std::atomic<int>       free_count_;
public:
    Level(int id, int small_n, int medium_n, int large_n) : id_(id), free_count_(0) {
        for (int i = 0; i < small_n;  ++i) spots_.emplace_back(SpotSize::Small);
        for (int i = 0; i < medium_n; ++i) spots_.emplace_back(SpotSize::Medium);
        for (int i = 0; i < large_n;  ++i) spots_.emplace_back(SpotSize::Large);
        free_count_ = static_cast<int>(spots_.size());
    }

    std::optional<int> park(const Vehicle& v) {
        for (int i = 0; i < static_cast<int>(spots_.size()); ++i) {
            if (spots_[i].try_park(v)) {
                free_count_.fetch_sub(1, std::memory_order_relaxed);
                return i;
            }
        }
        return std::nullopt;
    }

    bool vacate(int spot_index, const std::string& plate) {
        if (spot_index < 0 || spot_index >= static_cast<int>(spots_.size())) return false;
        if (spots_[spot_index].vacate(plate)) {
            free_count_.fetch_add(1, std::memory_order_relaxed);
            return true;
        }
        return false;
    }

    int  id()         const { return id_; }
    int  free_spots() const { return free_count_.load(std::memory_order_relaxed); }
};

class ParkingLot {
    std::vector<Level> levels_;
public:
    ParkingLot() {
        // 3 levels, each with 20 small + 30 medium + 10 large spots
        for (int i = 0; i < 3; ++i)
            levels_.emplace_back(i, 20, 30, 10);
    }

    std::optional<Ticket> enter(const Vehicle& v) {
        for (auto& level : levels_) {
            if (auto idx = level.park(v)) {
                return Ticket{v.plate, level.id(), *idx,
                              std::chrono::steady_clock::now()};
            }
        }
        return std::nullopt;  // full
    }

    bool exit(const Ticket& ticket) {
        return levels_[ticket.level].vacate(ticket.spot_index, ticket.plate);
    }

    void status() const {
        for (const auto& lvl : levels_)
            printf("Level %d: %d free spots\n", lvl.id(), lvl.free_spots());
    }
};
```

---

### Problem 2: LRU Cache

**Requirements**: Design a cache with O(1) `get` and `put` operations. When the cache is full and a new item is inserted, evict the Least Recently Used item. Thread-safe version required.

**Key design decisions:**
- Doubly linked list for O(1) move-to-front
- Hash map from key to list iterator for O(1) lookup
- `shared_mutex` so multiple readers can proceed concurrently

```cpp
#include <list>
#include <unordered_map>
#include <shared_mutex>
#include <optional>
#include <stdexcept>

template<typename K, typename V>
class LRUCache {
    using Pair     = std::pair<K, V>;
    using List     = std::list<Pair>;
    using ListIter = typename List::iterator;

    const size_t                        capacity_;
    List                                items_;     // front = most recent
    std::unordered_map<K, ListIter>     index_;
    mutable std::shared_mutex           mu_;

public:
    explicit LRUCache(size_t cap) : capacity_(cap) {
        if (cap == 0) throw std::invalid_argument("capacity must be > 0");
    }

    std::optional<V> get(const K& key) {
        std::unique_lock lock{mu_};  // unique: we move to front on hit
        auto it = index_.find(key);
        if (it == index_.end()) return std::nullopt;
        items_.splice(items_.begin(), items_, it->second);  // move to front O(1)
        return it->second->second;
    }

    void put(const K& key, V value) {
        std::unique_lock lock{mu_};
        auto it = index_.find(key);
        if (it != index_.end()) {
            it->second->second = std::move(value);       // update value
            items_.splice(items_.begin(), items_, it->second); // move to front
            return;
        }
        if (items_.size() >= capacity_) {
            // Evict LRU (back of list)
            index_.erase(items_.back().first);
            items_.pop_back();
        }
        items_.emplace_front(key, std::move(value));
        index_[key] = items_.begin();
    }

    size_t size()     const { std::shared_lock lock{mu_}; return items_.size(); }
    bool   contains(const K& k) const {
        std::shared_lock lock{mu_};
        return index_.count(k) > 0;
    }
};
```

**Complexity**: `get`, O(1) average. `put`, O(1) average. `splice` on `std::list` is O(1). `unordered_map` operations are O(1) average, O(n) worst case.

---

### Problem 3: Elevator System

**Requirements**: Model a building with N elevators and M floors. Users request elevators at floors (directional: up/down). The controller assigns requests to the optimal elevator using the SCAN algorithm (service requests in one direction before reversing).

**Key design decisions:**
- `Elevator` holds current floor, direction, and a sorted set of destination floors
- `ElevatorController` receives requests and dispatches to the nearest idle/same-direction elevator
- SCAN: elevator travels in one direction, picks up requests along the way, reverses at the end

```cpp
#include <set>
#include <vector>
#include <mutex>
#include <limits>
#include <algorithm>

enum class Direction { Up, Down, Idle };

class Elevator {
    int                id_;
    int                current_floor_;
    Direction          dir_;
    std::set<int>      up_stops_;    // pending stops above current
    std::set<int>      down_stops_;  // pending stops below current
    mutable std::mutex mu_;

public:
    Elevator(int id, int start_floor)
        : id_(id), current_floor_(start_floor), dir_(Direction::Idle) {}

    void add_stop(int floor) {
        std::lock_guard lock{mu_};
        if (floor >= current_floor_) up_stops_.insert(floor);
        else                         down_stops_.insert(floor);
        if (dir_ == Direction::Idle)
            dir_ = (floor >= current_floor_) ? Direction::Up : Direction::Down;
    }

    // Returns distance cost (for controller assignment heuristic)
    int cost(int floor, Direction req_dir) const {
        std::lock_guard lock{mu_};
        int dist = std::abs(current_floor_ - floor);
        // Same direction same side = cheap
        if (dir_ == req_dir || dir_ == Direction::Idle) return dist;
        // Opposite direction = expensive: must service all stops first
        return dist + 10;
    }

    void step() {
        std::lock_guard lock{mu_};
        if (dir_ == Direction::Up) {
            if (!up_stops_.empty()) {
                current_floor_ = *up_stops_.begin();
                up_stops_.erase(up_stops_.begin());
                printf("Elevator %d arrived at floor %d (UP)\n", id_, current_floor_);
            }
            if (up_stops_.empty()) {
                dir_ = down_stops_.empty() ? Direction::Idle : Direction::Down;
            }
        } else if (dir_ == Direction::Down) {
            if (!down_stops_.empty()) {
                current_floor_ = *down_stops_.rbegin();
                down_stops_.erase(std::prev(down_stops_.end()));
                printf("Elevator %d arrived at floor %d (DOWN)\n", id_, current_floor_);
            }
            if (down_stops_.empty()) {
                dir_ = up_stops_.empty() ? Direction::Idle : Direction::Up;
            }
        }
    }

    int       floor()     const { std::lock_guard l{mu_}; return current_floor_; }
    Direction direction() const { std::lock_guard l{mu_}; return dir_; }
    int       id()        const { return id_; }
};

class ElevatorController {
    std::vector<Elevator> elevators_;
public:
    ElevatorController(int num_elevators, int num_floors) {
        for (int i = 0; i < num_elevators; ++i)
            elevators_.emplace_back(i, 0);
        (void)num_floors;
    }

    // Request from a floor button: assign to lowest-cost elevator
    void request(int floor, Direction dir) {
        int best_id   = 0;
        int best_cost = std::numeric_limits<int>::max();
        for (auto& e : elevators_) {
            int c = e.cost(floor, dir);
            if (c < best_cost) { best_cost = c; best_id = e.id(); }
        }
        elevators_[best_id].add_stop(floor);
    }

    // Request from inside an elevator: add destination floor
    void select_floor(int elevator_id, int floor) {
        elevators_[elevator_id].add_stop(floor);
    }

    // Tick: move all elevators one step
    void tick() {
        for (auto& e : elevators_) e.step();
    }
};
```

---

### Problem 4: Chess Game

**Requirements**: Model a chess game. Support all piece types with their legal moves. Detect check. Support castling and en passant flags. Represent the board.

**Key design decisions:**
- Abstract `Piece` with virtual `is_valid_move(from, to, board)`
- `Board` is an 8x8 grid of `unique_ptr<Piece>` (null = empty)
- Check detection: after any move, see if the moving side's king is attacked

```cpp
#include <array>
#include <memory>
#include <optional>
#include <vector>
#include <cmath>

enum class Color { White, Black };
enum class PieceType { King, Queen, Rook, Bishop, Knight, Pawn };

struct Pos { int row, col; };
inline bool in_bounds(Pos p) { return p.row>=0&&p.row<8&&p.col>=0&&p.col<8; }

class Board;  // forward declaration

class Piece {
protected:
    Color     color_;
    PieceType type_;
public:
    Piece(Color c, PieceType t) : color_(c), type_(t) {}
    virtual ~Piece() = default;
    virtual bool is_valid_move(Pos from, Pos to, const Board& board) const = 0;
    virtual std::unique_ptr<Piece> clone() const = 0;
    Color     color() const { return color_; }
    PieceType type()  const { return type_;  }
};

class Board {
    std::array<std::array<std::unique_ptr<Piece>, 8>, 8> grid_;
public:
    const Piece* at(Pos p) const {
        return in_bounds(p) ? grid_[p.row][p.col].get() : nullptr;
    }
    void place(Pos p, std::unique_ptr<Piece> piece) {
        grid_[p.row][p.col] = std::move(piece);
    }
    void remove(Pos p) { grid_[p.row][p.col] = nullptr; }

    // Returns true if path from (fr,fc) to (tr,tc) is clear (exclusive endpoints)
    bool path_clear(Pos from, Pos to) const {
        int dr = (to.row > from.row) ? 1 : (to.row < from.row) ? -1 : 0;
        int dc = (to.col > from.col) ? 1 : (to.col < from.col) ? -1 : 0;
        Pos cur = {from.row + dr, from.col + dc};
        while (cur.row != to.row || cur.col != to.col) {
            if (at(cur)) return false;
            cur = {cur.row + dr, cur.col + dc};
        }
        return true;
    }
};

class Rook : public Piece {
public:
    Rook(Color c) : Piece(c, PieceType::Rook) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<Rook>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        if (from.row != to.row && from.col != to.col) return false;  // not straight
        if (!board.path_clear(from, to)) return false;
        const Piece* target = board.at(to);
        return !target || target->color() != color_;  // empty or enemy
    }
};

class Bishop : public Piece {
public:
    Bishop(Color c) : Piece(c, PieceType::Bishop) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<Bishop>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        if (std::abs(to.row - from.row) != std::abs(to.col - from.col)) return false;
        if (!board.path_clear(from, to)) return false;
        const Piece* target = board.at(to);
        return !target || target->color() != color_;
    }
};

class Knight : public Piece {
public:
    Knight(Color c) : Piece(c, PieceType::Knight) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<Knight>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        int dr = std::abs(to.row - from.row);
        int dc = std::abs(to.col - from.col);
        if (!((dr == 2 && dc == 1) || (dr == 1 && dc == 2))) return false;
        const Piece* target = board.at(to);
        return !target || target->color() != color_;
    }
};

class Queen : public Piece {
public:
    Queen(Color c) : Piece(c, PieceType::Queen) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<Queen>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        int dr = std::abs(to.row - from.row);
        int dc = std::abs(to.col - from.col);
        bool straight  = (from.row == to.row || from.col == to.col);
        bool diagonal  = (dr == dc);
        if (!straight && !diagonal) return false;
        if (!board.path_clear(from, to)) return false;
        const Piece* target = board.at(to);
        return !target || target->color() != color_;
    }
};

class Pawn : public Piece {
public:
    Pawn(Color c) : Piece(c, PieceType::Pawn) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<Pawn>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        int dir     = (color_ == Color::White) ? 1 : -1;
        int start_r = (color_ == Color::White) ? 1 : 6;
        int dr = to.row - from.row;
        int dc = to.col - from.col;
        // Forward one step:
        if (dc == 0 && dr == dir && !board.at(to)) return true;
        // Forward two steps from start:
        if (dc == 0 && dr == 2*dir && from.row == start_r
            && !board.at({from.row + dir, from.col}) && !board.at(to)) return true;
        // Diagonal capture:
        if (std::abs(dc) == 1 && dr == dir) {
            const Piece* target = board.at(to);
            return target && target->color() != color_;
            // (en passant omitted for brevity, would check a separate state flag)
        }
        return false;
    }
};

class King : public Piece {
public:
    King(Color c) : Piece(c, PieceType::King) {}
    std::unique_ptr<Piece> clone() const override { return std::make_unique<King>(color_); }

    bool is_valid_move(Pos from, Pos to, const Board& board) const override {
        int dr = std::abs(to.row - from.row);
        int dc = std::abs(to.col - from.col);
        if (dr > 1 || dc > 1) return false;
        const Piece* target = board.at(to);
        return !target || target->color() != color_;
    }
};
```

---

### Problem 5: File System

**Requirements**: Model an in-memory file system with files and directories. Support `ls` (list), `find` (find by name), and `du` (disk usage). Use the Composite pattern.

**Key design decisions:**
- `FileSystemNode` is the abstract component
- `File` is a leaf, has a size, no children
- `Directory` is a composite, holds children, delegates size to them
- Composite pattern: both types respond to the same interface

```cpp
#include <string>
#include <vector>
#include <memory>
#include <algorithm>
#include <numeric>
#include <iostream>
#include <optional>

class FileSystemNode {
protected:
    std::string name_;
public:
    explicit FileSystemNode(std::string name) : name_(std::move(name)) {}
    virtual ~FileSystemNode() = default;

    const std::string& name() const { return name_; }
    virtual size_t     size() const = 0;          // disk usage in bytes
    virtual bool       is_dir() const = 0;
    virtual void       ls(int indent = 0) const = 0;
    virtual FileSystemNode* find(const std::string& target) = 0;
};

class File : public FileSystemNode {
    size_t bytes_;
public:
    File(std::string name, size_t bytes)
        : FileSystemNode(std::move(name)), bytes_(bytes) {}

    size_t size()   const override { return bytes_; }
    bool   is_dir() const override { return false; }

    void ls(int indent) const override {
        std::cout << std::string(indent*2, ' ') << name_ << " (" << bytes_ << "B)\n";
    }

    FileSystemNode* find(const std::string& target) override {
        return (name_ == target) ? this : nullptr;
    }
};

class Directory : public FileSystemNode {
    std::vector<std::unique_ptr<FileSystemNode>> children_;
public:
    explicit Directory(std::string name) : FileSystemNode(std::move(name)) {}

    void add(std::unique_ptr<FileSystemNode> child) {
        children_.push_back(std::move(child));
    }

    size_t size() const override {
        return std::accumulate(children_.begin(), children_.end(), size_t{0},
            [](size_t acc, const auto& child) { return acc + child->size(); });
    }

    bool is_dir() const override { return true; }

    void ls(int indent) const override {
        std::cout << std::string(indent*2, ' ') << "[" << name_ << "]/\n";
        for (const auto& child : children_)
            child->ls(indent + 1);
    }

    FileSystemNode* find(const std::string& target) override {
        if (name_ == target) return this;
        for (auto& child : children_) {
            if (auto* found = child->find(target)) return found;
        }
        return nullptr;
    }

    void du() const {
        std::cout << "du: " << name_ << " = " << size() << " bytes total\n";
    }
};

// Usage:
// auto root = std::make_unique<Directory>("root");
// auto etc  = std::make_unique<Directory>("etc");
// etc->add(std::make_unique<File>("hosts", 512)) - // etc->add(std::make_unique<File>("passwd", 2048)) - // root->add(std::move(etc)) - // root->add(std::make_unique<File>("readme.txt", 256)) - // root->ls() - // recursive listing
// root->du() - // total = 2816 bytes
// auto* n = root->find("hosts") - // found
```

---
