import 'dotenv/config';

// Configuration settings for Aishwarya Xerox Kiosk System
export const config = {
  shopName: "Aishwarya Xerox",
  tagline: "Smart Self-Service Printing",
  port: process.env.PORT || 3000,
  host: process.env.HOST || "0.0.0.0",
  publicUrl: process.env.PUBLIC_URL || "http://localhost:3000",
  
  // PhonePe Payment Gateway configuration (Use your aishwaryaprinthub credentials)
  phonepe: {
    enabled: process.env.PHONEPE_ENABLED === 'true' || true,
    env: process.env.PHONEPE_ENV || 'PROD', // 'PROD' for live payments, 'UAT' for sandbox
    clientId: process.env.PHONEPE_CLIENT_ID || 'SU2601171811561696436105',
    clientSecret: process.env.PHONEPE_CLIENT_SECRET || '',
    clientVersion: process.env.PHONEPE_CLIENT_VERSION || '1',
    merchantId: process.env.PHONEPE_MERCHANT_ID || 'SU2601171811561696436105',
    saltKey: process.env.PHONEPE_SALT_KEY || '',
    saltIndex: process.env.PHONEPE_SALT_INDEX || '1'
  },

  // UPI Payment settings
  upi: {
    vpa: process.env.UPI_VPA || "aishwaryaxerox@oksbi", // Shop UPI ID
    payeeName: "Aishwarya Xerox",
    testMode: true // When true, orders can be verified with 1-click test button
  },

  // Session lock settings (Single-customer-at-a-time for trial)
  session: {
    timeoutSeconds: 180, // 3 minutes timeout if customer abandons session
    resetDelaySeconds: 5 // Delay after print finish before unlocking kiosk
  },

  // Document retention
  retentionMinutes: 60, // Auto-delete uploaded files after 60 mins

  // Default Xerox Pricing (in INR ₹)
  pricing: {
    bw: {
      single: 2.0,       // ₹2.00 per single side A4
      duplexSheet: 3.0   // ₹3.00 per sheet (₹1.50 per side)
    },
    color: {
      single: 10.0,      // ₹10.00 per single side A4
      duplexSheet: 18.0  // ₹18.00 per sheet (₹9.00 per side)
    },
    paperMultipliers: {
      A4: 1.0,
      A3: 2.0
    }
  }
};

