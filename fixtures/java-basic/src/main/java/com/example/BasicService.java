package com.example;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.*;
import static java.lang.Math.PI;

// Hand-written fixture for the Java analyzer (not copied from any
// repo): planted dead items plus known live items, including the
// shadowing, overload, reflection and string-mention traps.
public class BasicService {
  private int counter;
  private int deadCounter;
  private int writeOnlyCounter;
  private String unusedLabel = "hi";
  private int side;
  private int total;
  private int multiA = 1, multiB = 2;
  private int mixedDead = 1, mixedLive = 2;

  public BasicService() {
    this("default");
  }

  public BasicService(String label) {
    // Unused parameter of a public method: REVIEW, never SAFE
    // (changing a public signature is an API break).
  }

  private BasicService(boolean flag, int n) {
    // Never constructed (arity 2 has no callers): SAFE.
  }

  private BasicService(int side) {
    // The parameter shadows the field: the `side` on the right is the
    // parameter, not a field read, and `this.side` is a field write.
    // The field is written but never read: REVIEW, never SAFE.
    this.side = side;
  }

  public int live() {
    counter += 1;
    writeOnlyCounter = 5;
    if (false) { System.out.println("never"); }
    return helperUsed() + format("x").length() + privateStaticUsed() + mixedLive;
  }

  public int sum() {
    // The block-local `total` shadows the field only inside the block;
    // the `return total` after it reads the FIELD, so it stays live.
    { int total = 5; System.out.println(total); }
    return total;
  }

  public String describe() {
    return "service";
  }

  public List<String> items() {
    return new ArrayList<>();
  }

  private int helperUsed() {
    int unusedLocal = 1;
    return counter;
  }

  private int deadMethod() {
    return 1;
  }

  private int recursiveMethod(int n) {
    if (n <= 0) return 0;
    return recursiveMethod(n - 1);
  }

  private String format(String s) {
    return s;
  }

  private String format(String a, String b) {
    return a + b;
  }

  private static int privateStaticUsed() {
    return 7;
  }

  private static int privateStaticDead() {
    return 8;
  }

  private void byNameOnly() {
  }

  public void reflection() throws Exception {
    getClass().getDeclaredMethod("byNameOnly");
  }

  private void configOnly() {
  }

  private void xmlOnly() {
  }

  private void javaStringOnly() {
  }

  /**
   * Javadoc for a dead method: --fix must remove this comment too.
   */
  private void documentedDead() {
  }

  private int compute(int used, int unusedParam) {
    return used * 2;
  }

  public int runCompute() {
    return compute(21, 0);
  }
}
