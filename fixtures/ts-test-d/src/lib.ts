export interface Widget {
  name: string;
  size: number;
}

export function usedFn(): Widget {
  return { name: 'w', size: 1 };
}

export function deadExport(): number {
  return 2;
}

function deadPrivate(): number {
  return 3;
}
