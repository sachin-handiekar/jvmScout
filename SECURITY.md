# Security Policy

jvmScout is an in-process JVM agent that can capture sensitive runtime data
(local variable values, environment variables, stack frames). We take security
and privacy seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Email **security@jvmscout.dev** with:

- A description of the issue and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected component(s): agent, BCI transformer, collector, or UI.
- Affected version / commit.

You can expect an acknowledgement within **3 business days** and a status update
within **10 business days**. Once a fix is available we will coordinate a
disclosure timeline with you and credit you (unless you prefer to remain
anonymous).

## Supported versions

jvmScout is pre-1.0. Security fixes are applied to the latest release on the
`main` branch only.

| Version | Supported |
|---------|-----------|
| `main` / latest release | ✅ |
| older pre-releases | ❌ |

## Data-handling notes for operators

Because the agent can capture secrets and PII, please review these before
deploying beyond localhost:

- Use the `capture_packages` allowlist to limit capture to your own packages.
- Keep `redact_props` configured for sensitive keys (tokens, passwords, etc.).
- Run the collector behind authentication and TLS (see the docs); the default
  configuration assumes a trusted local/intranet network.
- Restrict `env_capture` globs to only the variables you actually need.
