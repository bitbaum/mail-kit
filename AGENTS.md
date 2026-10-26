# Agents

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
