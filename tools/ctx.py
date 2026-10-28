#!/usr/bin/env python3
"""Extract ±N chars around every match of a pattern in a file (minified-JS surgery)."""
import re, sys

def main():
    path, pattern, before, after = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    flags = re.IGNORECASE if "-i" in sys.argv else 0
    text = open(path, encoding="utf-8", errors="replace").read()
    n = 0
    for m in re.finditer(pattern, text, flags):
        s, e = max(0, m.start() - before), min(len(text), m.end() + after)
        n += 1
        print(f"--- match {n} @ {m.start()} ---")
        print(text[s:e])
        print()
        if n >= 20:
            print("(truncated at 20 matches)")
            break
    if n == 0:
        print("no matches")

if __name__ == "__main__":
    main()
