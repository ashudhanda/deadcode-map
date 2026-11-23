package com.example;

// Hand-written fixture for the batch-10 FJ-2 enum rule (not copied
// from any repo): a private enum constructor is invoked by the enum
// constants at class-load time, and the call graph has no edge for
// constant initialization — so it can never be proven dead. KEEP,
// never SAFE.
enum EnumConstants {
  FIRST("first"),
  SECOND("second");

  private final String label;

  private EnumConstants(String label) {
    this.label = label;
  }

  public String label() {
    return label;
  }
}

// A constructor no constant invokes: ONLY uses the no-arg
// constructor, so the one-arg constructor has no call-graph edge —
// yet it is KEEP, never SAFE: the constructor is the wrong deletion
// unit for an enum; delete the constant, or the enum, instead.
enum UnusedArity {
  ONLY;

  private final int code;

  private UnusedArity() {
    this.code = 0;
  }

  private UnusedArity(int code) {
    this.code = code;
  }
}
