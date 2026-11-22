import { Component, memo } from 'react';

function Foo() {
  return <div>memoed</div>;
}

const Memoed = memo(Foo);

export default class UsedDemo extends Component {
  render() {
    return <Memoed />;
  }
}
