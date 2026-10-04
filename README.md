# Masar Wathaeq Document Engine

A database-agnostic TypeScript document engine extracted from the production work behind **Masar Wathaeq**.

It focuses on a reusable problem: generating Arabic/RTL and bilingual business documents from typed variable schemas without coupling the rendering layer to a SaaS database, authentication system, billing provider, or customer data.

## Why this repository exists

The original Masar Wathaeq application contains commercial SaaS features. This repository intentionally contains only the reusable document-engine layer.

**Excluded by design:**
- authentication and organizations
- subscriptions and payments
- customer data and production databases
- private deployment configuration
- proprietary SaaS workflows

## Features

- typed variable schemas
- company / employee / manual / document value sources
- required-field validation
- strict unresolved-variable detection
- Arabic/RTL template rendering
- bilingual HTML export
- DOCX generation
- page-break marker support
- safe export filenames
- zero database dependency

## Quick start

```bash
npm install
npm run check
```

Example:

```ts
import { compileTemplate, parseVariableSchema } from 'masar-wathaeq-document-engine';

const schema = parseVariableSchema({
  variables: [
    { name: 'companyNameAr', source: 'company', required: true, type: 'text' },
    { name: 'employeeFullNameAr', source: 'employee', required: true, type: 'text' },
    { name: 'issueDate', source: 'document', required: true, type: 'date' }
  ]
});

const result = compileTemplate({
  schema,
  content: 'السادة/ {{companyNameAr}}\nالموظف/ {{employeeFullNameAr}}\nالتاريخ/ {{issueDate}}',
  sources: {
    company: { companyNameAr: 'شركة المثال' },
    employee: { employeeFullNameAr: 'أحمد علي' }
  }
});

console.log(result.rendered);
```

## Architecture

The engine separates data acquisition from document generation. Applications pass plain objects into the engine; the engine never queries a database and never knows about tenants, users, subscriptions, or billing.

This makes the package suitable for HR systems, internal business tools, document automation products, and Arabic-first applications.

## Security posture

- No secrets or environment variables are required.
- No remote network requests are made by the engine.
- HTML export escapes untrusted content.
- Strict mode can reject unresolved placeholders.
- No customer or production data is included.

See [SECURITY.md](SECURITY.md).

## Project status

Early open-source extraction candidate. The core functions are derived from working Masar Wathaeq document-generation logic and are being isolated and tested as a standalone package.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
