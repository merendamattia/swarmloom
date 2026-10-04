# [1.19.0](https://github.com/merendamattia/swarmloom/compare/v1.18.1...v1.19.0) (2026-10-04)


### Bug Fixes

* **promotion:** include same-second develop merges ([c95cd8e](https://github.com/merendamattia/swarmloom/commit/c95cd8e6b7786f6714b4aabee7faa610371759e8))
* **promotion:** retain merge-base second source PRs ([820afb2](https://github.com/merendamattia/swarmloom/commit/820afb2061a43b852ff57f941ff7e3ef7997ee4b))
* **promotion:** skip already promoted develop changes ([5ab7cd6](https://github.com/merendamattia/swarmloom/commit/5ab7cd6c54d67f5f8223ec6bd9b3feb8808cb40e))


### Features

* **codex:** replace legacy models with GPT-6.1 Sol ([1a8cdf4](https://github.com/merendamattia/swarmloom/commit/1a8cdf431dca09bc53da30f20ae79d5ef90b5c4e))
* **promotion:** maintain develop to main pull request ([af9c685](https://github.com/merendamattia/swarmloom/commit/af9c685c581380850d6cd2762de230d48775dd9b))

## [1.18.1](https://github.com/merendamattia/swarmloom/compare/v1.18.0...v1.18.1) (2026-10-04)


### Bug Fixes

* **frontend:** give Apple icon a white background ([b49f125](https://github.com/merendamattia/swarmloom/commit/b49f12523a7882ce3437d36070e1ce5aa5cf2eee))

# [1.18.0](https://github.com/merendamattia/swarmloom/compare/v1.17.0...v1.18.0) (2026-10-02)


### Bug Fixes

* **upgrade:** reconcile legacy decomposition issues ([ea0d641](https://github.com/merendamattia/swarmloom/commit/ea0d641fe2abb90e1c0582dd7b64fd9b11bcc286))


### Features

* **workflow:** remove issue decomposition ([ecf125b](https://github.com/merendamattia/swarmloom/commit/ecf125b6d96842a96bab499414586c28afdd2de4))

# [1.17.0](https://github.com/merendamattia/swarmloom/compare/v1.16.0...v1.17.0) (2026-09-25)


### Bug Fixes

* **api:** preserve missing worktree retry guard ([3fd6f66](https://github.com/merendamattia/swarmloom/commit/3fd6f66f4238f9b07d8f7f60123b0a0c18d8cdc3))
* **jobs:** fence durable retry attempts ([f31b602](https://github.com/merendamattia/swarmloom/commit/f31b602ea26cc2a8bb233aefcb9af588a38be84a))
* **jobs:** reclaim fenced terminal execution ([5dce33a](https://github.com/merendamattia/swarmloom/commit/5dce33a7b2d6dec60b38d02fd67052967a18e0df))
* **jobs:** serialize retry cleanup and PR head checks ([709dc69](https://github.com/merendamattia/swarmloom/commit/709dc693b3ce91dc2e8993dbac261b6a7b1f2be8))
* **recovery:** clean terminal worktrees before repository removal ([af386a6](https://github.com/merendamattia/swarmloom/commit/af386a60b93aee9c8cf04edfa96fb5c6fea9e91c))
* **recovery:** fence stale FIX heads and clean closed PR retries ([caa9b1f](https://github.com/merendamattia/swarmloom/commit/caa9b1fcf8b92224f0d2fb2269b72fcba0fd941d))
* **recovery:** fence stale retries and terminal cleanup ([4b91a1f](https://github.com/merendamattia/swarmloom/commit/4b91a1fdd26a6b9b3935a6f0be5a40efff9c50db))
* **recovery:** make terminal cleanup crash-safe ([c55aacd](https://github.com/merendamattia/swarmloom/commit/c55aacda2d78135537e90eafe03a93b79a4f4576))
* **recovery:** reclaim cancelled job worktrees ([e87b85f](https://github.com/merendamattia/swarmloom/commit/e87b85f72e5306a3f27efbed7c99bc7353497545))
* **repositories:** block deletion during terminal job finalization ([6e2a3a0](https://github.com/merendamattia/swarmloom/commit/6e2a3a09b89b4110914d6139603ad9b4e4b84bbb))
* **runner:** fence stale recovery results ([6935269](https://github.com/merendamattia/swarmloom/commit/6935269a8db1c6fe77a7ae488cb0c25cc5572ce3))
* **runner:** isolate response files per execution ([ed83ac6](https://github.com/merendamattia/swarmloom/commit/ed83ac6db69190f302f0708da84c548f06d04f79))
* stop Codex on resumed-session mismatch ([41ec498](https://github.com/merendamattia/swarmloom/commit/41ec4986d06c968671747e7275b8a8319b445c73))


### Features

* **jobs:** resume failed executions from retained state ([0c35121](https://github.com/merendamattia/swarmloom/commit/0c3512119c4ef0d7098b0b7f421c5ca672689227))

# [1.16.0](https://github.com/merendamattia/swarmloom/compare/v1.15.0...v1.16.0) (2026-09-24)


### Features

* **codex:** add GPT-6 catalog models ([a88e7a5](https://github.com/merendamattia/swarmloom/commit/a88e7a57673ef47ca7752a8670a2c94ac1e2db74))

# [1.15.0](https://github.com/merendamattia/swarmloom/compare/v1.14.0...v1.15.0) (2026-09-12)


### Bug Fixes

* **ci:** verify universal Archify skill path ([b668fc0](https://github.com/merendamattia/swarmloom/commit/b668fc08764ad01165cab649dc3c31d1741dd15b))
* **docs:** align provider adapters with runtime boundary ([a4223d6](https://github.com/merendamattia/swarmloom/commit/a4223d61ec2d1b11ad499b981a7bf54e3b118126))
* **docs:** embed Archify SVG styles ([0f94cbf](https://github.com/merendamattia/swarmloom/commit/0f94cbff6a186fa64b67b65296cc00c210c9f663))
* **docs:** size Archify architecture SVG ([6b29403](https://github.com/merendamattia/swarmloom/commit/6b294034cdb4d2d6a86b15e6feb50c017485b857))
* **jobs:** fence stale worker attempts ([fe71bc9](https://github.com/merendamattia/swarmloom/commit/fe71bc9435af0d9901484e3f8e08e19e88562e88))
* **quota:** close paused job lifecycle gaps ([0b85715](https://github.com/merendamattia/swarmloom/commit/0b857152e0d30270795483d6e551f1242410ae09))
* **quota:** fence resumed review attempts ([ab73fe5](https://github.com/merendamattia/swarmloom/commit/ab73fe5b58634b7bc75431d91fc23ef316f9dc58))
* **quota:** fence retries and retained worktree cleanup ([eb6df8e](https://github.com/merendamattia/swarmloom/commit/eb6df8eec6bd342212e65aa307d0f7877548e57e))
* **quota:** reclaim expired failed cleanup leases ([65d7a46](https://github.com/merendamattia/swarmloom/commit/65d7a46f053671636bb8345282dbcd01e56a96ac))
* **quota:** reconcile quota recovery with durable resume ([50287c4](https://github.com/merendamattia/swarmloom/commit/50287c4e1e3eefafe3eb5103045daa21efb87c5a))
* **quota:** recover abandoned terminal work ([37d5b56](https://github.com/merendamattia/swarmloom/commit/37d5b5687fedca0e4982a511fac141584ac78574))
* **recovery:** reclaim cancelled jobs after worker loss ([cf8e850](https://github.com/merendamattia/swarmloom/commit/cf8e8503351264a583d3590c12bccab2a7563946))
* **settings:** scope Codex validation to active provider ([64b50a6](https://github.com/merendamattia/swarmloom/commit/64b50a6637d56094d28c804cdedd0999760e33f0))
* **usage:** align reasoning effort provider contract ([3d3e6fc](https://github.com/merendamattia/swarmloom/commit/3d3e6fc5e023e4552ee7d6e8bd4ee2c62bf56e98))
* **usage:** preserve quota exhaustion and refresh status ([35b8b60](https://github.com/merendamattia/swarmloom/commit/35b8b6062d2e5e6424ff69921298992fe52bcf1a))
* **usage:** reject invalid negative token counts ([2cb7a39](https://github.com/merendamattia/swarmloom/commit/2cb7a39933279de93381cbe1688fc48d45234070))
* **usage:** replay Codex usage on thread resume ([de57136](https://github.com/merendamattia/swarmloom/commit/de571367230018c85699b116712567f27f765c15))
* **usage:** share quota admission with provider telemetry ([edff8f5](https://github.com/merendamattia/swarmloom/commit/edff8f5350c8d4a18b51620e183b009ba6360f13))
* **usage:** share quota state and preserve int64 usage ([0eaaf36](https://github.com/merendamattia/swarmloom/commit/0eaaf361d1112c2539d5fc68bca872e498b154bb))


### Features

* **docs:** adopt Archify runtime architecture ([b58487f](https://github.com/merendamattia/swarmloom/commit/b58487fe489aeb077791717e0be74418a3ca952d))
* **quota:** pause Codex jobs until usage returns ([0f1fcbd](https://github.com/merendamattia/swarmloom/commit/0f1fcbd76b7bd738337e4050b9a40222345d1955))
* **settings:** add catalog-driven Codex selection ([ee3cfc9](https://github.com/merendamattia/swarmloom/commit/ee3cfc969b4ff75e988615dc723994badf0ddb40))
* **usage:** expose Codex quota and job token usage ([f3e1ff7](https://github.com/merendamattia/swarmloom/commit/f3e1ff70987e38c6350ecd8afd417333b6ef52ad))

# [1.14.0](https://github.com/merendamattia/swarmloom/compare/v1.13.0...v1.14.0) (2026-08-28)


### Bug Fixes

* **docs:** normalize rendered diagram files ([9daa98e](https://github.com/merendamattia/swarmloom/commit/9daa98efdbf8f5c3375667db947f97a126075dec))
* **docs:** restore README diagram rendering ([bed0e6f](https://github.com/merendamattia/swarmloom/commit/bed0e6f4b5e6688776563fe7b35f2be19bdd21c7)), closes [#134](https://github.com/merendamattia/swarmloom/issues/134)


### Features

* **frontend:** refine job history views ([528a9ab](https://github.com/merendamattia/swarmloom/commit/528a9ab16bad2d1a7294b188cb0de92d342a8812))

# [1.13.0](https://github.com/merendamattia/swarmloom/compare/v1.12.0...v1.13.0) (2026-08-24)


### Bug Fixes

* **docs:** add responsive mobile diagrams ([a82f013](https://github.com/merendamattia/swarmloom/commit/a82f01327980b1908ad7a22ec550ddfaed8f26f9))
* **docs:** clarify diagram labels and ownership ([3d2a77d](https://github.com/merendamattia/swarmloom/commit/3d2a77daa91443c5e80221057fda074fedf3707f))
* **docs:** connect mobile review pass path ([7a4d2e7](https://github.com/merendamattia/swarmloom/commit/7a4d2e7232374faf8eb10935276bc91e2b111c7f))
* **docs:** simplify diagrams with hand-drawn sources ([25317f1](https://github.com/merendamattia/swarmloom/commit/25317f18dd9f169d9632122bb5cc799ae92bca58))


### Features

* **notifications:** reduce Telegram lifecycle noise ([b595807](https://github.com/merendamattia/swarmloom/commit/b5958075dfe8d609b8cd075c97948d693f4c6824))
* **settings:** configure coding and review agent models ([b97fe71](https://github.com/merendamattia/swarmloom/commit/b97fe71e98b2381c126772157165ef63ee769fc3))

# [1.12.0](https://github.com/merendamattia/swarmloom/compare/v1.11.0...v1.12.0) (2026-08-23)


### Features

* **frontend:** add confirmation dialogs ([0615563](https://github.com/merendamattia/swarmloom/commit/0615563dfbb7717c57d262c2e246a7677a68a2fd))
* **frontend:** unify dashboard interface ([4d8a4cd](https://github.com/merendamattia/swarmloom/commit/4d8a4cd47da19683dbd963625909177423e7f142))

# [1.11.0](https://github.com/merendamattia/swarmloom/compare/v1.10.0...v1.11.0) (2026-08-23)


### Features

* **notifications:** use agent TLDR in Telegram details ([292636f](https://github.com/merendamattia/swarmloom/commit/292636fbd7361e9a64e6b8d7fd5a86bfa51a372e))

# [1.10.0](https://github.com/merendamattia/swarmloom/compare/v1.9.0...v1.10.0) (2026-08-23)


### Bug Fixes

* **jobs:** preserve stack traces in support issues ([a9b3e3b](https://github.com/merendamattia/swarmloom/commit/a9b3e3b27eb840cbb7d4e9238f4e917f52aa5aeb))
* **jobs:** reconcile failed support issue creates ([fb55444](https://github.com/merendamattia/swarmloom/commit/fb554446d3f763ba7575efef4525465a57c22f3e))
* **jobs:** recover and serialize support issue creation ([51ce5b8](https://github.com/merendamattia/swarmloom/commit/51ce5b8cdaae4bbde4bbef6ffc4fa71df8866d75))
* **jobs:** renew support issue claims during requests ([b9a5309](https://github.com/merendamattia/swarmloom/commit/b9a53096dcd2e09a7e4ce6055453a4387d4657e0))
* **runner:** reject duplicate TL;DR markers ([e2c7140](https://github.com/merendamattia/swarmloom/commit/e2c71407458a74661f5f8682bbc1c62164e057aa))
* **runner:** use canonical issue references in PRs ([bc91a12](https://github.com/merendamattia/swarmloom/commit/bc91a1201406a00b8ec9b84b8e82be363a199470))
* **worker:** unblock agent job mutations ([233c58e](https://github.com/merendamattia/swarmloom/commit/233c58e47c358ef14bf33535e01c704fef6fe97b)), closes [#122](https://github.com/merendamattia/swarmloom/issues/122) [#123](https://github.com/merendamattia/swarmloom/issues/123)


### Features

* **dashboard:** clear resolved overview exceptions ([aa2dfce](https://github.com/merendamattia/swarmloom/commit/aa2dfce396a9762e5ff0775538a5a3a23c005fde))
* **jobs:** create support issues from failed jobs ([8953cbe](https://github.com/merendamattia/swarmloom/commit/8953cbe8563667be2551fd5e5fbb188e2a858074))
* **runner:** require TL;DR in agent comments ([851befb](https://github.com/merendamattia/swarmloom/commit/851befbb17cd14066b3cd0cc2fe4fa77dfd9c142))

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
