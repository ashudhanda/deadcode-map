package com.example;

import java.util.ArrayList;

// Batch 11 gate fixture (hand-written, not copied from any repo).
// Item 1: a dead local / field named after a called method must still
// be found — a method call names the method, not the local or field.
// Item 2: a comment between modifiers must not flip the flags.
// Item 3: `new TypeToken<List<Tweet>>()` constructs TypeToken, and
// `TypeToken<String>::new` constructs it too.
public class Gate {
  // Item 1, local: dead, only foo() shares the name.
  public int foo() { return 1; }
  public int run() {
    int foo = 42; // dead local -> SAFE
    int bar = 7;  // live local: read bare below
    return foo() + bar;
  }

  // Item 1, field: dead, only shadowed() shares the name.
  private int shadowed = 42; // dead field -> SAFE
  public int shadowed() { return 1; }
  public void useShadowed() { shadowed(); }

  // Item 1, field, live control: read bare by a live method.
  private int liveField = 1;
  public int readLive() { return liveField; }

  // Item 1, field, FJ-9 control: read only by a dead method.
  private int deadOnlyField = 2; // dead field -> SAFE
  private String readDeadOnly() { return "" + deadOnlyField; } // dead method -> SAFE

  // Item 2: the /* private */ comment sits between two real modifiers,
  // so the method stays public (REVIEW), never private (SAFE).
  public /* private */ static void commentedPublic() {}
  // Control: genuinely private, uncalled -> SAFE.
  private static void genuinelyPrivate() {}

  // Item 3: constructed only through a generic method reference.
  public java.util.function.Supplier<TypeTokenA<String>> makeA() {
    return TypeTokenA<String>::new;
  }
  // Item 3: constructed only through a generic `new`.
  public Object makeB() {
    return new TypeTokenB<java.util.List<Tweet>>();
  }
  // Item 3, import control: ArrayList is used ONLY through `::new`,
  // so its import must stay live — the class name in a `::new`
  // reference is a real reference, even though the walk treats the
  // identifier child as a definition site.
  public java.util.function.Supplier<java.util.List<String>> makeList() {
    return ArrayList::new;
  }
}

class TypeTokenA<T> {
  private TypeTokenA() {}
}

class TypeTokenB<T> {
  private TypeTokenB() {}
}

class TypeTokenC<T> {
  public int marker() { return 1; } // instance member: not a utility class
  private TypeTokenC() {} // never constructed -> SAFE constructor
}

class Tweet {}
