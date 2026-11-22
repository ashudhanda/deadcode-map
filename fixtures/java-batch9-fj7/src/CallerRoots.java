package com.example;

// Hand-written fixture for the batch-9 FJ-7 / FJ-9 fix (not copied
// from any repo): a package-private class whose non-private methods
// are the live roots — the private helpers they call, and the fields
// they read, are live — plus a dead cluster that must stay SAFE.
class CallerRoots {
  private int usedByPublic;
  private int usedByPackage;
  private int usedByChain;
  private int deadField;
  private int deadOnlyField;

  public CallerRoots() {
    this("default");
  }

  public CallerRoots(String label) {
    helperFromPublic(label);
  }

  private CallerRoots(String tag, int n) {
    // Never constructed (arity 2 has no callers): SAFE.
    // (The parameter is named `tag`, not `label`: the public
    // constructor's `label` parameter is read, and the parser's
    // read counts are name-keyed, so sharing the name would
    // wrongly credit this parameter with that read.)
  }

  public String serve(String s) {
    usedByPublic = s.length();
    return usedByPublic + helperFromPublic(s);
  }

  String pack(String s) {
    usedByPackage = s.length();
    return usedByPackage + helperFromPackage(s);
  }

  public String chain(String s) {
    return middle(s);
  }

  public String show(String s) {
    return format(s);
  }

  private String helperFromPublic(String s) {
    return s;
  }

  private String helperFromPackage(String s) {
    return s;
  }

  private String middle(String s) {
    return leaf(s) + usedByChain;
  }

  private String leaf(String s) {
    return s;
  }

  // Dead cluster: deadOuter is called only by deadInner, and
  // deadInner is called by nothing — both stay SAFE, and so does the
  // field only deadInner reads.
  private String deadOuter(String s) {
    return deadInner(s);
  }

  private String deadInner(String s) {
    return s + deadOnlyField;
  }

  private String orphan(String s) {
    return s;
  }

  // Arity: the public method calls format/1; the private format/2
  // overload has no live caller and stays SAFE.
  private String format(String s) {
    return s;
  }

  private String format(String a, String b) {
    return a + b;
  }

  // Self-call only: pure recursion with no entry point stays SAFE.
  private String selfOnly(int n) {
    if (n <= 0) return "";
    return selfOnly(n - 1);
  }

  // A private overload sharing the public method's name: the public
  // serve/1 does not call serve/2, so serve/2 stays SAFE — the
  // private overload must not become a root just by sharing the name.
  private String serve(String a, String b) {
    return a + b;
  }

  // Field initializer: labelFromInitializer runs when the class
  // loads, so it is live even though no method body calls it — and
  // so is the constant it reads.
  private static final String PREFIX = "root:";
  private final String label = labelFromInitializer();

  private static String labelFromInitializer() {
    return PREFIX + "hi";
  }

  public String showLabel() {
    return label;
  }

  // Same name AND arity, different parameter types: the public
  // overload calls the private one — the self-call exclusion must
  // not swallow a call between two distinct overloads.
  public String convert(String s) {
    return convert(s.length());
  }

  private String convert(int n) {
    return String.valueOf(n);
  }
}
