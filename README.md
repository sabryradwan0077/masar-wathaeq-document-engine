# Masar Wathaeq Document Engine

A database-agnostic TypeScript document engine extracted from the production work behind **Masar Wathaeq**.

It focuses on a reusable problem: generating Arabic/RTL and bilingual business documents from typed variable schemas without coupling the rendering layer to a SaaS database, authentication system, billing provider, or customer data.

## Why this repository exists

The original Masar Wathaeq application contains commercial SaaS features. The published document-engine package intentionally remains a reusable, database-agnostic library; the optional `app/` directory is a separate local web-app example that consumes it.

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

## Local AI workspace MVP

The repository also includes an Arabic-first web app in `app/` that uses the document engine:

- local email/password accounts, server-side sessions, and SQLite persistence for conversations and agents;
- chat with an OpenAI-compatible AI provider, including image analysis;
- voice transcription and text-to-speech through compatible audio endpoints;
- editable AI document drafts with DOCX and HTML export;
- user-configurable agents with optional web search, document drafting, and email drafting tools;
- Tavily web search and SMTP email sending (with a separate confirmation before sending);
- manual monthly subscriptions through Vodafone Cash, with admin-reviewed transfer references and AI access enabled after approval;

To run it locally, use Node.js 22 or later, copy `.env.example` to `.env`, set `AI_API_KEY` and `AI_API_BASE_URL` / `AI_MODEL` as needed, then run:

```bash
npm run dev
```

Open `http://127.0.0.1:4173` and create an account. Set `TAVILY_API_KEY` to enable web search, and `SMTP_URL` plus `SMTP_FROM` to enable email. AI model names for vision, transcription, and speech can be overridden with the corresponding `AI_*_MODEL` variables. The SQLite database defaults to `data/masar.sqlite` and can be moved using `MASAR_DATABASE_PATH`. The default Vodafone Cash number is `+201015707603` and the monthly price is 200 EGP; configure `VODAFONE_CASH_NUMBER`, `MONTHLY_PRICE_EGP`, `BILLING_ADMIN_EMAIL`, and a strong, private `BILLING_ADMIN_KEY` for a deployment. Generate a key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and set it only in the server's ignored `.env`. The account matching `BILLING_ADMIN_EMAIL` must also provide the key in the billing screen before reviewing requests. Users submit a transfer reference after paying; an administrator must manually verify the transfer and approve or reject each request. AI and business-integration operations require an active approved subscription; accounts and billing remain accessible before payment.

Provider configuration examples:

```dotenv
AI_API_BASE_URL=https://api.openai.com/v1
AI_API_KEY=your-server-side-key
AI_MODEL=gpt-4o-mini
TAVILY_API_KEY=your-tavily-key
SMTP_URL=smtps://user:password@smtp.example.com:465
SMTP_FROM="Masar <no-reply@example.com>"
BILLING_ADMIN_EMAIL=admin@example.com
BILLING_ADMIN_KEY=<random-private-secret>
MONTHLY_PRICE_EGP=200
VODAFONE_CASH_NUMBER=+201015707603
```

If SMTP credentials contain reserved URL characters, percent-encode them in `SMTP_URL`.

All API keys and SMTP credentials stay on the server. Uploaded image and audio content is sent to the configured AI provider for the requested operation; image files and audio recordings are not stored by the app. Account passwords use scrypt hashes, session tokens are stored as hashes, and browser sessions use HttpOnly, SameSite cookies. Back up the SQLite database securely. This remains an early single-server MVP: it does not include email verification, password recovery, account administration, tenant sharing, billing, image generation, or OAuth. The default server binds to localhost; do not expose it publicly without HTTPS, backups, abuse controls, and a reviewed deployment configuration.

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
