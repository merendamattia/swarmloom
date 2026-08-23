# [1.9.0](https://github.com/merendamattia/swarmloom/compare/v1.8.0...v1.9.0) (2026-08-21)


### Bug Fixes

* **jobs:** preserve stack traces in support issues ([f84176c](https://github.com/merendamattia/swarmloom/commit/f84176cc1a7cbe71f864407119a00373d50684a2))
* **jobs:** reconcile failed support issue creates ([d32ea98](https://github.com/merendamattia/swarmloom/commit/d32ea98f3360a286ad8a145fd7b8a03895fa0ff7))
* **jobs:** recover and serialize support issue creation ([f8b134d](https://github.com/merendamattia/swarmloom/commit/f8b134d41b76703d912ac914ff96c2f058bf5768))
* **jobs:** renew support issue claims during requests ([682c415](https://github.com/merendamattia/swarmloom/commit/682c415e96663c2a85d7d88ac0d10af4f2ec9210))
* **runner:** reject duplicate TL;DR markers ([ddde668](https://github.com/merendamattia/swarmloom/commit/ddde66868f43798d8dd13ce1ca690f8b5b7c47ef))
* **runner:** use canonical issue references in PRs ([d48ecb3](https://github.com/merendamattia/swarmloom/commit/d48ecb3ab5a4eeadd769f3d045bef430c97514d8))


### Features

* **dashboard:** clear resolved overview exceptions ([338015a](https://github.com/merendamattia/swarmloom/commit/338015aa35ed13b13b3d63e5f2d0d9e056ccc904))
* **jobs:** create support issues from failed jobs ([1c4b4bd](https://github.com/merendamattia/swarmloom/commit/1c4b4bd256657c49943e51c4a5126c8f725794d0))
* **runner:** require TL;DR in agent comments ([80e3a7e](https://github.com/merendamattia/swarmloom/commit/80e3a7e48804272021a2179ce0eec3116e19eab8))

# [1.8.0](https://github.com/merendamattia/swarmloom/compare/v1.7.0...v1.8.0) (2026-08-20)


### Bug Fixes

* **agent-runtime:** preserve Markdown newlines in PR bodies ([5cdfd86](https://github.com/merendamattia/swarmloom/commit/5cdfd8671b26eb173e01d563292faa1d72cb619e))
* **backend:** release scan lock after discovery ([0fb2314](https://github.com/merendamattia/swarmloom/commit/0fb2314fb76b7d5c5cf0785aeb58f80e21537a47))
* **settings:** accept sub-second timing values ([18a2d55](https://github.com/merendamattia/swarmloom/commit/18a2d55a0c9bba3052da9ae13b39de204f78a9d0))
* **settings:** keep repository editor non-empty ([5a9a083](https://github.com/merendamattia/swarmloom/commit/5a9a0832378622acd684af635f72468ee15511f9))


### Features

* **settings:** improve runtime settings readability\n\nWhat: Add repository tag editing, cron descriptions, protected Telegram credential editing, and seconds-based worker timing inputs with info tooltips.\nWhy: Make runtime settings understandable and reduce accidental edits to deployment-oriented values and configured secrets.\nFiles: Update the Settings page and styles; add pure settings presentation helpers and regression tests.\nValidation: bun install --frozen-lockfile; pre-commit run --all-files; bun run db:generate; bun run db:deploy; bun run typecheck; bun run lint; bun run test; bun run build; /usr/local/bin/verify-before-commit. ([37f73df](https://github.com/merendamattia/swarmloom/commit/37f73df41eea19f71c48f4adf9f254350d079b1b))

# [1.7.0](https://github.com/merendamattia/swarmloom/compare/v1.6.1...v1.7.0) (2026-08-20)


### Bug Fixes

* **global.md, runtime-instructions.test.ts:** update instructions for CI command execution and add related tests ([5b6eae8](https://github.com/merendamattia/swarmloom/commit/5b6eae84d65ce2cb582451c3e428a00b8d9943a1))
* **jobs:** pass pre-commit gate and redact final provider output ([14cb730](https://github.com/merendamattia/swarmloom/commit/14cb730055dca5c3f19291308438b209cc060325))
* **jobs:** reconcile diagnostics with modular runner ([bcd75b5](https://github.com/merendamattia/swarmloom/commit/bcd75b58b7b570ae4eafbe973d679b6463b273a6))
* **overview:** add final newlines to version files ([04e1c45](https://github.com/merendamattia/swarmloom/commit/04e1c45a5f75509eb3ea40258c9b1223073d403e))
* **test:** derive version from changelog ([22d6fbb](https://github.com/merendamattia/swarmloom/commit/22d6fbbf4c7aba900d568976855f749166471925))
* **worker:** preserve blocked label after terminal failure ([3db4e8c](https://github.com/merendamattia/swarmloom/commit/3db4e8cc79189f83f4dc2a6ccfbcc74744a0bd8d))
* **worker:** provision CI review toolchain ([fa457a3](https://github.com/merendamattia/swarmloom/commit/fa457a31bec5d74a23bd5d9cf284aa7507268ebe))


### Features

* **frontend:** expose async job state ([5a4ec32](https://github.com/merendamattia/swarmloom/commit/5a4ec32c8797a4915995be5d61ba80ae3bb49aae))
* **jobs:** add copyable diagnostics for failed agent jobs ([63d890f](https://github.com/merendamattia/swarmloom/commit/63d890f273ace0598212ede8f8abf39728301e23))
* **overview:** show deployed application version in Overview ([be59745](https://github.com/merendamattia/swarmloom/commit/be597458a0af300b40a2f993b6b3c62ec986261f))
* **worker:** block original issue after terminal job failure ([d530872](https://github.com/merendamattia/swarmloom/commit/d530872861c7cd9186d9cea0a45c5987a231e0c0))
* **worker:** reconcile PR jobs asynchronously ([8200da8](https://github.com/merendamattia/swarmloom/commit/8200da8656d896067a1094f278bbe78e95ee7f9a))

## [1.6.1](https://github.com/merendamattia/swarmloom/compare/v1.6.0...v1.6.1) (2026-08-19)


### Bug Fixes

* **codex:** allow git push to origin under approe-for-me ([f7633dc](https://github.com/merendamattia/swarmloom/commit/f7633dcb32ac026aa818627f01de6b5e9a6bc30b))
* **global.md, runtime-instructions.test.ts:** enhance instructions on handling Pull Request conflicts and update tests ([cc4b938](https://github.com/merendamattia/swarmloom/commit/cc4b93896146dd8ef6699fd246df4f1257304ede))
* **global.md:** clarify push restrictions for main and develop branches ([f03e15f](https://github.com/merendamattia/swarmloom/commit/f03e15fb98a90d76902427d300fe4bdfe4c2161b))

# [1.6.0](https://github.com/merendamattia/swarmloom/compare/v1.5.0...v1.6.0) (2026-08-19)


### Bug Fixes

* **repo:** allow removing the last repository and persist configuration atomically ([d8496e0](https://github.com/merendamattia/swarmloom/commit/d8496e057722f8eb7a285f6ed10f52d616208872)), closes [#4](https://github.com/merendamattia/swarmloom/issues/4)
* **runner:** retry a role when it exits cleanly without a response file ([104fbf3](https://github.com/merendamattia/swarmloom/commit/104fbf308df6f263b1a4803ca3f7f9576b56328d))
* **runner:** retry a role when it exits cleanly without a response file ([e55d70e](https://github.com/merendamattia/swarmloom/commit/e55d70ef471f9309777d0ee1aac418b5a4a288c5))


### Features

* **overview:** add complete operational summary to the dashboard banner ([6f90f4b](https://github.com/merendamattia/swarmloom/commit/6f90f4bbeb51896fd2f7968fa8673d7db154a6b9))
* **repo:** remove obsolete repositories from the database ([75a911f](https://github.com/merendamattia/swarmloom/commit/75a911f81ab9fa1862be0573d59eafcc781d0285)), closes [#4](https://github.com/merendamattia/swarmloom/issues/4)

# [1.5.0](https://github.com/merendamattia/swarmloom/compare/v1.4.1...v1.5.0) (2026-08-18)


### Bug Fixes

* **runner:** derive retry guidance from the parse error ([8b33e25](https://github.com/merendamattia/swarmloom/commit/8b33e25729dede3338a5ca5bf190397e111d0840))
* **runner:** retry a role when its response file lacks an outcome marker ([1ea4035](https://github.com/merendamattia/swarmloom/commit/1ea4035468e16d2dd0ce18f154aae96fb9e94056))
* **telegram:** correct queued-summary truncation count ([ddc4329](https://github.com/merendamattia/swarmloom/commit/ddc4329ba18512eccc77bfa5b50ddc1649b9042b))


### Features

* **telegram:** aggregate queued job notifications per scan ([8544031](https://github.com/merendamattia/swarmloom/commit/8544031c9d475b74dc9850a66e0c85dc990859a8))

## [1.4.1](https://github.com/merendamattia/swarmloom/compare/v1.4.0...v1.4.1) (2026-08-18)


### Bug Fixes

* **runner:** keep trigger labels and continue the existing PR on review retries ([2127aa0](https://github.com/merendamattia/swarmloom/commit/2127aa042b1f97e25512129e241ccd6a8686381f))

# [1.4.0](https://github.com/merendamattia/swarmloom/compare/v1.3.2...v1.4.0) (2026-08-18)


### Features

* **frontend:** cap Next.js build workers at five CPUs ([467853a](https://github.com/merendamattia/swarmloom/commit/467853ab2a48a80b2db210dfc527621b301565ed)), closes [#26](https://github.com/merendamattia/swarmloom/issues/26)
* **repositories:** add functions to remove job worktrees and perform garbage collection ([f5c4104](https://github.com/merendamattia/swarmloom/commit/f5c4104e202f30b477194b74cfd8e7bf28aff99e))

## [1.3.2](https://github.com/merendamattia/swarmloom/compare/v1.3.1...v1.3.2) (2026-08-18)


### Bug Fixes

* **runner:** verify locally before PR instead of gating on remote checks ([b1b4dd0](https://github.com/merendamattia/swarmloom/commit/b1b4dd0bc97818b65380f7ae9215e99ed9edd234))

## [1.3.1](https://github.com/merendamattia/swarmloom/compare/v1.3.0...v1.3.1) (2026-08-18)


### Bug Fixes

* **worker:** parse pull request list without diff stats ([7ece717](https://github.com/merendamattia/swarmloom/commit/7ece717ede62878381d85a11382c078ab62e2e80))

# [1.3.0](https://github.com/merendamattia/swarmloom/compare/v1.2.0...v1.3.0) (2026-08-18)


### Features

* **frontend:** ship Swarmloom branding ([c6f6758](https://github.com/merendamattia/swarmloom/commit/c6f6758a025647f790224697210d5f2d45dee817))
* **runner:** gate jobs on pull request checks ([ad4a726](https://github.com/merendamattia/swarmloom/commit/ad4a7265caf096160aaea2d8f88dac61fb239de8))

# [1.2.0](https://github.com/merendamattia/swarmloom/compare/v1.1.1...v1.2.0) (2026-08-18)


### Bug Fixes

* **overview:** remove Test Telegram from Recent scans ([54b073e](https://github.com/merendamattia/swarmloom/commit/54b073ee85ef7f364bce1a73d8dff3c175881978))


### Features

* **telegram:** enrich notifications with compact pull request details ([7efb706](https://github.com/merendamattia/swarmloom/commit/7efb706586b02d16c4b62da61e80c392fb75aea9))

## [1.1.1](https://github.com/merendamattia/swarmloom/compare/v1.1.0...v1.1.1) (2026-08-18)


### Bug Fixes

* **deploy:** keep agent runtime in image ([5b911fd](https://github.com/merendamattia/swarmloom/commit/5b911fd4d6149d98b757be235fdacc9dc04864bc))

# [1.1.0](https://github.com/merendamattia/swarmloom/compare/v1.0.0...v1.1.0) (2026-08-18)


### Bug Fixes

* **provider:** defer login until startup ([0a64607](https://github.com/merendamattia/swarmloom/commit/0a64607be4d120406951de48542c2eb8aa82945f))


### Features

* **telegram:** notify lifecycle events ([b27ac82](https://github.com/merendamattia/swarmloom/commit/b27ac8242b2e4c3aaeb3df60a6f3d1f4eb3ccdf2))

# 1.0.0 (2026-08-18)


### Features

* **worker:** establish agent worker ([cada049](https://github.com/merendamattia/swarmloom/commit/cada049aafa721788c366d6ce040e0a02b93cfcd)), closes [#10](https://github.com/merendamattia/swarmloom/issues/10)

# Changelog

All notable changes to this project will be documented in this file by semantic-release.
