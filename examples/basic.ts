import { compileTemplate, parseVariableSchema } from '../src/index.js';

const schema = parseVariableSchema({
  variables: [
    { name: 'companyNameAr', source: 'company', required: true, type: 'text' },
    { name: 'employeeFullNameAr', source: 'employee', required: true, type: 'text' },
    { name: 'issueDate', source: 'document', required: true, type: 'date' },
  ],
});

const result = compileTemplate({
  schema,
  content: 'السادة/ {{companyNameAr}}\nالموظف/ {{employeeFullNameAr}}\nالتاريخ/ {{issueDate}}',
  sources: {
    company: { companyNameAr: 'شركة المثال' },
    employee: { employeeFullNameAr: 'أحمد علي' },
  },
});

console.log(result.rendered);
