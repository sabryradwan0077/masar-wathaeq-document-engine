# Security Policy

## Supported versions

Security review currently targets the latest repository version.

## Reporting a vulnerability

Do not open a public issue containing secrets, personal data, credentials, or exploit details.

For the initial public release, security contact details will be added before publication.

## Design constraints

This package intentionally:
- does not access production databases;
- does not contain credentials or API keys;
- does not make outbound network requests;
- does not implement authentication, billing, or tenant access control;
- escapes HTML output generated from template values.

The repository should never contain customer records, payment data, production environment files, or private deployment configuration.
