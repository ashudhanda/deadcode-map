export default function HomePage() {
  return 'home';
}

export function getServerSideProps() {
  return { props: {} };
}

export function unusedPageExport() {
  return 'never imported';
}
