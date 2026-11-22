// Control: a helper under e2e/ that no spec imports is still dead.
// The fix is filename-based (`*.e2e-spec.*`), not directory-based.
export function seedHelper() {
  return 'seed';
}
