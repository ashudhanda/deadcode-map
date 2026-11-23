package com.example;

import java.util.ArrayList;
import java.util.List;

// Hand-written fixture for the batch-11 field analog of the FJ-3
// rule (not copied from any repo): a private field that is never
// read or written, but whose initializer calls a method or creates
// an object, is load-bearing — REVIEW, never SAFE — because
// deleting the declaration would remove that call. A field
// initializer runs when the class loads / an instance is created,
// so the call runs even though the field is never read. A pure
// unused field stays SAFE, a call inside a lambda body does not
// run at the declaration, so that field is pure too, and a field
// with an effectful initializer that IS read is live and gets no
// finding at all.
final class SideEffectFields {
  // Pure: never read, no call — SAFE.
  private int pure = 1;
  // Method call: does work — REVIEW.
  private int count = compute(3);
  // Object creation: the constructor runs — REVIEW.
  private List<String> copy = new ArrayList<>();
  // Call nested in an expression — REVIEW.
  private int total = compute(3) + 1;
  // A call inside a lambda body does NOT run at the declaration:
  // the field is pure, so SAFE.
  private Runnable deferred = () -> compute(0);
  // A call passed as an argument runs now — REVIEW.
  private int eager = compute(3);
  // Live: effectful initializer, but the field IS read — no finding.
  private int live = compute(5);

  public int useLive() {
    return live;
  }

  private static int compute(int n) {
    return n * 2;
  }
}
