## Snapshot and Approval Testing

Some correctness properties are easy to state and hard to assert. "The query planner chooses a good plan." "The generated HTML is structurally correct." "The debug dump reflects the expected internal state." Writing explicit assertions for every field is tedious and fragile. Snapshot testing captures the current output once, commits it to the repository, and fails future test runs whenever the output changes. The reviewer then decides whether the change is intentional (update the snapshot) or a regression (fix the code).

### The Core Pattern

```cpp
#include <gtest/gtest.h>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace approval {

class Snapshot {
    std::filesystem::path path_;
    std::string actual_;

public:
    Snapshot(std::filesystem::path p, std::string actual)
        : path_(std::move(p)), actual_(std::move(actual)) {}

    void verify() {
        if (std::getenv("APPROVE") != nullptr) {
            std::ofstream(path_) << actual_;
            return;  // write mode: record the current output as the accepted snapshot
        }
        if (!std::filesystem::exists(path_)) {
            std::ofstream(path_) << actual_;
            FAIL() << "No snapshot existed; wrote " << path_
                   << ". Re-run to verify.";
        }
        std::ostringstream expected_stream;
        expected_stream << std::ifstream(path_).rdbuf();
        const std::string expected = expected_stream.str();
        if (expected != actual_) {
            // Write the actual for diffing.
            std::ofstream(path_.string() + ".actual") << actual_;
            FAIL() << "Snapshot mismatch for " << path_
                   << ". Diff: diff " << path_ << " " << path_ << ".actual\n"
                   << "If the change is intentional, rerun with APPROVE=1.";
        }
    }
};

}  // namespace approval

TEST(QueryPlanner, JoinOfThreeTablesProducesExpectedPlan) {
    auto plan = build_plan("SELECT a.*, b.x, c.y FROM a JOIN b ON ... JOIN c ON ...");
    approval::Snapshot snap{"testdata/plan_three_joins.txt", dump_plan(plan)};
    snap.verify();
}
```

### When Snapshot Testing Shines

1. **Output-heavy components**: code generators, pretty printers, query plans, AST dumps, log output formats. Writing dozens of field-by-field assertions is exhausting and obscures the intent.
2. **Regression detection on legacy code**: you do not know which fields matter, only that "whatever this did last week, keep doing it."
3. **Cross-version behavior tracking**: commit the snapshot alongside the source, and every intentional change is visible in diff review.

### When Snapshot Testing Fails

1. **Non-deterministic output**: timestamps, memory addresses, iteration order of hash maps. Strip these before snapshotting, or the test will flake.
2. **Platform-dependent output**: floating-point formatting, path separators, locale-specific collation. Canonicalize, or have per-platform snapshots.
3. **Giant outputs that no one reviews**: a 100 KB snapshot that gets updated without reading is worse than no test. Keep snapshots small enough that a reviewer can actually diff them.

### Canonicalization Before Snapshotting

```cpp
#include <regex>
#include <string>

std::string canonicalize(std::string in) {
    // Strip timestamps like 2026-04-15T10:23:45Z
    in = std::regex_replace(in,
        std::regex(R"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"),
        "<timestamp>");
    // Strip hex addresses like 0x7f8b1a2c4e00
    in = std::regex_replace(in,
        std::regex(R"(0x[0-9a-fA-F]{6,})"),
        "<addr>");
    // Collapse trailing whitespace on each line
    in = std::regex_replace(in, std::regex(R"( +\n)"), "\n");
    return in;
}
```

Apply canonicalization before passing to `Snapshot`. Write the canonicalization itself as pure string transformation so the test author can see and extend it.

### Integration with Review Tooling

A snapshot test that fails in CI should print a diff, not just a length mismatch. Modern approval-testing libraries (Verify.cpp, ApprovalTests.Cpp) integrate with your diff viewer:
- On local test failure, they open the diff in VS Code, vimdiff, or a configured tool.
- On CI failure, they emit the actual output as a build artifact so reviewers can download and diff locally.
- They write a `.received` file next to the `.approved` file, so Git history carries both and the delta is obvious.

```cpp
// Using ApprovalTests.Cpp (header-only)
#include "ApprovalTests.hpp"

TEST(Reporter, HtmlReport) {
    std::string html = generate_report(input_fixture());
    ApprovalTests::Approvals::verify(html,
        ApprovalTests::Options().withScrubber(&canonicalize));
}
```

### Approval Workflow in Practice

1. First run: `testdata/my_test.approved.txt` does not exist. The library writes `testdata/my_test.received.txt` and fails the test.
2. Reviewer inspects the `.received` output. If correct, rename to `.approved` and commit.
3. Next run: the content is identical. Test passes.
4. A month later, a code change alters the output. Test fails with a diff pointing to changed lines.
5. Reviewer decides: intentional change (update `.approved` in the same PR as the source change), or a bug (fix the source).

This workflow enforces a useful discipline: every behavioral change shows up in both the source diff and the approved-output diff, within the same pull request. A reviewer who cannot understand the approved-output change has just found a reason to ask for more context or tests. Snapshots become a conversation about intent, not just a binary pass/fail.
