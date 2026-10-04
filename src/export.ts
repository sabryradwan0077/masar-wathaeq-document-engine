import {
  AlignmentType,
  Document as DocxDocument,
  Footer,
  Header,
  Packer,
  PageBreak,
  Paragraph,
  TextRun,
} from 'docx';

import type { DocumentExportInput } from './types.js';

export function safeExportFilename(referenceNumber: string | undefined, extension: 'docx' | 'html'): string {
  const base = String(referenceNumber || 'document')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120) || 'document';
  return `${base}.${extension}`;
}

function isArabic(text: string): boolean {
  return /[\u0600-\u06ff]/.test(text);
}

function paragraph(text: string, options?: { bold?: boolean; center?: boolean }): Paragraph {
  const rtl = isArabic(text);
  return new Paragraph({
    bidirectional: rtl,
    alignment: options?.center ? AlignmentType.CENTER : rtl ? AlignmentType.RIGHT : AlignmentType.LEFT,
    spacing: { after: 130, line: 360 },
    children: [
      new TextRun({
        text,
        bold: options?.bold,
        rightToLeft: rtl,
        font: 'Arial',
        size: options?.bold ? 26 : 22,
      }),
    ],
  });
}

function appendBody(target: Paragraph[], body: string): void {
  for (const [index, part] of body.replace(/\r\n/g, '\n').split('[[PAGE_BREAK]]').entries()) {
    if (index > 0) target.push(new Paragraph({ children: [new PageBreak()] }));
    for (const line of part.split('\n')) target.push(paragraph(line));
  }
}

export async function renderDocxBuffer(input: DocumentExportInput): Promise<Buffer> {
  const body: Paragraph[] = [paragraph(input.title, { bold: true, center: true })];

  if (input.referenceNumber) body.push(paragraph(`رقم المرجع: ${input.referenceNumber}`));
  if (input.issueDate) body.push(paragraph(`تاريخ الإصدار: ${input.issueDate}`));

  appendBody(body, input.contentAr);

  if (input.contentEn) {
    body.push(new Paragraph({ children: [new PageBreak()] }));
    appendBody(body, input.contentEn);
  }

  if (input.signatureText) {
    body.push(paragraph(''));
    body.push(paragraph(input.signatureText, { bold: true }));
    body.push(paragraph('______________________________'));
  }

  const headerLines = [input.branding?.letterheadAr, input.branding?.letterheadEn].filter(Boolean) as string[];
  const footerLines = [input.branding?.footerAr, input.branding?.footerEn].filter(Boolean) as string[];

  const doc = new DocxDocument({
    sections: [{
      properties: { page: { margin: { top: 1100, right: 900, bottom: 1100, left: 900 } } },
      headers: {
        default: new Header({
          children: headerLines.map((line) => paragraph(line, { center: true })),
        }),
      },
      footers: {
        default: new Footer({
          children: footerLines.map((line) => paragraph(line, { center: true })),
        }),
      },
      children: body,
    }],
  });

  return Packer.toBuffer(doc);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]!));
}

function bodyHtml(text: string, dir: 'rtl' | 'ltr'): string {
  const parts = text.replace(/\r\n/g, '\n').split('[[PAGE_BREAK]]');
  return parts
    .map((part, index) => {
      const lineHtml = part.split('\n').map((line) => `<p>${escapeHtml(line) || '&nbsp;'}</p>`).join('');
      const pageBreak = index < parts.length - 1 ? '<div class="page-break"></div>' : '';
      return `<section class="doc-body ${dir}" dir="${dir}">${lineHtml}</section>${pageBreak}`;
    })
    .join('');
}

export function renderHtml(input: DocumentExportInput): string {
  const meta = [
    input.referenceNumber ? `<span><b>Reference:</b> ${escapeHtml(input.referenceNumber)}</span>` : '',
    input.issueDate ? `<span><b>Date:</b> ${escapeHtml(input.issueDate)}</span>` : '',
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
@page { size: A4; margin: 22mm 18mm 24mm; }
body { font-family: Arial, "Segoe UI", Tahoma, sans-serif; color: #18181b; }
header, footer { padding: 10px 0; border-color: #d4d4d8; }
header { border-bottom: 1px solid #d4d4d8; margin-bottom: 20px; }
footer { border-top: 1px solid #e4e4e7; margin-top: 28px; font-size: 10px; color: #52525b; }
h1 { text-align: center; font-size: 20px; }
.meta { direction: ltr; text-align: center; font-size: 12px; margin: 12px 0 22px; }
.rtl { direction: rtl; text-align: right; }
.ltr { direction: ltr; text-align: left; }
.doc-body p { margin: 0 0 8px; line-height: 1.8; white-space: pre-wrap; }
.page-break { break-before: page; }
</style>
</head>
<body>
<header>
  <div class="rtl">${escapeHtml(input.branding?.letterheadAr ?? '')}</div>
  <div class="ltr">${escapeHtml(input.branding?.letterheadEn ?? '')}</div>
</header>
<h1>${escapeHtml(input.title)}</h1>
<div class="meta">${meta}</div>
${bodyHtml(input.contentAr, 'rtl')}
${input.contentEn ? bodyHtml(input.contentEn, 'ltr') : ''}
${input.signatureText ? `<div class="rtl"><b>${escapeHtml(input.signatureText)}</b></div>` : ''}
<footer>
  <div class="rtl">${escapeHtml(input.branding?.footerAr ?? '')}</div>
  <div class="ltr">${escapeHtml(input.branding?.footerEn ?? '')}</div>
</footer>
</body>
</html>`;
}
