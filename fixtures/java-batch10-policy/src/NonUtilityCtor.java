package com.example;

// Hand-written fixture for the batch-10 FJ-2 boundary (not copied
// from any repo): a private constructor of a class WITH instance
// members is not a utility-class guard — when it is never called,
// it stays SAFE.
final class NonUtilityCtor {
  private int value;

  private NonUtilityCtor(int value) {
    this.value = value;
  }

  public int value() {
    return value;
  }
}
