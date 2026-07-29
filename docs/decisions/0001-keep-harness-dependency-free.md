# ADR 0001: Keep Harness Checks Dependency-Free

## Status

Accepted

## Context

This package is both the analyzer and a reference harness project. Its own
validation path should work immediately after `npm ci` without requiring
formatter or linter packages that do not add clear user value.

## Decision

Use dependency-free sensors for repository health where practical. The `lint`
script uses Node syntax checks, while `scripts/validate-architecture.js`
enforces package, plugin, CI, release, and template invariants.

## Consequences

The project keeps installation light and still gives agents a single
`npm run ci` command that validates source syntax, tests, architecture, package
contents, and release-critical files.
