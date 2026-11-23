import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

import { PricingEngine } from '../backend/pricingEngine.js';
import { SessionManager } from '../backend/sessionManager.js';
import { DocProcessor } from '../backend/docProcessor.js';
import { PhonePeService } from '../backend/phonepeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('🧪 ==========================================');
  console.log('🧪 RUNNING AISHWARYA XEROX KIOSK TEST SUITE');
  console.log('🧪 ==========================================\n');

  // TEST 1: Pricing Engine Verification
  console.log('▶ [TEST 1] Pricing Engine Math & Duplex Calculations...');
  const pricing = new PricingEngine();

  // Test 1.1: B&W Single Sided (5 pages @ ₹2 = ₹10)
  const p1 = pricing.calculate({ pageCount: 5, colorMode: 'bw', isDuplex: false, copies: 1 });
  assert.strictEqual(p1.pages, 5, 'Page count should be 5');
  assert.strictEqual(p1.totalSheets, 5, 'Single sided 5 pages should be 5 sheets');
  assert.strictEqual(p1.totalAmount, 10.0, '5 pages @ ₹2 = ₹10');
  console.log('  ✓ 5 Pages B&W Single Sided = 5 sheets, ₹10.00');

  // Test 1.2: B&W Double Sided (5 pages: 2 full sheets @ ₹3 + 1 single side @ ₹2 = ₹8)
  const p2 = pricing.calculate({ pageCount: 5, colorMode: 'bw', isDuplex: true, copies: 1 });
  assert.strictEqual(p2.physicalSheetsPerCopy, 3, '5 pages double sided must use 3 physical sheets');
  assert.strictEqual(p2.totalAmount, 8.0, '2 duplex sheets (₹6) + 1 single (₹2) = ₹8');
  console.log('  ✓ 5 Pages B&W Double Sided (Back-to-Back) = 3 sheets, ₹8.00');

  // Test 1.3: Copies Multiplier (3 copies of 4 pages B&W Duplex)
  // 4 pages duplex = 2 sheets @ ₹3 = ₹6 per set * 3 copies = ₹18
  const p3 = pricing.calculate({ pageCount: 4, colorMode: 'bw', isDuplex: true, copies: 3 });
  assert.strictEqual(p3.totalSheets, 6, '2 sheets * 3 copies = 6 sheets');
  assert.strictEqual(p3.totalAmount, 18.0, '₹6 * 3 copies = ₹18');
  console.log('  ✓ 3 Copies of 4 Pages Duplex = 6 sheets, ₹18.00');

  // Test 1.4: Color Single Sided (3 pages @ ₹10 = ₹30)
  const p4 = pricing.calculate({ pageCount: 3, colorMode: 'color', isDuplex: false, copies: 1 });
  assert.strictEqual(p4.totalAmount, 30.0, '3 pages color @ ₹10 = ₹30');
  console.log('  ✓ 3 Pages Color Single Sided = 3 sheets, ₹30.00');


  // TEST 2: Session Manager & Single-Use One-Time QR Token
  console.log('\n▶ [TEST 2] Session Manager Single-Use One-Time QR Token...');
  const sessionMgr = new SessionManager();

  // Initial state should be IDLE with a fresh token
  assert.strictEqual(sessionMgr.getStatus().status, 'IDLE');
  const token1 = sessionMgr.getStatus().claimToken;
  assert.ok(token1 && token1.startsWith('AX-'), 'Initial claimToken must exist and start with AX-');
  console.log(`  ✓ Kiosk is IDLE with initial Single-Use QR Token: ${token1}`);

  // Customer A scans and claims token1
  const resA = sessionMgr.claimSessionWithToken(token1, '192.168.1.50');
  assert.strictEqual(resA.success, true, 'Customer A must successfully claim session with token1');
  assert.strictEqual(sessionMgr.getStatus().status, 'IN_USE', 'Kiosk state must be IN_USE');
  console.log('  ✓ Customer A claimed token1 -> status changed to IN_USE');

  // Customer A or B tries to reuse token1 (e.g. reload or second scan)
  const resReuse = sessionMgr.claimSessionWithToken(token1, '192.168.1.50');
  assert.strictEqual(resReuse.success, false, 'Reusing token1 must FAIL');
  assert.strictEqual(resReuse.reason, 'TOKEN_ALREADY_USED', 'Reason must be TOKEN_ALREADY_USED');
  console.log('  ✓ Re-scan or Page Reload with token1 rejected (TOKEN_ALREADY_USED)!');

  // Request with no token
  const resNoToken = sessionMgr.claimSessionWithToken(null, '192.168.1.50');
  assert.strictEqual(resNoToken.success, false);
  assert.strictEqual(resNoToken.reason, 'NO_TOKEN');
  console.log('  ✓ Request without token rejected (NO_TOKEN)');

  // Customer A completes session
  sessionMgr.releaseSession('USER_COMPLETED');
  assert.strictEqual(sessionMgr.getStatus().status, 'IDLE', 'Kiosk must return to IDLE');
  const token2 = sessionMgr.getStatus().claimToken;
  assert.ok(token2 && token2 !== token1, 'A BRAND NEW token2 must be generated upon release');
  console.log(`  ✓ Kiosk released -> Generated brand new token2 for outside TV: ${token2}`);

  // Customer B can now claim token2
  const resB = sessionMgr.claimSessionWithToken(token2, '192.168.1.51');
  assert.strictEqual(resB.success, true, 'Customer B can claim token2');
  console.log('  ✓ Customer B successfully claimed new token2');
  sessionMgr.forceReset();


  // TEST 3: Document Processor & PDF Page Extraction
  console.log('\n▶ [TEST 3] Document Processor & Page Count Detection...');
  const docProc = new DocProcessor();

  // Create a real 3-page PDF in memory
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([595.28, 841.89]); // Page 1 A4
  pdfDoc.addPage([595.28, 841.89]); // Page 2 A4
  pdfDoc.addPage([595.28, 841.89]); // Page 3 A4
  const pdfBytes = await pdfDoc.save();

  const tempTestPdf = path.join(__dirname, 'test_sample.pdf');
  fs.writeFileSync(tempTestPdf, pdfBytes);

  const mockFile = {
    originalname: 'Sample_Lecture_Notes.pdf',
    filename: 'test_sample.pdf',
    path: tempTestPdf,
    size: pdfBytes.length
  };

  const analysis = await docProc.analyzeFile(mockFile);
  assert.strictEqual(analysis.pageCount, 3, 'PDF page count must be exactly 3');
  assert.strictEqual(analysis.fileType, 'pdf', 'File type must be detected as pdf');
  console.log(`  ✓ Sample PDF accurately parsed: ${analysis.pageCount} pages detected`);

  // Clean up test file
  if (fs.existsSync(tempTestPdf)) {
    fs.unlinkSync(tempTestPdf);
  }

  // TEST 4: PhonePe Gateway Cryptographic Signature & Webhook Security
  console.log('\n▶ [TEST 4] PhonePe Checksum & S2S Webhook Security Verification...');
  const phonePe = new PhonePeService();
  phonePe.saltKey = 'test-salt-key-999';
  phonePe.saltIndex = '1';

  const mockPayload = Buffer.from(JSON.stringify({
    success: true,
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantTransactionId: 'AX-001',
      amount: 1000 // 1000 paise = ₹10
    }
  })).toString('base64');

  // Generate genuine PhonePe signature
  const genuineSignature = phonePe.generateChecksum(mockPayload, '').replace('###1', '###1'); // base64 + saltKey
  const isValidGenuine = phonePe.verifyWebhookSignature(mockPayload, genuineSignature);
  assert.strictEqual(isValidGenuine, true, 'Genuine PhonePe signature must verify successfully');
  console.log('  ✓ Genuine PhonePe S2S Webhook Checksum Verified (Valid)!');

  // Tampered payload test (Hacker modifies amount)
  const tamperedPayload = Buffer.from(JSON.stringify({
    success: true,
    code: 'PAYMENT_SUCCESS',
    data: {
      merchantTransactionId: 'AX-001',
      amount: 100 // Hacker changed amount to ₹1
    }
  })).toString('base64');
  const isInvalidTampered = phonePe.verifyWebhookSignature(tamperedPayload, genuineSignature);
  assert.strictEqual(isInvalidTampered, false, 'Tampered payload must FAIL signature verification');
  console.log('  ✓ Tampered/Fake Webhook Blocked (Signature Mismatch)');

  // Fake signature test
  const isFakeSignature = phonePe.verifyWebhookSignature(mockPayload, 'fakehash12345###1');
  assert.strictEqual(isFakeSignature, false, 'Fake signature must be rejected');
  console.log('  ✓ Spoofed Webhook Blocked (401 Unauthorized)');

  console.log('\n==========================================');
  console.log('🎉 ALL INTEGRATION TESTS PASSED 100%!');
  console.log('==========================================');
}

runTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});

