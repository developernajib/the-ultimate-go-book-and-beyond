#!/usr/bin/env python3
"""Validate ASCII box diagrams in files/chapters.

Catches the two defect classes that break diagram rendering:
  1. Ragged edges: lines of one bordered box have different display widths
     (border narrower than content, so the right edge sticks out).
     These fail the check.
  2. Floating wires: a vertical wire permanently changes lanes with no
     connector. Listed as warnings for human review, because only a human
     can tell which lane is correct (majority rule picks wrong sometimes).
  3. Minor wobbles: one-cell mid-wire jitters. Nearly invisible when
     rendered. Listed with --verbose for opportunistic fixes.

Also flags tabs (unmeasurable widths) and emoji (platform-dependent width)
inside bordered diagrams.

Only reports; never modifies files. Exit code is 1 when a failure is found
(ragged edges, tabs, emoji). Wire jogs print as review warnings instead:
fixing them needs human judgment about which lane is correct, and majority
rule picks wrong sometimes:
    python3 files/check-diagrams.py [--verbose] [--quiet]

Companion npm script: `npm run check-diagrams`.
"""

import os
import sys
import unicodedata

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chapters")
BOXCHARS = set("│┌┐└┘├┤┬┴┼─╭╮╰╯")
BORDER = set("┌┐└┘├┤┬┴┼─╭╮╰╯")
WIRE = "│"
# Chars whose rendered width varies by platform even with a pinned code font:
# emoji-presentation symbols, variation selectors, joiners.
EMOJI_RANGES = (
    (0x2705, 0x2705),  # WHITE HEAVY CHECK MARK
    (0x274C, 0x274C),  # CROSS MARK
    (0xFE0F, 0xFE0F),  # VARIATION SELECTOR-16
    (0x200D, 0x200D),  # ZERO WIDTH JOINER
    (0x1F300, 0x1FAFF),  # pictographs, symbols, emoticons
)


def display_width(s):
    """Monospace cell width: East Asian wide/full = 2, combining = 0."""
    return sum(
        2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1
        for c in s
    )


def indent_of(line):
    return len(line) - len(line.lstrip(" "))


def lead(line):
    s = line.lstrip(" ")
    return s[0] if s else ""


def is_plain_content(line):
    s = line.strip(" ")
    return len(s) >= 2 and s[0] == "│" and s[-1] == "│"


def is_pure_border(line):
    s = line.strip(" ")
    return len(s) >= 2 and s[0] in "┌└├╭╰" and set(s) <= BORDER


def is_emoji(ch):
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in EMOJI_RANGES)


def split_boxes(run):
    """Split a run of box lines at stacked same-indent close/open boundaries."""
    boxes, cur = [], []
    for item in run:
        lineno, line = item
        if cur and line.lstrip(" ")[:1] in ("┌", "╭"):
            _, prev = cur[-1]
            if prev.lstrip(" ")[:1] in ("└", "┘", "╰", "╯") and indent_of(prev) == indent_of(line):
                boxes.append(cur)
                cur = []
        cur.append(item)
    if cur:
        boxes.append(cur)
    return boxes


JUNCTIONS = set("┌┐└┘├┤┬┴┼◀▶◄►▼▲→←↑↓═║╔╗╚╝╭╮╰╯")


def check_jogs(path, box):
    """Split jogs into severe (junction-adjacent, visibly broken corners)
    and mild (mid-wire one-cell wobbles, nearly invisible). Returns a pair
    of failure lists. Only reports; never modifies files."""
    """Flag vertical wires that permanently change lanes.

    A wire counts as established only after two consecutive rows carry │ in
    the same column. If the next two rows carry it 1-3 columns away, with
    nothing but spaces in between and no return to the old column, the
    corner hangs disconnected (a structural lane change). One-row wobbles
    that return immediately are hand-drawing jitter and are left alone.
    Legit turns always leave a horizontal connector (dashes, corners,
    arrows). Nested boxes never build the required runs, so they pass.
    """
    failures = []
    lines = [line for _, line in box]
    nums = [lineno for lineno, _ in box]
    width = max(len(line) for line in lines)
    pairs = set()

    def at(row, col):
        if 0 <= row < len(lines) and 0 <= col < len(lines[row]):
            return lines[row][col]
        return " "

    def bridge_clear(r1, r2, c1, c2):
        lo, hi = sorted((c1, c2))
        cells = "".join(at(r1, k) for k in range(lo + 1, hi)) + "".join(
            at(r2, k) for k in range(lo + 1, hi)
        )
        return all(b == " " for b in cells)

    for r in range(1, len(lines) - 2):
        for c in range(width):
            if not (at(r - 1, c) == WIRE and at(r, c) == WIRE and at(r + 1, c) == " "):
                continue
            for delta in (-3, -2, -1, 1, 2, 3):
                c2 = c + delta
                if at(r + 1, c2) != WIRE or at(r, c2) != " ":
                    continue
                if not (r + 2 < len(lines) and at(r + 2, c2) == WIRE):
                    continue
                if at(r + 1, c) != " " or at(r + 2, c) != " ":
                    continue
                if bridge_clear(r, r + 1, c, c2):
                    pairs.add((nums[r], nums[r + 1], c, c2))
    # Mirror pass: established run below, lane change above.
    for r in range(len(lines) - 2, 0, -1):
        for c in range(width):
            if not (at(r + 1, c) == WIRE and at(r, c) == WIRE and at(r - 1, c) == " "):
                continue
            for delta in (-3, -2, -1, 1, 2, 3):
                c2 = c + delta
                if at(r - 1, c2) != WIRE or at(r, c2) != " ":
                    continue
                if not (r - 2 >= 0 and at(r - 2, c2) == WIRE):
                    continue
                if at(r - 1, c) != " " or at(r - 2, c) != " ":
                    continue
                if bridge_clear(r, r - 1, c, c2):
                    pairs.add((nums[r - 1], nums[r], c2, c))
    def near_junction(row_a, row_b, col_a, col_b):
        idx = {n: k for k, n in enumerate(nums)}
        rows = range(idx[row_a] - 1, idx[row_b] + 2)
        for r in rows:
            if 0 <= r < len(lines):
                seg = lines[r][max(0, min(col_a, col_b) - 3) : max(col_a, col_b) + 4]
                if any(c in JUNCTIONS for c in seg):
                    return True
        return False

    severe, mild = [], []
    for row_a, row_b, col_a, col_b in sorted(pairs):
        message = (
            "%s:%d: wire jumps from col %d (row %d) to col %d (row %d) with no connector"
            % (path, row_b, col_a, row_a, col_b, row_b)
        )
        if near_junction(row_a, row_b, col_a, col_b):
            severe.append(message)
        else:
            mild.append(message)
    return severe, mild


def check_file(path):
    failures = []
    jog_warnings = []
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    in_fence = False
    run = []

    def flush():
        if not run:
            return
        # Trailing spaces are invisible when rendered; ignore them so they
        # neither inflate widths nor shift columns.
        run[:] = [(lineno, text.rstrip(" ")) for lineno, text in run]
        for box in split_boxes(run):
            texts = [line for _, line in box]
            if not (
                any(lead(t) in ("┌", "╭") for t in texts)
                and any(lead(t) in ("└", "┘", "╰", "╯") for t in texts)
            ):
                continue
            first = box[0][0]
            if any("\t" in t for t in texts):
                failures.append("%s:%d: tabs inside diagram (widths unmeasurable)" % (path, first))
                continue
            for lineno, text in box:
                for ch in text:
                    if is_emoji(ch):
                        failures.append(
                            "%s:%d: emoji U+%04X inside diagram (width varies by platform)"
                            % (path, lineno, ord(ch))
                        )
                        break
            if len({indent_of(t) for t in texts}) != 1:
                continue
            if not all(is_plain_content(t) or is_pure_border(t) for t in texts):
                continue
            widths = {display_width(t) for t in texts}
            if len(widths) > 1:
                failures.append(
                    "%s:%d: ragged edges, line widths %s (border narrower than content?)"
                    % (path, first, sorted(widths))
                )
                continue
            severe, mild = check_jogs(path, box)
            jog_warnings.extend(severe)
            jog_warnings.extend(mild)

    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            in_fence = not in_fence
            flush()
            run = []
            continue
        if in_fence and any(c in line for c in BOXCHARS):
            run.append((i + 1, line))
        else:
            flush()
            run = []
    flush()
    return failures, jog_warnings


def main():
    quiet = "--quiet" in sys.argv[1:]
    verbose = "--verbose" in sys.argv[1:]
    all_failures = []
    all_jogs = []
    checked = 0
    for dirpath, _, filenames in os.walk(ROOT):
        for name in sorted(filenames):
            if not name.endswith(".md"):
                continue
            checked += 1
            failures, jogs = check_file(os.path.join(dirpath, name))
            all_failures.extend(failures)
            all_jogs.extend(jogs)
    if not quiet:
        try:
            for failure in all_failures:
                print(failure)
            if verbose:
                for warning in all_jogs:
                    print("review: " + warning)
            elif all_jogs:
                print(
                    "(+%d wire-jog warning(s) for human review, see --verbose)"
                    % len(all_jogs)
                )
            print(
                "\nchecked %d files, %d problem(s)" % (checked, len(all_failures))
            )
        except BrokenPipeError:
            pass
    return 1 if all_failures else 0


if __name__ == "__main__":
    sys.exit(main())
