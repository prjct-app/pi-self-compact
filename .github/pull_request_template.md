## Summary

## Branch flow

- [ ] Normal changes target `develop`, or this is a grouped `develop` → `main` promotion
- [ ] The branch is based on the applicable integration branch

## Official Pi API compliance

- [ ] Uses public APIs documented by Pi 0.85.1; no host internals or prototype patches
- [ ] Pi-provided packages remain peer dependencies

## Safety and compatibility

- [ ] The returned note stays byte for byte; guidance is never persisted
- [ ] Project trust, cancellation, and session teardown are respected
- [ ] No credentials, private paths, or production data are included
- [ ] Protocol and Pi compatibility claims match tests

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run check:package`

## Limitations and manual verification
