import mammoth from 'mammoth';

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractDocument(buffer, filename, mimetype = '') {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.docx') || mimetype.includes('wordprocessingml')) {
    const result = await mammoth.extractRawText({ buffer });
    const text = normalizeText(result.value);
    if (!text) throw new Error('The DOCX contained no extractable text.');
    return { text, method: 'docx-text' };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')) {
    const text = normalizeText(buffer.toString('utf8'));
    if (!text) throw new Error('The text document was empty.');
    return { text, method: 'plain-text' };
  }

  if (lower.endsWith('.pdf') || mimetype === 'application/pdf') {
    // Keep PDF.js out of the startup dependency graph. Its optional native canvas
    // binding is unavailable on some platforms (including Windows ARM64), while
    // the backend's non-PDF workflows can still run normally.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = normalizeText(result.text);
      if (text.length >= 120) return { text, method: 'pdf-text', pages: result.total ?? result.pages?.length };

      // Scanned-PDF fallback: render pages and OCR them. This is intentionally only a fallback
      // because OCR output must still pass AI extraction + deterministic validation + human review.
      const screenshot = await parser.getScreenshot({ scale: 1.5 });
      const ocrText = await ocrPages(screenshot.pages ?? []);
      if (ocrText.length < 40) throw new Error('This PDF appears to be scanned/image-only and OCR could not extract reliable text.');
      return { text: normalizeText(ocrText), method: 'pdf-ocr', pages: screenshot.pages?.length };
    } finally {
      await parser.destroy();
    }
  }

  throw new Error(`Unsupported document type: ${filename}`);
}

async function ocrPages(pages) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(process.env.OCR_LANG || 'eng');
  let combined = '';
  try {
    for (const page of pages) {
      const image = page.data ?? page;
      const result = await worker.recognize(image);
      combined += `\n--- PAGE ---\n${result.data.text || ''}`;
    }
  } finally {
    await worker.terminate();
  }
  return combined;
}
