package com.example;

// Hand-written fixture for the batch-10 arity fix (not copied from
// any repo): comments inside argument lists and parameter lists must
// not inflate arity, and enum constants invoke their enum's
// constructor.
class ArityComments {

  public String run(String s) {
    return checked( //
        s, //
        1, //
        true //
    );
  }

  // 3-arg call with a trailing // comment on every line (the junit5
  // validateDelimiter shape): the call arity must be 3, not 7.
  private String checked(String s, int n, boolean flag) {
    return s + n + flag;
  }

  public String blocky(String s) {
    return pair(/* first */ s, /* second */ 2);
  }

  // Call with /* */ comments between arguments: arity must be 2.
  private String pair(String s, int n) {
    return s + n;
  }

  public String joined() {
    return join("a");
  }

  // Varargs declaration with a comment in its parameter list: the
  // declared arity is 2 (fixed arity 1), not 3.
  private String join(String first, /* rest */ String... rest) {
    return first + String.join(",", rest);
  }

  public int sizes() {
    return Kind.SMALL.size + Plain.A.ordinal();
  }

  // Enum constants invoke the constructor: SMALL(1) and LARGE(10)
  // call the 1-arg constructor, so it is live.
  private enum Kind {
    SMALL(1),
    LARGE(10);

    private final int size;

    private Kind(int size) {
      this.size = size;
    }
  }

  // Bare constants invoke the no-arg constructor, so it is live too.
  private enum Plain {
    A,
    B;

    private Plain() {
    }
  }

  // Genuinely dead: called by nothing, so it must stay SAFE.
  private String neverCalled(String s) {
    return s;
  }
}
