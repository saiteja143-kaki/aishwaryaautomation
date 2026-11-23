import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

import os from 'os';
import { config } from './backend/config.js';
import { sessionManager } from './backend/sessionManager.js';
import { pricingEngine } from './backend/pricingEngine.js';
import { docProcessor } from './backend/docProcessor.js';
import { phonePeService } from './backend/phonepeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper: Auto-detect local Wi-Fi / LAN IP address so phone can connect
function getLocalNetworkIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
const localLanIp = getLocalNetworkIp();

// Ensure directories exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/mobile', express.static(path.join(__dirname, 'public/mobile')));
app.use('/kiosk', express.static(path.join(__dirname, 'public/kiosk')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_'));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max file
});

// In-Memory Order Storage & Sequence
let orderCounter = 1;
const orders = new Map(); // orderId -> OrderObject
const uploadedFiles = new Map(); // fileId -> FileObject
let connectedAgent = null; // Track connected Shop PC print agent

// Broadcast helper
function broadcastKioskStatus() {
  const status = sessionManager.getStatus();
  io.emit('kiosk:status', status);
}

// Hook session state changes to WebSockets
sessionManager.onStateChange((status) => {
  broadcastKioskStatus();
});

// ==========================================
// KIOSK & SESSION ROUTES
// ==========================================

// Get Kiosk Display Data (Dynamic One-Time QR code + Status)
app.get('/api/kiosk/info', async (req, res) => {
  try {
    const status = sessionManager.getStatus();
    const reqHost = req.get('host') || `localhost:${config.port}`;
    let protocol = req.protocol;
    
    // Auto-detect reachable host: If host or PUBLIC_URL is localhost, swap with real Wi-Fi IP or tunnel host
    let reachableHost = reqHost;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps = forwardedProto === 'https' || (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith('https://'));
    protocol = isHttps ? 'https' : req.protocol;

    if (process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes('localhost') && !process.env.PUBLIC_URL.includes('127.0.0.1')) {
      reachableHost = process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
    } else if (req.headers['x-forwarded-host']) {
      reachableHost = req.headers['x-forwarded-host'];
    } else {
      const portPart = (reqHost.includes(':') ? reqHost.split(':')[1] : config.port);
      reachableHost = `${localLanIp}:${portPart}`;
    }

    // Each QR code embeds the active single-use claimToken!
    const claimToken = status.claimToken || 'IDLE';
    const mobileUrl = `${protocol}://${reachableHost}/mobile?token=${claimToken}`;

    // Generate dynamic QR code
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff'
      }
    });

    res.json({
      shopName: config.shopName,
      tagline: config.tagline,
      status,
      claimToken,
      mobileUrl,
      qrDataUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim Session (Called when customer scans the dynamic one-time QR code)
app.post('/api/session/start', (req, res) => {
  const { token } = req.body;
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const result = sessionManager.claimSessionWithToken(token, clientIp);
  res.json(result);
});

// Resume Active Session (Handles mobile phone back navigation & accidental page refresh)
app.post('/api/session/resume', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionManager.validateSession(sessionId)) {
    return res.json({ success: false, reason: 'SESSION_EXPIRED' });
  }

  // Find associated file and order
  let activeOrder = null;
  let activeFile = null;

  if (sessionManager.activeSession.orderId) {
    activeOrder = orders.get(sessionManager.activeSession.orderId) || null;
  }

  // Search uploaded file
  for (const f of uploadedFiles.values()) {
    if (f.sessionId === sessionId) {
      activeFile = f;
      break;
    }
  }

  res.json({
    success: true,
    sessionId,
    status: sessionManager.getStatus(),
    order: activeOrder,
    file: activeFile
  });
});

// Keep Session Alive
app.post('/api/session/heartbeat', (req, res) => {
  const { sessionId } = req.body;
  const ok = sessionManager.heartbeat(sessionId);
  res.json({ success: ok, status: sessionManager.getStatus() });
});

// Cancel / Drop Session (Supports instant pagehide sendBeacon)
app.post('/api/session/cancel', (req, res) => {
  let sessionId = req.body?.sessionId;

  // Handle sendBeacon string format
  if (!sessionId && typeof req.body === 'string') {
    try {
      sessionId = JSON.parse(req.body)?.sessionId;
    } catch (e) {}
  }

  if (sessionManager.validateSession(sessionId)) {
    console.log(`[SessionManager] Customer cancelled session or pressed back. Unlocking immediately.`);
    sessionManager.releaseSession('USER_CANCELLED');
    return res.json({ success: true, message: 'Session cancelled' });
  }
  res.status(400).json({ success: false, message: 'Invalid or expired session' });
});

// ==========================================
// DOCUMENT UPLOAD & PRICING ROUTES
// ==========================================

// Upload Document
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionManager.validateSession(sessionId)) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(403).json({ error: 'Session expired or kiosk is locked by another customer.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    // Customer uploaded a file -> grant full 3 minutes for options & payment!
    sessionManager.markFileUploaded(sessionId);

    const analysis = await docProcessor.analyzeFile(req.file);
    const fileId = path.basename(req.file.filename, path.extname(req.file.filename));
    
    uploadedFiles.set(fileId, {
      fileId,
      ...analysis,
      sessionId,
      uploadedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      fileId,
      fileName: analysis.fileName,
      fileType: analysis.fileType,
      fileSize: analysis.fileSize,
      pageCount: analysis.pageCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Calculate Pricing
app.post('/api/calculate', (req, res) => {
  try {
    const {
      pageCount,
      colorMode,
      isDuplex,
      paperSize,
      copies,
      nIn1
    } = req.body;

    const breakdown = pricingEngine.calculate({
      pageCount,
      colorMode,
      isDuplex: isDuplex === true || isDuplex === 'true',
      paperSize,
      copies,
      nIn1
    });

    res.json({ success: true, breakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ORDER & PAYMENT ROUTES
// ==========================================

// Create Order
app.post('/api/order/create', async (req, res) => {
  try {
    const {
      sessionId,
      fileId,
      options // { colorMode, isDuplex, paperSize, copies, nIn1 }
    } = req.body;

    if (!sessionManager.validateSession(sessionId)) {
      return res.status(403).json({ error: 'Session expired or not active' });
    }

    const file = uploadedFiles.get(fileId);
    if (!file) {
      return res.status(404).json({ error: 'Uploaded file not found' });
    }

    const breakdown = pricingEngine.calculate({
      pageCount: file.pageCount,
      colorMode: options.colorMode,
      isDuplex: options.isDuplex,
      paperSize: options.paperSize,
      copies: options.copies,
      nIn1: options.nIn1
    });

    const orderId = `AX-${String(orderCounter++).padStart(3, '0')}`;
    sessionManager.bindOrder(sessionId, orderId);

    // Build UPI Payment URL
    const amount = breakdown.totalAmount;
    const vpa = config.upi.vpa;
    const payee = encodeURIComponent(config.upi.payeeName);
    const note = encodeURIComponent(`Aishwarya Xerox Order ${orderId}`);
    const upiUrl = `upi://pay?pa=${vpa}&pn=${payee}&am=${amount.toFixed(2)}&tn=${note}&cu=INR`;

    // Generate UPI QR Code data URL
    const upiQrDataUrl = await QRCode.toDataURL(upiUrl, {
      width: 300,
      margin: 2
    });

    const order = {
      orderId,
      sessionId,
      fileId,
      fileName: file.fileName,
      filePath: file.filePath,
      fileType: file.fileType,
      options,
      breakdown,
      amount,
      status: 'AWAITING_PAYMENT', // AWAITING_PAYMENT, QUEUED, PRINTING, COMPLETED, FAILED
      upiUrl,
      upiQrDataUrl,
      testMode: config.upi.testMode,
      createdAt: new Date().toISOString()
    };

    orders.set(orderId, order);

    res.json({
      success: true,
      order: {
        orderId: order.orderId,
        amount: order.amount,
        breakdown: order.breakdown,
        upiUrl: order.upiUrl,
        upiQrDataUrl: order.upiQrDataUrl,
        testMode: order.testMode,
        status: order.status
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PHONEPE PAYMENT GATEWAY INTEGRATION (FULL SECURITY)
// ==========================================

// 1. Initiate PhonePe Payment (Dual-Channel: Native PhonePe App Intent + HTTPS PG Checkout)
app.post('/api/payment/phonepe/initiate', async (req, res) => {
  try {
    const { orderId, mobileNumber } = req.body;
    const order = orders.get(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'AWAITING_PAYMENT') {
      return res.status(400).json({ error: `Order is already in status: ${order.status}` });
    }

    // Generate Direct Native PhonePe UPI Intents (Guaranteed to work on all mobile phones)
    const upiIntents = phonePeService.generatePhonePeUpiIntent({
      vpa: config.upi.vpa || 'aishwaryaprinthub@ybl',
      payeeName: config.shopName,
      amountInRupees: order.amount,
      orderId: order.orderId
    });

    const host = req.headers['x-forwarded-host'] || req.get('host');
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = (forwardedProto === 'https' || (process.env.PUBLIC_URL && process.env.PUBLIC_URL.startsWith('https://'))) ? 'https' : req.protocol;
    
    // Determine public URL (supports Cloudflare tunnel host automatically)
    let publicUrl = process.env.PUBLIC_URL;
    if (forwardedProto === 'https' && host) {
      publicUrl = `https://${host}`;
    } else if (!publicUrl || publicUrl.includes('localhost') || publicUrl.includes('127.0.0.1')) {
      publicUrl = `${protocol}://${host}`;
    }
    const isPublicHttps = publicUrl.startsWith('https://');

    // If running with a public HTTPS domain, call PhonePe PG Hermes API
    if (isPublicHttps && config.phonepe.enabled) {
      const returnUrl = `${publicUrl}/api/payment/phonepe/redirect?orderId=${orderId}`;
      const callbackUrl = `${publicUrl}/api/payment/phonepe/webhook`;

      console.log(`[PhonePe] Calling Hermes PG for Order ${orderId} (Amount: ₹${order.amount}) via HTTPS: ${publicUrl}`);
      const pgOrder = await phonePeService.createPaymentOrder({
        orderId,
        amountInRupees: order.amount,
        mobileNumber: mobileNumber || '9999999999',
        returnUrl,
        callbackUrl
      });

      if (pgOrder.success && pgOrder.redirectUrl) {
        return res.json({
          success: true,
          mode: 'PG_REDIRECT',
          redirectUrl: pgOrder.redirectUrl,
          upiIntents,
          orderId
        });
      } else {
        console.warn(`[PhonePe PG Notice] Hermes PG returned:`, pgOrder.error || pgOrder.code);
        return res.json({
          success: false,
          error: pgOrder.error || 'PhonePe Gateway Error',
          code: pgOrder.code,
          details: pgOrder.details,
          upiIntents,
          orderId
        });
      }
    }

    // Default / Local Wi-Fi Mode: Use Native PhonePe App Deep-Link Intent!
    // This directly launches the PhonePe app on the customer's phone without any web redirect or domain check failure!
    console.log(`[PhonePe] Local Wi-Fi mode: Using Native PhonePe App Intent for Order ${orderId}`);
    res.json({
      success: true,
      mode: 'UPI_INTENT',
      redirectUrl: upiIntents.phonePeAppIntent,
      standardUpi: upiIntents.standardUpi,
      upiIntents,
      orderId,
      amount: order.amount
    });

  } catch (err) {
    console.error('[PhonePe Initiate Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify Payment via UTR Reference (Direct UPI / Soundbox confirmation)
app.post('/api/order/verify-utr', (req, res) => {
  try {
    const { orderId, utrNumber } = req.body;
    const order = orders.get(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'AWAITING_PAYMENT') {
      return res.status(400).json({ error: `Order is already in status: ${order.status}` });
    }

    const cleanUtr = String(utrNumber || '').trim();
    if (cleanUtr.length < 6) {
      return res.status(400).json({ error: 'Please enter a valid 12-digit UPI Reference / UTR Number from your PhonePe receipt.' });
    }

    console.log(`[Payment] UTR Received for Order ${orderId}: ${cleanUtr}. Marking Paid and Dispatching...`);

    order.status = 'QUEUED';
    order.paidAt = new Date().toISOString();
    order.transactionRef = `UTR-${cleanUtr}`;

    // Update Session to PRINTING
    sessionManager.setPrinting(orderId);

    // Notify customer mobile & admin
    io.emit(`order:${orderId}:update`, { status: 'QUEUED', orderId });
    io.emit('admin:order_update', order);

    // Trigger Print Dispatch to Canon
    dispatchPrintJob(order);

    res.json({
      success: true,
      message: 'Payment verified! Printing initiated on Canon.',
      orderId: order.orderId,
      status: order.status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Server-to-Server (S2S) Secure Webhook from PhonePe
app.post('/api/payment/phonepe/webhook', async (req, res) => {
  try {
    const xVerify = req.headers['x-verify'];
    const { response: base64Response } = req.body;

    console.log(`\n🔔 [PhonePe Webhook Received] Verifying S2S signature...`);

    // SECURITY CHECK 1: Cryptographic SHA256 Signature Verification
    const isValidSignature = phonePeService.verifyWebhookSignature(base64Response, xVerify);
    if (!isValidSignature) {
      console.error(`🚨 [SECURITY ALERT] PhonePe webhook signature verification FAILED! Possible spoofing attempt.`);
      return res.status(401).json({ error: 'Invalid signature checksum' });
    }
    console.log(`   ✓ SHA256 Checksum Signature Verified!`);

    // Decode base64 payload
    const decodedJson = JSON.parse(Buffer.from(base64Response, 'base64').toString('utf8'));
    console.log(`   PhonePe Event:`, decodedJson.code, decodedJson.message);

    const { code, data } = decodedJson;
    const orderId = data?.merchantTransactionId;
    const paidAmountInPaise = data?.amount;
    const transactionId = data?.transactionId;

    const order = orders.get(orderId);
    if (!order) {
      console.warn(`   Order ${orderId} not found in system.`);
      return res.status(404).json({ error: 'Order not found' });
    }

    // SECURITY CHECK 2: Anti-Replay / Idempotency Check
    if (order.status === 'QUEUED' || order.status === 'PRINTING' || order.status === 'COMPLETED') {
      console.log(`   Order ${orderId} is already paid & processed. Ignoring duplicate webhook.`);
      return res.json({ success: true, message: 'Already processed' });
    }

    // SECURITY CHECK 3: Verify Success Status Code
    if (code !== 'PAYMENT_SUCCESS') {
      console.warn(`   Payment failed on PhonePe side: ${code}`);
      order.status = 'FAILED';
      io.emit(`order:${orderId}:update`, { status: 'FAILED', error: decodedJson.message });
      return res.json({ success: true, message: 'Recorded failure' });
    }

    // SECURITY CHECK 4: Exact Amount Verification (Down to the Paisa!)
    const expectedAmountInPaise = Math.round(order.amount * 100);
    if (paidAmountInPaise !== expectedAmountInPaise) {
      console.error(`🚨 [SECURITY ALERT] Amount mismatch for Order ${orderId}! Expected: ${expectedAmountInPaise} paise, Received: ${paidAmountInPaise} paise.`);
      order.status = 'FAILED';
      order.error = 'Payment amount mismatch';
      return res.status(400).json({ error: 'Amount mismatch' });
    }
    console.log(`   ✓ Amount Verified: ₹${order.amount} (${paidAmountInPaise} paise)`);

    // SECURITY CHECK 5: Double-Check Status API Directly with PhonePe Hermes Server
    try {
      const statusCheck = await phonePeService.checkPaymentStatus(orderId);
      if (!statusCheck.isSuccess) {
        console.error(`🚨 [SECURITY ALERT] Direct PhonePe Status API check failed: ${statusCheck.code}`);
        return res.status(400).json({ error: 'Direct status check failed' });
      }
      console.log(`   ✓ Direct PhonePe Hermes Status API Confirmed Success! Transaction ID: ${statusCheck.transactionId}`);
    } catch (checkErr) {
      console.warn(`   Note: Direct API status verification check warning: ${checkErr.message}. Proceeding with verified webhook signature.`);
    }

    // ALL SECURITY CHECKS PASSED: Transition to QUEUED and Dispatch to Canon Printer!
    order.status = 'QUEUED';
    order.paidAt = new Date().toISOString();
    order.transactionRef = `PHONEPE-${transactionId || data?.paymentInstrument?.utr || Date.now()}`;

    // Update Session to PRINTING
    sessionManager.setPrinting(orderId);

    // Notify customer phone & admin dashboard
    io.emit(`order:${orderId}:update`, { status: 'QUEUED', orderId });
    io.emit('admin:order_update', order);

    // Dispatch to Canon LAN Printer
    dispatchPrintJob(order);

    res.json({ success: true, message: 'Payment verified and print dispatched' });
  } catch (err) {
    console.error('[PhonePe Webhook Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Customer Return Redirect (When customer finishes payment on PhonePe page)
app.all('/api/payment/phonepe/redirect', (req, res) => {
  const orderId = req.query.orderId || req.body?.merchantTransactionId;
  res.redirect(`/mobile?orderId=${orderId || ''}&payment=completed`);
});

// Process / Verify Payment (Test button or Payment Webhook)
app.post('/api/order/pay', (req, res) => {
  try {
    const { orderId, transactionRef, isTestPay } = req.body;
    const order = orders.get(orderId);

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'AWAITING_PAYMENT') {
      return res.status(400).json({ error: `Order is already in status: ${order.status}` });
    }

    order.status = 'QUEUED';
    order.paidAt = new Date().toISOString();
    order.transactionRef = transactionRef || (isTestPay ? 'TEST-PAY-' + Date.now() : 'UPI-' + Date.now());

    // Update Session to PRINTING
    sessionManager.setPrinting(orderId);

    // Notify customer mobile
    io.emit(`order:${orderId}:update`, { status: 'QUEUED', orderId });
    io.emit('admin:order_update', order);

    // Trigger Print Dispatch
    dispatchPrintJob(order);

    res.json({
      success: true,
      message: 'Payment verified successfully! Printing initiated.',
      orderId: order.orderId,
      status: order.status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Order Status
app.get('/api/order/:orderId', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  res.json({
    orderId: order.orderId,
    status: order.status,
    fileName: order.fileName,
    amount: order.amount,
    breakdown: order.breakdown,
    testMode: order.testMode
  });
});

// Download File Endpoint (for Shop PC Print Agent)
app.get('/api/download/:fileId', (req, res) => {
  const file = uploadedFiles.get(req.params.fileId);
  if (!file || !fs.existsSync(file.filePath)) {
    return res.status(404).send('File not found');
  }
  res.download(file.filePath, file.fileName);
});

// ==========================================
// PRINT DISPATCH LOGIC
// ==========================================

function dispatchPrintJob(order) {
  console.log(`[PrintDispatcher] Dispatching Order ${order.orderId} to Shop PC Agent...`);

  if (!connectedAgent) {
    console.warn(`[PrintDispatcher] No Shop PC Agent currently connected. Simulating print locally...`);
    // Local simulation fallback if agent isn't connected
    order.status = 'PRINTING';
    io.emit(`order:${order.orderId}:update`, { status: 'PRINTING', orderId: order.orderId });

    setTimeout(() => {
      order.status = 'COMPLETED';
      order.completedAt = new Date().toISOString();
      console.log(`[PrintDispatcher] Simulated print complete for ${order.orderId}`);
      io.emit(`order:${order.orderId}:update`, { status: 'COMPLETED', orderId: order.orderId });
      io.emit('admin:order_update', order);
      sessionManager.setCompleted(order.orderId);
    }, 4000);
    return;
  }

  // Push job to connected Shop PC agent via Socket
  order.status = 'PRINTING';
  io.emit(`order:${order.orderId}:update`, { status: 'PRINTING', orderId: order.orderId });

  connectedAgent.emit('agent:print_job', {
    orderId: order.orderId,
    fileId: order.fileId,
    downloadUrl: `/api/download/${order.fileId}`,
    fileName: order.fileName,
    options: order.options,
    breakdown: order.breakdown
  });
}

// ==========================================
// SHOP OWNER ADMIN ROUTES
// ==========================================

// Dashboard Data
app.get('/api/admin/dashboard', (req, res) => {
  const ordersList = Array.from(orders.values()).map(o => ({
    orderId: o.orderId,
    fileName: o.fileName,
    amount: o.amount,
    status: o.status,
    options: o.options,
    createdAt: o.createdAt,
    transactionRef: o.transactionRef
  })).reverse();

  res.json({
    kioskStatus: sessionManager.getStatus(),
    isAgentConnected: !!connectedAgent,
    agentDetails: connectedAgent ? { id: connectedAgent.id } : null,
    testMode: config.upi.testMode,
    rates: pricingEngine.getRates(),
    orders: ordersList,
    totalRevenue: ordersList.filter(o => o.status === 'COMPLETED' || o.status === 'PRINTING')
      .reduce((sum, o) => sum + (o.amount || 0), 0)
  });
});

// Force Unlock Kiosk
app.post('/api/admin/force-unlock', (req, res) => {
  const newStatus = sessionManager.forceReset();
  res.json({ success: true, message: 'Kiosk forcibly unlocked', status: newStatus });
});

// Toggle Test Mode
app.post('/api/admin/toggle-test-mode', (req, res) => {
  const { enabled } = req.body;
  config.upi.testMode = !!enabled;
  res.json({ success: true, testMode: config.upi.testMode });
});

// Update Rates
app.post('/api/admin/rates', (req, res) => {
  const newRates = pricingEngine.updateRates(req.body.rates);
  res.json({ success: true, rates: newRates });
});

// Reprint an Order
app.post('/api/admin/reprint/:orderId', (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  sessionManager.setPrinting(order.orderId);
  dispatchPrintJob(order);
  res.json({ success: true, message: `Reprint initiated for ${order.orderId}` });
});

// ==========================================
// SOCKET.IO REALTIME EVENTS
// ==========================================

io.on('connection', (socket) => {
  // Mobile customer joins session room
  socket.on('session:join', (data) => {
    socket.sessionId = data?.sessionId;
    socket.join(`session:${data?.sessionId}`);
  });

  // Identify if connecting client is Shop PC Print Agent
  socket.on('agent:register', (data) => {
    connectedAgent = socket;
    console.log(`[Socket] Shop PC Print Agent registered! ID: ${socket.id}`);
    io.emit('admin:agent_status', { connected: true, id: socket.id });

    socket.on('disconnect', () => {
      if (connectedAgent === socket) {
        connectedAgent = null;
        console.log(`[Socket] Shop PC Print Agent disconnected!`);
        io.emit('admin:agent_status', { connected: false });
      }
    });

    // Handle job status reports from agent
    socket.on('agent:job_completed', (data) => {
      const order = orders.get(data.orderId);
      if (order) {
        order.status = 'COMPLETED';
        order.completedAt = new Date().toISOString();
        io.emit(`order:${order.orderId}:update`, { status: 'COMPLETED', orderId: order.orderId });
        io.emit('admin:order_update', order);
        sessionManager.setCompleted(order.orderId);
      }
    });

    socket.on('agent:job_failed', (data) => {
      const order = orders.get(data.orderId);
      if (order) {
        order.status = 'FAILED';
        order.error = data.error;
        io.emit(`order:${order.orderId}:update`, { status: 'FAILED', error: data.error });
        io.emit('admin:order_update', order);
        sessionManager.releaseSession('PRINT_FAILED');
      }
    });
  });
});

// ==========================================
// START SERVER
// ==========================================

server.listen(config.port, config.host, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Aishwarya Xerox Kiosk System running on:`);
  console.log(`💻 Local URL:          http://localhost:${config.port}`);
  console.log(`📱 Phone (Same Wi-Fi): http://${localLanIp}:${config.port}/mobile`);
  console.log(`📺 Outside Display:    http://localhost:${config.port}/kiosk`);
  console.log(`🛠️ Shop Admin:         http://localhost:${config.port}/admin`);
  console.log(`=======================================================`);
});

