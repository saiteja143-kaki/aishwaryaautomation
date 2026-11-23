import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

export class DocProcessor {
  /**
   * Analyze uploaded file to get metadata and page count
   * @param {Object} file - Multer file object
   */
  async analyzeFile(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    let pageCount = 1;
    let fileType = 'unknown';

    try {
      if (ext === '.pdf') {
        fileType = 'pdf';
        const fileBuffer = fs.readFileSync(file.path);
        const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        pageCount = pdfDoc.getPageCount();
      } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        fileType = 'image';
        pageCount = 1; // 1 image = 1 printed page
      } else if (['.doc', '.docx'].includes(ext)) {
        fileType = 'word';
        // For trial, estimate word document page count based on file size or default 1
        // (Production can convert via headless LibreOffice)
        const stats = fs.statSync(file.path);
        pageCount = Math.max(1, Math.ceil(stats.size / 25000));
      } else {
        fileType = 'other';
        pageCount = 1;
      }
    } catch (err) {
      console.error(`[DocProcessor] Error analyzing file ${file.originalname}:`, err.message);
      pageCount = 1; // Graceful fallback
    }

    return {
      fileName: file.originalname,
      storedName: file.filename,
      filePath: file.path,
      fileSize: file.size,
      fileType,
      pageCount
    };
  }
}

export const docProcessor = new DocProcessor();

