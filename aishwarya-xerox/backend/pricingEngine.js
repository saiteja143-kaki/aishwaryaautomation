import { config } from './config.js';

/**
 * Calculates print costs based on page count, duplex/simplex, color, paper size, and copies.
 */
export class PricingEngine {
  constructor(customRates = null) {
    this.rates = customRates || { ...config.pricing };
  }

  updateRates(newRates) {
    this.rates = { ...this.rates, ...newRates };
    return this.rates;
  }

  getRates() {
    return this.rates;
  }

  /**
   * Calculate price breakdown
   * @param {Object} options
   * @param {number} options.pageCount - Total pages in document or selected range
   * @param {string} options.colorMode - 'bw' | 'color'
   * @param {boolean} options.isDuplex - true for Back-to-Back, false for Single Sided
   * @param {string} options.paperSize - 'A4' | 'A3'
   * @param {number} options.copies - Number of copies (default 1)
   * @param {number} options.nIn1 - 1, 2, 4 pages per sheet (default 1)
   */
  calculate({
    pageCount = 1,
    colorMode = 'bw',
    isDuplex = false,
    paperSize = 'A4',
    copies = 1,
    nIn1 = 1
  }) {
    const pages = Math.max(1, parseInt(pageCount, 10) || 1);
    const numCopies = Math.max(1, parseInt(copies, 10) || 1);
    const nUp = [1, 2, 4, 8].includes(parseInt(nIn1, 10)) ? parseInt(nIn1, 10) : 1;
    const size = this.rates.paperMultipliers[paperSize] ? paperSize : 'A4';
    const mode = colorMode === 'color' ? 'color' : 'bw';

    // 1. Pages placed per sheet side
    const logicalSides = Math.ceil(pages / nUp);

    // 2. Physical sheets needed per copy
    let physicalSheets = 0;
    let costPerSet = 0;
    const sizeMultiplier = this.rates.paperMultipliers[size];

    if (isDuplex) {
      // 2 sides per sheet
      physicalSheets = Math.ceil(logicalSides / 2);
      // Cost calculation: full sheets + odd side if any
      const fullSheets = Math.floor(logicalSides / 2);
      const oddSides = logicalSides % 2;

      const sheetRate = (this.rates[mode].duplexSheet ?? this.rates[mode].duplexSheetPrice ?? 3.0) * sizeMultiplier;
      const singleRate = (this.rates[mode].single ?? 2.0) * sizeMultiplier;

      costPerSet = (fullSheets * sheetRate) + (oddSides * singleRate);
    } else {
      // 1 side per sheet
      physicalSheets = logicalSides;
      const singleRate = this.rates[mode].single * sizeMultiplier;
      costPerSet = physicalSheets * singleRate;
    }

    const subtotal = costPerSet * numCopies;
    const totalAmount = Math.round(subtotal * 100) / 100;

    return {
      pages,
      logicalSides,
      physicalSheetsPerCopy: physicalSheets,
      totalSheets: physicalSheets * numCopies,
      copies: numCopies,
      colorMode: mode,
      isDuplex,
      paperSize: size,
      nIn1: nUp,
      costPerSet: Math.round(costPerSet * 100) / 100,
      totalAmount
    };
  }
}

export const pricingEngine = new PricingEngine();
