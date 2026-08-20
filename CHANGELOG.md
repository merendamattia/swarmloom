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
