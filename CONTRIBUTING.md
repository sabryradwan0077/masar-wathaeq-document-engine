# Contributing

Contributions should keep the document engine independent from any particular database, authentication system, payment provider, or SaaS tenant model.

## Development

```bash
npm install
npm run check
```

## Pull requests

A pull request should:
1. explain the user-facing or maintainer-facing problem;
2. include or update tests;
3. avoid introducing secrets or customer data;
4. preserve Arabic/RTL behavior where relevant;
5. keep database and billing concerns outside the core engine.

## Security

Do not submit credentials, production configuration, customer records, or private legal/business documents.
