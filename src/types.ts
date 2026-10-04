export type VariableSource = 'company' | 'employee' | 'manual' | 'document';
export type VariableType = 'text' | 'date' | 'email' | 'number';

export type VariableDefinition = {
  name: string;
  labelAr?: string;
  labelEn?: string | null;
  required?: boolean;
  source: VariableSource;
  type?: VariableType;
  editable?: boolean;
};

export type VariableSchema = {
  variables: VariableDefinition[];
  render?: {
    pageBreakMarker?: string;
  };
};

export type DocumentValues = Record<string, unknown>;

export type ValueSources = {
  company?: DocumentValues;
  employee?: DocumentValues;
  manual?: DocumentValues;
  document?: DocumentValues;
};

export type RenderOptions = {
  strict?: boolean;
  preserveUnknown?: boolean;
};

export type Branding = {
  letterheadAr?: string;
  letterheadEn?: string;
  footerAr?: string;
  footerEn?: string;
};

export type DocumentExportInput = {
  title: string;
  referenceNumber?: string;
  issueDate?: string;
  contentAr: string;
  contentEn?: string;
  signatureText?: string;
  branding?: Branding;
};
