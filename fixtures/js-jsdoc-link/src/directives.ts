export type ObjectDirective = {
  bind(el: HTMLElement): void;
};

export type FunctionDirective = (
  el: HTMLElement,
) => void;

export type UnusedDirective = {
  never: boolean;
};

export type PlainMention = {
  prose: boolean;
};
