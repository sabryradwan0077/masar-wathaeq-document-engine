import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { MAX_EXTRACTED_CHARS, MAX_UPLOAD_BYTES } from './file-search.mjs';

const documentTypes = new Map([
  ['.pdf', { mimeType: 'application/pdf' }],
  ['.docx', { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
  ['.txt', { mimeType: 'text/plain' }],
  ['.md', { mimeType: 'text/markdown' }],
  ['.csv', { mimeType: 'text/csv' }],
]);

export class FileInputError extends Error {}

export async function extractUploadedText(file) {
  if (!Buffer.isBuffer(file.data) || file.data.length === 0) {
    throw new FileInputError('الملف فارغ أو لم يصل بصورة صحيحة.');
  }
  if (file.data.length > MAX_UPLOAD_BYTES) {
    throw new FileInputError('الحد الأقصى لحجم الملف الواحد هو 100 ميجابايت.');
  }

  const extension = path.extname(file.filename).toLowerCase();
  const specification = documentTypes.get(extension);
  if (!specification) throw new FileInputError('الصيغ المدعومة: PDF وWord وTXT وMarkdown وCSV.');
  if (file.mimeType !== specification.mimeType && file.mimeType !== 'application/octet-stream') {
    throw new FileInputError('نوع الملف لا يتوافق مع امتداده.');
  }

  let extracted;
  if (extension === '.pdf') {
    if (!file.data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new FileInputError('الملف لا يبدو أنه مستند PDF صالح.');
    }
    const parser = new PDFParse({ data: file.data });
    try {
      extracted = (await parser.getText()).text;
    } catch {
      throw new FileInputError('تعذر استخراج النص من PDF. تأكد أن الملف غير تالف وغير محمي بكلمة مرور.');
    } finally {
      await parser.destroy();
    }
  } else if (extension === '.docx') {
    if (file.data.subarray(0, 2).toString() !== 'PK') {
      throw new FileInputError('الملف لا يبدو أنه مستند Word صالح.');
    }
    try {
      extracted = (await mammoth.extractRawText({ buffer: file.data })).value;
    } catch {
      throw new FileInputError('تعذر استخراج النص من ملف Word. تأكد أن الملف غير تالف.');
    }
  } else {
    if (file.data.includes(0)) throw new FileInputError('ملفات النص يجب أن تكون بترميز UTF-8.');
    try {
      extracted = new TextDecoder('utf-8', { fatal: true }).decode(file.data).replace(/^\uFEFF/, '');
    } catch {
      throw new FileInputError('تعذر قراءة الملف النصي. استخدم ترميز UTF-8.');
    }
  }

  const text = extracted.replace(/\r\n?/g, '\n').trim();
  if (!text) throw new FileInputError('لم يُعثر على نص قابل للبحث داخل الملف. ملفات PDF المصوّرة تحتاج OCR.');
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new FileInputError('المحتوى المستخرج يتجاوز الحد المسموح وهو مليون حرف.');
  }
  return {
    filename: path.basename(file.filename.replace(/\\/g, '/')).slice(0, 240),
    mimeType: specification.mimeType,
    sizeBytes: file.data.length,
    fileData: file.data,
    extractedText: text,
  };
}
