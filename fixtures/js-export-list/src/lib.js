function onlyExported() { return 1; }
function aliasedFn() { return 2; }
function multiExported() { return 3; }
function deadFn() { return 4; }
function importedFn() { return 5; }
export { onlyExported };
export { aliasedFn as renamed };
export {
  multiExported,
  importedFn,
};
