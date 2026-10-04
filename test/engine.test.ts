import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileTemplate,
  getMissingRequired,
  parseVariableSchema,
  renderDocument,
  renderHtml,
  resolveDocumentValues,
  safeExportFilename,
} from '../src/index.js';

const schema = parseVariableSchema({
  variables: [
    { name: 'companyNameAr', source: 'company', required: true, type: 'text' },
    { name: 'employeeFullNameAr', source: 'employee', required: true, type: 'text' },
    { name: 'salary', source: 'manual', required: true, type: 'number' },
    { name: 'issueDate', source: 'document', required: true, type: 'date' },
  ],
});

test('resolves values without database coupling', () => {
  const values = resolveDocumentValues({
    schema,
    defaultIssueDate: '2026-10-04',
    sources: {
      company: { companyNameAr: 'شركة مثال' },
      employee: { employeeFullNameAr: 'أحمد علي' },
      manual: { salary: 12000 },
    },
  });

  assert.equal(values.companyNameAr, 'شركة مثال');
  assert.equal(values.employeeFullNameAr, 'أحمد علي');
  assert.equal(values.salary, 12000);
  assert.equal(values.issueDate, '2026-10-04');
  assert.deepEqual(getMissingRequired(schema, values), []);
});

test('renders Arabic RTL template variables', () => {
  const result = compileTemplate({
    schema,
    defaultIssueDate: '2026-10-04',
    content: 'السادة {{companyNameAr}}\nالموظف {{employeeFullNameAr}}\nالراتب {{salary}}\nالتاريخ {{issueDate}}',
    sources: {
      company: { companyNameAr: 'شركة مثال' },
      employee: { employeeFullNameAr: 'أحمد علي' },
      manual: { salary: 12000 },
    },
  });

  assert.match(result.rendered, /شركة مثال/);
  assert.match(result.rendered, /أحمد علي/);
  assert.match(result.rendered, /12000/);
  assert.match(result.rendered, /2026-10-04/);
});

test('strict rendering rejects unresolved variables', () => {
  assert.throws(
    () => renderDocument('Hello {{missing}}', {}, { strict: true }),
    /UNRESOLVED_VARIABLES/,
  );
});

test('required-variable validation is explicit', () => {
  const values = resolveDocumentValues({ schema, sources: { company: { companyNameAr: 'شركة مثال' } } });
  assert.deepEqual(getMissingRequired(schema, values).sort(), ['employeeFullNameAr', 'salary'].sort());
});

test('safe filenames strip unsafe characters', () => {
  assert.equal(safeExportFilename('../../ عقد 123 ', 'docx'), '123.docx');
});

test('HTML output preserves RTL and escapes markup', () => {
  const html = renderHtml({
    title: 'عرض <وظيفي>',
    contentAr: 'مرحبا <script>alert(1)</script>',
    referenceNumber: 'DOC-1',
  });
  assert.match(html, /dir="rtl"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});
