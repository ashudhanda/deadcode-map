package com.example;

import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.ObjectStreamException;
import java.io.Serializable;

// Hand-written fixture for the batch-10 FJ-4 rule (not copied from
// any repo): private serialization callbacks are invoked by the
// serialization runtime via reflection, never by in-repo code —
// KEEP, never SAFE. A same-named method with the wrong arity is an
// ordinary method and grades normally.
final class SerializationCallbacks implements Serializable {
  private static final long serialVersionUID = 1L;

  private void writeObject(ObjectOutputStream out) throws IOException {
    out.defaultWriteObject();
  }

  private void readObject(ObjectInputStream in) throws IOException, ClassNotFoundException {
    in.defaultReadObject();
  }

  private void readObjectNoData() throws ObjectStreamException {
    throw new java.io.InvalidObjectException("no data");
  }

  private Object readResolve() {
    return this;
  }

  private Object writeReplace() {
    return this;
  }

  // Same name, wrong arity: not a callback — an ordinary private
  // method with no callers, so SAFE.
  private void readObject(ObjectInputStream in, int extra) {
  }

  // Same name, wrong arity: not a callback — SAFE.
  private Object writeReplace(String reason) {
    return this;
  }
}
