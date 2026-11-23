package com.example;

import java.util.ArrayList;
import java.util.List;

// Hand-written fixture for the batch-10 FJ-3 rule (not copied from
// any repo): an unused local whose initializer calls a method or
// creates an object is load-bearing — REVIEW, never SAFE — because
// deleting the declaration would remove that call. A pure unused
// local stays SAFE, and a call inside a lambda body does not run at
// the declaration, so that local is pure too.
final class SideEffectLocals {
  private SideEffectLocals() {}

  public int measure(List<String> items) {
    // Pure: never read, no call — SAFE.
    int pure = 1;
    // Method call: does work — REVIEW. (Named `count`, not `size`:
    // a local named after a method called in the same file is
    // swallowed by the name-keyed same-file gate before the local
    // branch runs — a known recall gap, not part of FJ-3.)
    int count = items.size();
    // Object creation: the constructor runs — REVIEW.
    List<String> copy = new ArrayList<>(items);
    // Call nested in an expression — REVIEW.
    int total = compute(items.size());
    // A call inside a lambda body does NOT run at the declaration:
    // the local is pure, so SAFE.
    Runnable deferred = () -> compute(0);
    // A call passed as an argument runs now — REVIEW.
    int eager = compute(items.size());
    return items.size();
  }

  private static int compute(int n) {
    return n * 2;
  }
}
