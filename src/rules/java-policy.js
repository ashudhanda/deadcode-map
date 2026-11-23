'use strict';

/**
 * Java-specific grading policies (Batch 10 & Batch 11).
 * Centralizes reflection callbacks, utility-class guards, and side-effect
 * initializer checks outside the main confidence monolith.
 */

// Java serialization callbacks (FJ-4): private methods the
// serialization runtime invokes by reflection — ObjectInputStream /
// ObjectOutputStream call them, never in-repo code (Java Object
// Serialization Specification, stream protocol). The (name, arity)
// pair IS the contract: readObject / writeObject take the stream (1),
// readObjectNoData / readResolve / writeReplace take none (0). A
// same-named method with another arity is an ordinary method and
// grades normally. A class need not declare `implements
// Serializable` itself: the contract is inherited (java.lang.Number
// is Serializable, so a Number subclass's readObject is a callback).
const JAVA_SERIALIZATION_CALLBACKS = {
  readObject: 1, writeObject: 1,
  readObjectNoData: 0, readResolve: 0, writeReplace: 0,
};

/**
 * Is this definition a Java serialization callback? The (name, arity)
 * pair is the contract, and the runtime only invokes a PRIVATE one —
 * so a method whose visibility is recorded as anything but private is
 * not a callback. When visibility is unrecorded, stay fail-open and
 * keep the method rather than risking a false SAFE on a real callback.
 * (The pasted draft checked a `def.isPrivate` field that Java
 * definitions do not carry — parse-java records `visibility`
 * ('private' | 'public' | 'package') instead — which would have
 * made this return false for every method and broken the FJ-4 rule.)
 */
function isJavaSerializationCallback(def) {
  if (!def || def.kind !== 'method' || def.isConstructor) return false;
  if (def.visibility && def.visibility !== 'private') return false;
  return JAVA_SERIALIZATION_CALLBACKS[def.name] === def.arity;
}

module.exports = {
  isJavaSerializationCallback,
};
