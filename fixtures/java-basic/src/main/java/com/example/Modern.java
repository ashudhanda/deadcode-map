package com.example;

import java.util.List;
import java.util.function.Function;

// Hand-written fixture for the Java analyzer (not copied from any
// repo): modern syntax that must parse cleanly (records, sealed
// types, pattern matching, switch expressions, text blocks, var,
// try-with-resources) plus method references, lambdas, inner and
// anonymous classes, same-arity overloads and varargs.
public class Modern {
  public void demo() throws Exception {
    Point p = new Point(1, 2);
    Object o = "hello";
    if (o instanceof String s) {
      System.out.println(s);
    }
    String text = """
      hello
      """;
    int n = switch (o) {
      case String s -> 1;
      default -> 0;
    };
    var list = List.of("a", "b");
    try (var in = new java.io.FileInputStream("f")) {
      in.read();
    } catch (Exception e) {
      throw new RuntimeException(e);
    }
    Function<String, String> f = this::viaMethodRef;
    list.forEach(item -> viaLambda(item));
    Inner inner = new Inner();
    inner.call();
    Runnable r = new Runnable() {
      @Override
      public void run() {
        viaAnon();
      }
    };
    new Thread(r).start();
    // Cross-file string mention: BasicService.javaStringOnly is named
    // here, so it must be REVIEW, never SAFE.
    String ref = "javaStringOnly";
    System.out.println(ref + text + n + p + f);
  }

  private String viaMethodRef(String s) {
    return s;
  }

  private void viaLambda(String item) {
    System.out.println(item);
  }

  private void viaAnon() {
  }

  class Inner {
    private void innerUsed() {
    }

    void call() {
      innerUsed();
    }
  }

  // Same-arity overloads: only process(1) is called, but the two
  // overloads are one unit without a type resolver — both stay live.
  private String process(int n) {
    return String.valueOf(n);
  }

  private String process(String s) {
    return s;
  }

  public String runProcess() {
    return process(1);
  }

  // Varargs: a call with arity >= the fixed arity (1) matches.
  private String join(String sep, String... parts) {
    return String.join(sep, parts);
  }

  public String runJoin() {
    return join(",");
  }

  private String joinDead(String sep, String... parts) {
    return sep;
  }
}

record Point(int x, int y) {
}

sealed interface Shape permits Circle {
}

final class Circle implements Shape {
}

enum Color {
  RED, GREEN
}
