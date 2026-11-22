'use strict';

// Entry point. lodash is used via a subpath import, express and
// @scope/pkg via plain require. left-pad, moment, unused-dep and
// @dead/scope are never imported — they are only mentioned in prose.
const _ = require('lodash/fp');
const express = require('express');
const scoped = require('@scope/pkg');

function main() {
  console.log(_.map, express, scoped);
}

main();
