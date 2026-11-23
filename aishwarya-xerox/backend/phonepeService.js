import crypto from 'crypto';
import { config } from './config.js';

export class PhonePeService {
  constructor() {
    this.merchantId = process.env.PHONEPE_MERCHANT_ID || config.phonepe.merchantId;
    this.saltKey = process.env.PHONEPE_SALT_KEY || config.phonepe.saltKey;
    this.saltIndex = process.env.PHONEPE_SALT_INDEX || config.phonepe.saltIndex;
    this.env = process.env.PHONEPE_ENV || config.phonepe.env; // 'PROD' or 'UAT'

    this.baseUrl = this.env === 'PROD' 
      ? 'https://api.phonepe.com/apis/hermes' 
      : 'https://api-preprod.phonepe.com/apis/pg-sandbox';
  }

  /**
   * Helper: Generate PhonePe SHA256 Checksum (X-VERIFY Header)
   */
  generateChecksum(payloadString, apiEndpoint) {
    const stringToHash = payloadString + apiEndpoint + this.saltKey;
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
    return `${sha256}###${this.saltIndex}`;
  }

  /**
   * Helper: Verify Incoming Webhook / Callback Checksum
   */
  verifyWebhookSignature(base64Response, xVerifyHeader) {
    if (!xVerifyHeader) return false;
    const stringToHash = base64Response + this.saltKey;
    const expectedHash = crypto.createHash('sha256').update(stringToHash).digest('hex');
    const [receivedHash, receivedIndex] = xVerifyHeader.split('###');

    return (
      expectedHash === receivedHash && 
      String(receivedIndex) === String(this.saltIndex)
    );
  }

  /**
   * Helper: Generate Native PhonePe UPI Deep-link Intent (Opens PhonePe App Directly)
   */
  generatePhonePeUpiIntent({ vpa, payeeName, amountInRupees, orderId }) {
    const amount = Number(amountInRupees).toFixed(2);
    const payee = encodeURIComponent(payeeName || 'Aishwarya Xerox');
    const note = encodeURIComponent(`Order ${orderId}`);
    
    // Standard UPI Intent with Transaction Reference
    const standardUpi = `upi://pay?pa=${vpa}&pn=${payee}&am=${amount}&tr=${orderId}&tn=${note}&cu=INR`;
    
    // Direct PhonePe App Intent
    const phonePeAppIntent = `phonepe://pay?pa=${vpa}&pn=${payee}&am=${amount}&tr=${orderId}&tn=${note}&cu=INR`;

    return {
      standardUpi,
      phonePeAppIntent
    };
  }

  /**
   * Step 1: Initiate Payment Order with PhonePe Gateway
   */
  async createPaymentOrder({
    orderId,
    amountInRupees,
    mobileNumber = '9999999999',
    returnUrl,
    callbackUrl
  }) {
    // PhonePe requires amount in PAISE (₹1 = 100 paise)
    const amountInPaise = Math.round(Number(amountInRupees) * 100);
    const sanitizedMobile = String(mobileNumber).replace(/\D/g, '').slice(-10) || '9999999999';

    // Verify if URLs are HTTPS (PhonePe requires public HTTPS endpoints)
    const isHttps = returnUrl.startsWith('https://') && callbackUrl.startsWith('https://');

    if (!isHttps) {
      console.warn(`[PhonePe] Notice: returnUrl/callbackUrl is HTTP/local IP. PhonePe PG requires public HTTPS.`);
    }

    const payload = {
      merchantId: this.merchantId,
      merchantTransactionId: orderId,
      merchantUserId: `MUID_${sanitizedMobile}`,
      amount: amountInPaise,
      redirectUrl: returnUrl,
      redirectMode: 'REDIRECT',
      callbackUrl: callbackUrl,
      mobileNumber: sanitizedMobile,
      paymentInstrument: {
        type: 'PAY_PAGE' // PhonePe standard checkout
      }
    };

    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const checksum = this.generateChecksum(base64Payload, '/pg/v1/pay');

    console.log(`[PhonePe Service] Calling PhonePe Hermes (${this.env}): /pg/v1/pay for ${orderId} (Amount: ₹${amountInRupees})`);

    try {
      const response = await fetch(`${this.baseUrl}/pg/v1/pay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum
        },
        body: JSON.stringify({ request: base64Payload })
      });

      const data = await response.json();
      console.log(`[PhonePe Service] Response Code:`, data.code, data.message);

      if (data.success && data.data?.instrumentResponse?.redirectInfo?.url) {
        return {
          success: true,
          mode: 'PG_WEB_CHECKOUT',
          redirectUrl: data.data.instrumentResponse.redirectInfo.url,
          merchantTransactionId: orderId,
          amountInPaise
        };
      } else {
        console.warn(`[PhonePe Service] Gateway returned non-success:`, data);
        return {
          success: false,
          error: data.message || 'PhonePe Gateway Error',
          code: data.code,
          details: data
        };
      }
    } catch (err) {
      console.error(`[PhonePe Service] Network or API Error:`, err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Step 2: Double-Check Order Status Directly with PhonePe Hermes API (Zero-Trust Security)
   */
  async checkPaymentStatus(merchantTransactionId) {
    const apiEndpoint = `/pg/v1/status/${this.merchantId}/${merchantTransactionId}`;
    const stringToHash = apiEndpoint + this.saltKey;
    const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
    const checksum = `${sha256}###${this.saltIndex}`;

    const response = await fetch(`${this.baseUrl}${apiEndpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': checksum,
        'X-MERCHANT-ID': this.merchantId
      }
    });

    const result = await response.json();
    return {
      isSuccess: result.success && result.code === 'PAYMENT_SUCCESS',
      code: result.code,
      message: result.message,
      amountInPaise: result.data?.amount,
      transactionId: result.data?.transactionId,
      paymentInstrument: result.data?.paymentInstrument
    };
  }
}

export const phonePeService = new PhonePeService();
