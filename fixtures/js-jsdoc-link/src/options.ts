import { ObjectDirective, FunctionDirective, UnusedDirective, PlainMention } from './directives';

/**
 * @deprecated use {@link FunctionDirective} instead
 */
export type OldFn = (
  el: HTMLElement,
) => void;

/**
 * @deprecated use {@linkcode ObjectDirective} instead
 */
export interface OldOpts {
  bind?: OldFn;
}

// PlainMention is only mentioned here in prose, never linked:
// that is not a use, so its import stays flaggable.

export function checkOptions(opts: OldOpts): OldOpts {
  return opts;
}
