# Agents

<!-- fleet:rules:begin — generated from bitbaum/fleet templates/agent-rules.md; edit it there, not here -->

## Org rules

Read `bitbaum/fleet` `AGENTS.md`, `SHARED.md` and the registers it names before
inventing a host, a name, a page or a shared behaviour. Do not copy their facts
into this file.

- **Packages first.** If a `@bitbaum/*` package (or `bip-kit`, `limitkit`,
  `threadkit`, `ai-forms`) already does it, use it and fix a defect in the
  package, not in this app. Every chat is `@bitbaum/chatkit`, every search box
  `@bitbaum/searchkit`, every chart `@bitbaum/chartkit`, accounts
  `@bitbaum/accountkit`, model calls `@bitbaum/ai-kit`. Review this product's
  `package-plan.json` before building anything.
- **One shape per kind.** Things of the same kind look the same and sit in the
  same place (fleet `AGENTS.md`, "One shape per kind").
- **Finished work ships by itself.** Open a non-draft pull request; the fleet
  auto-merge sweep is the only merge path. Never merge by hand, through the
  merge API, with `--auto` or with an admin bypass, and never force-push a
  shared branch.
- **Nothing made up.** A fact on a page or in a doc needs a source that was
  opened; where there is none, the line is removed or softened.
- **Bitcoin orange is for Bitcoin and top-of-funnel actions only.**
- **No model identifier** in anything pushed to a repository.
- Before you finish, run `node <fleet>/scripts/ci/docs-truth-audit.mjs --dir .`:
  the same check the sweep runs on every pull request.

<!-- fleet:rules:end -->

Read `bitbaum/fleet` `AGENTS.md` and `SHARED.md` for shared-package ownership,
release and merge policy. Repository-specific instructions belong below.

This repository owns a reusable package. Fix shared defects here, verify the
package's public exports and affected consumer behavior, release through its
verified release workflow, then update consumers. Preserve product-specific
roles, tenancy, provider configuration and domain behavior in app adapters.

Before adding another implementation, inspect Fleet's package registry for an
existing owner. Shared authentication belongs to `@bitbaum/accountkit`, chat
behavior to `@bitbaum/chatkit`, and model/provider transport to `@bitbaum/ai-kit`.

Read `package.json` for this package's verification command and run it before
publishing changes. Use Fleet's auto-merge sweep; do not bypass its required
checks or rollout holds with manual merging or built-in `--auto`.
