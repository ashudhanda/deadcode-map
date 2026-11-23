// Batch 13 chain-call fixture (hand-written): a return value that
// continues on the next line with a computed member access
// (`return colorOf(code)` / `[theme ...](...)` — the umami
// WorldMap.tsx getFillColor shape) is one expression, never
// unreachable code. The web analyzer's statement splitter used to
// treat the `[` line as a new statement after the return and flag it
// SAFE. Arrow-function properties (not shorthand methods) hold the
// shade functions, so the CLI's method findings stay out of this
// fixture: a computed-key call is invisible to both analyzers, and a
// shorthand method with 0 callers would be a CLI-only REVIEW.
'use strict';

function colorOf(code) {
  return {
    lighten: (amount) => ({ toHex: () => '#ffffff' }),
    darken: (amount) => ({ toHex: () => '#000000' }),
  };
}

function getFillColor(code, theme) {
  if (code === 'AQ') return undefined;
  const found = code !== 'ZZ';
  if (!found) {
    return '#cccccc';
  }
  return colorOf(code)
    [theme === 'light' ? 'lighten' : 'darken'](0.4)
    .toHex();
}

// A second live shape: the return value is an identifier, not a
// call, and the `[` line still continues it.
function getTint(palette, theme) {
  const base = palette;
  return base
    [theme === 'light' ? 'lighten' : 'darken'](0.4)
    .toHex();
}

// Control: a plain statement after `return` is genuinely unreachable
// and must still be flagged SAFE (the js-hoisted still-dead.js shape).
function deadAfterReturn() {
  return 1;
  console.log('this line never runs');
}

// Control: a `[` line after a return that DOES end with `;` is a
// fresh array-literal statement, genuinely unreachable — the `;`
// guard must still flag it SAFE.
function deadChainAfterReturn(flag) {
  if (flag) {
    return;
    [1, 2].forEach((n) => n);
  }
  return 0;
}

module.exports = { colorOf, getFillColor, getTint, deadAfterReturn, deadChainAfterReturn };
