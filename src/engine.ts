import type {
  DocumentValues,
  RenderOptions,
  ValueSources,
  VariableDefinition,
  VariableSchema,
} from './types.js';

const SOURCES = new Set(['company', 'employee', 'manual', 'document']);
const TYPES = new Set(['text', 'date', 'email', 'number']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertVariable(variable: unknown, index: number): asserts variable is VariableDefinition {
  if (!isRecord(variable)) throw new Error(`INVALID_VARIABLE_SCHEMA: variables[${index}]`);
  if (typeof variable.name !== 'string' || !variable.name.trim()) {
    throw new Error(`INVALID_VARIABLE_SCHEMA: variables[${index}].name`);
  }
  if (typeof variable.source !== 'string' || !SOURCES.has(variable.source)) {
    throw new Error(`INVALID_VARIABLE_SCHEMA: variables[${index}].source`);
  }
  if (variable.type !== undefined && (typeof variable.type !== 'string' || !TYPES.has(variable.type))) {
    throw new Error(`INVALID_VARIABLE_SCHEMA: variables[${index}].type`);
  }
}

export function parseVariableSchema(input: string | unknown): VariableSchema {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  if (!isRecord(parsed) || !Array.isArray(parsed.variables)) {
    throw new Error('INVALID_VARIABLE_SCHEMA');
  }
  parsed.variables.forEach(assertVariable);
  return parsed as VariableSchema;
}

function clean(value: unknown): unknown {
  return value === undefined ? null : value;
}

export function resolveDocumentValues(args: {
  schema: VariableSchema;
  sources?: ValueSources;
  existingValues?: DocumentValues;
  defaultIssueDate?: string;
}): DocumentValues {
  const values: DocumentValues = { ...(args.existingValues ?? {}) };
  const sources = args.sources ?? {};
  const defaultIssueDate = args.defaultIssueDate ?? new Date().toISOString().slice(0, 10);

  for (const variable of args.schema.variables) {
    const source = sources[variable.source];
    if (source && Object.prototype.hasOwnProperty.call(source, variable.name)) {
      values[variable.name] = clean(source[variable.name]);
      continue;
    }

    if (variable.source === 'document' && variable.name === 'issueDate') {
      values[variable.name] = clean(values[variable.name] ?? defaultIssueDate);
      continue;
    }

    if (variable.source === 'document' && variable.name === 'documentSignatureSection') {
      values[variable.name] = String(values[variable.name] ?? '');
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(values, variable.name)) {
      values[variable.name] = null;
    }
  }

  return values;
}

export function getMissingRequired(schema: VariableSchema, values: DocumentValues): string[] {
  return schema.variables
    .filter((variable) => variable.required)
    .filter((variable) => {
      const value = values[variable.name];
      return value === null || value === undefined || value === '';
    })
    .map((variable) => variable.name);
}

export function renderDocument(
  content: string | null | undefined,
  values: DocumentValues,
  options: RenderOptions = {},
): string {
  let rendered = content ?? '';

  for (const [key, value] of Object.entries(values)) {
    const text = value === null || value === undefined ? '' : String(value);
    rendered = rendered.split(`{{${key}}}`).join(text);
  }

  const unresolved = [...rendered.matchAll(/{{\s*([A-Za-z0-9_.-]+)\s*}}/g)].map((match) => match[1]);

  if (options.strict && unresolved.length > 0) {
    throw new Error(`UNRESOLVED_VARIABLES: ${[...new Set(unresolved)].join(',')}`);
  }

  if (!options.preserveUnknown && unresolved.length > 0) {
    rendered = rendered.replace(/{{\s*[A-Za-z0-9_.-]+\s*}}/g, '');
  }

  return rendered;
}

export function compileTemplate(args: {
  schema: VariableSchema;
  content: string;
  sources?: ValueSources;
  existingValues?: DocumentValues;
  defaultIssueDate?: string;
  strict?: boolean;
}) {
  const values = resolveDocumentValues({
    schema: args.schema,
    sources: args.sources,
    existingValues: args.existingValues,
    defaultIssueDate: args.defaultIssueDate,
  });
  const missingRequired = getMissingRequired(args.schema, values);
  if (missingRequired.length > 0) {
    throw new Error(`MISSING_REQUIRED_VARIABLES: ${missingRequired.join(',')}`);
  }
  const rendered = renderDocument(args.content, values, { strict: args.strict ?? true });
  return { rendered, values };
}
