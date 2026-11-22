// Control: a plain unimported file is still dead. Only the
// `*.e2e-spec.*` filename is a test file, not the whole tree.
export class Orphan {
  greet() {
    return 'nobody imports me';
  }
}
