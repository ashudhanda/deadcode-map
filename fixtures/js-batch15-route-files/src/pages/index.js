// Next.js route control: files under pages/ keep their symbols
// through frameworks/next.json entryPatterns — the route-directory
// fix must not take that away.
export default function HomePage() {
  return 'home';
}

export function getServerSideProps() {
  return { props: {} };
}

export function unusedPageExport() {
  return 'never imported';
}
