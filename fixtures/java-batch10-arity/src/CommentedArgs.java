package com.example;

// Hand-written fixture for the batch-10 arity fix (not copied from
// any repo): comments inside an argument list are extras, not
// arguments — a call written as `check(a, // note\n b)` has arity 2,
// not 3. Counting the comments inflated the recorded arity, so the
// call never matched the declaration and the callee looked dead
// (junit5's validateDelimiter/3 was recorded as /7 and flagged SAFE
// though validate/3 calls it). The same shape applies to a
// constructor call (`new Holder(a, // note\n b)` is arity 2).
final class CommentedArgs {
  private CommentedArgs() {}

  public void run() {
    check( //
        "a", //
        "b" //
    );
    checkOne("only");
  }

  private void check(String first, String second) {
    System.out.println(first + second);
  }

  private void checkOne(String only) {
    System.out.println(only);
  }

  public Holder build() {
    return new Holder( //
        "x", //
        "y" //
    );
  }

  static final class Holder {
    private final String first;
    private final String second;

    Holder(String first, String second) {
      this.first = first;
      this.second = second;
    }
  }
}
