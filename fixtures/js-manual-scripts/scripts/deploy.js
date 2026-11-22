// Run by hand: `node scripts/deploy.js [deploy|rollback]`. Nothing
// imports this file, and rollback() is reached only through argv
// dispatch below — the static graph cannot see the operator invoking
// it by name, so neither function may be flagged dead. migrate() is
// not referenced anywhere at all: the operator runs it by editing the
// script, so it is KEEP too, never SAFE.
function deploy() { return 'deployed'; }
function rollback() { return 'rolled back'; }
function migrate() { return 'migrated'; }

const cmd = process.argv[2];
if (cmd === 'deploy') console.log(deploy());
else if (cmd === 'rollback') console.log(rollback());
