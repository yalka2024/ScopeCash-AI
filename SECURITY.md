# Security Policy — ScopeCash AI

> Provided by the `example-security-docs` plugin. Override or remove by
> setting `"enabled": false` in `plugins/example-security-docs/plugin.json`.

## Reporting a vulnerability

Please email `security@scopecash-ai.example.com`. We aim to acknowledge
reports within 2 business days and triage within 5.

## Coordinated disclosure

We follow a 90-day coordinated disclosure window from acknowledgement.

## Hardening defaults shipped with this platform

- JWT secret guard refuses to boot with placeholder values
- CSP, HSTS (when behind TLS), and rate limiting enabled by default
- Audit log is append-only with hash chaining
- Refresh tokens rotate on every use
- MFA TOTP available out of the box
- Container images run as non-root and are signed via cosign

