package com.example;

// Hand-written fixture for the batch-10 FJ-2 policy (not copied
// from any repo): a private constructor of an all-static utility
// class is an instantiation guard, not dead code — KEEP, never SAFE.
// The anonymous Runnable below must not count as an instance member
// of this class: its methods belong to the anonymous class, so the
// class is still a utility class and its constructor is still a guard.
final class UtilityClass {
  private UtilityClass() {
    throw new UnsupportedOperationException();
  }

  public static String shout(String s) {
    return s.toUpperCase();
  }

  private static int helper() {
    return 42;
  }

  public static final Runnable NOOP = new Runnable() {
    @Override
    public void run() {
      // Nothing to do.
    }
  };
}
