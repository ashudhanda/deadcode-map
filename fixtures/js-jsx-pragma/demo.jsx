// eslint-disable-next-line no-unused-vars
import {
  createElement,
  Component,
  memo,
  Fragment,
  Suspense,
  lazy
} from 'react';

function LazyComp() {
  return <div>lazy loaded</div>;
}

const Lazy = lazy(() => Promise.resolve({ default: LazyComp }));

export default class Demo extends Component {
  render() {
    return (
      <div>
        <Suspense fallback={<div>Loading</div>}>
          <Lazy />
        </Suspense>
      </div>
    );
  }
}
