// A dead chain of exported helpers that only call each other, shaped
// like umami src/lib/react.ts: an exported type plus exported
// functions, all dead — getKids is used only by mapKids, mapKids only
// by cloneKids, cloneKids only by renderKids, and the type only in
// dead signatures and casts. No live code anywhere reaches them.
export type ElementWithKids = {
  children?: unknown;
};

export function getKids(el: ElementWithKids): unknown[] {
  if (!el.children) return [];
  return Array.isArray(el.children) ? el.children : [el.children];
}

export function isKid(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

export function mapKids(items: unknown[]): unknown[] {
  return items.map((item) => (isKid(item) ? getKids(item as ElementWithKids) : item));
}

export function cloneKids(items: unknown[]): unknown[] {
  return mapKids(items);
}

export function renderKids(items: unknown[]): unknown[] {
  return cloneKids(items);
}

export function countKids(items: unknown[]): number {
  return getKids(items[0] as ElementWithKids).length;
}

// A dead recursive function: self-use alone never makes it live.
export function deadRecursive(n: number): number {
  return n <= 0 ? 0 : deadRecursive(n - 1);
}

// A dead mutual-recursion cycle: no live root reaches either member.
export function deadPing(n: number): number {
  return deadPong(n);
}

export function deadPong(n: number): number {
  return deadPing(n);
}

// Live controls: called at the top level of this file, so the whole
// chain they reach is live; liveEntry is also imported by index.ts.
export function liveHelper(items: unknown[]): unknown[] {
  return items;
}

export function liveEntry(items: unknown[]): unknown[] {
  return liveHelper(items);
}

liveEntry([]);
