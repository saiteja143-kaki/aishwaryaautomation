import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

export class SessionManager {
  constructor() {
    this.status = 'IDLE'; // 'IDLE' | 'IN_USE' | 'PRINTING' | 'COMPLETED'
    this.activeSession = null;
    this.activeClaimToken = null; // The single-use token currently displayed on the QR code
    this.usedTokens = new Set();  // Set of burned tokens to prevent re-use
    this.timeoutTimer = null;
    this.onStateChangeCallback = null;

    // Generate the initial one-time claim token
    this.generateNewClaimToken();
  }

  onStateChange(cb) {
    this.onStateChangeCallback = cb;
  }

  notifyStateChange() {
    if (typeof this.onStateChangeCallback === 'function') {
      this.onStateChangeCallback(this.getStatus());
    }
  }

  /**
   * Generates a fresh, single-use token for the outside TV screen QR code
   */
  generateNewClaimToken() {
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.activeClaimToken = {
      token: `AX-${randomSuffix}`,
      createdAt: Date.now(),
      status: 'AVAILABLE' // 'AVAILABLE' | 'CLAIMED'
    };
    return this.activeClaimToken.token;
  }

  getStatus() {
    let remainingSeconds = 0;
    if (this.activeSession && this.activeSession.expiresAt) {
      remainingSeconds = Math.max(0, Math.round((this.activeSession.expiresAt - Date.now()) / 1000));
    }

    return {
      status: this.status, // IDLE, IN_USE, PRINTING, COMPLETED
      isLocked: this.status !== 'IDLE',
      claimToken: this.status === 'IDLE' ? this.activeClaimToken?.token : null,
      sessionId: this.activeSession ? this.activeSession.sessionId : null,
      orderId: this.activeSession ? this.activeSession.orderId : null,
      remainingSeconds,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Claim session using the single-use token from the QR code
   * Once scanned, the token is BURNED and cannot be used again!
   */
  claimSessionWithToken(token, clientIp = 'unknown') {
    if (!token) {
      return {
        success: false,
        reason: 'NO_TOKEN',
        message: 'No QR token provided. Please scan the QR code displayed outside the shop.'
      };
    }

    // Check if token was already used
    if (this.usedTokens.has(token)) {
      return {
        success: false,
        reason: 'TOKEN_ALREADY_USED',
        message: 'This QR code has already been used. Please scan the fresh QR code on the shop display.'
      };
    }

    // Check if kiosk is currently busy
    if (this.status !== 'IDLE') {
      return {
        success: false,
        reason: 'KIOSK_BUSY',
        message: 'Kiosk is currently in use by another customer. Please wait.',
        status: this.getStatus()
      };
    }

    // Check if token matches the currently active token on the screen
    if (!this.activeClaimToken || this.activeClaimToken.token !== token || this.activeClaimToken.status !== 'AVAILABLE') {
      return {
        success: false,
        reason: 'TOKEN_INVALID',
        message: 'This QR code is expired. Please scan the fresh QR code on the shop display.'
      };
    }

    // BURN THE TOKEN IMMEDIATELY! It can never be used again.
    this.activeClaimToken.status = 'CLAIMED';
    this.usedTokens.add(token);

    // Limit memory size of used tokens
    if (this.usedTokens.size > 2000) {
      const first = this.usedTokens.values().next().value;
      this.usedTokens.delete(first);
    }

    // Create exclusive active session
    const sessionId = uuidv4();
    const expiresAt = Date.now() + (config.session.timeoutSeconds * 1000);

    this.status = 'IN_USE';
    this.activeSession = {
      sessionId,
      claimedToken: token,
      clientIp,
      startedAt: Date.now(),
      expiresAt: Date.now() + (config.session.timeoutSeconds * 1000), // Full 3 minutes (180s)
      hasUploaded: false,
      orderId: null
    };

    this.scheduleTimeout();
    this.notifyStateChange();

    return {
      success: true,
      sessionId,
      expiresAt: this.activeSession.expiresAt,
      timeoutSeconds: config.session.timeoutSeconds, // 180 seconds
      status: this.getStatus()
    };
  }

  /**
   * Called when customer uploads document: extends timeout to full 3 minutes
   */
  markFileUploaded(sessionId) {
    if (!this.validateSession(sessionId)) return false;
    this.activeSession.hasUploaded = true;
    this.activeSession.expiresAt = Date.now() + (config.session.timeoutSeconds * 1000); // 180s
    this.scheduleTimeout();
    this.notifyStateChange();
    return true;
  }

  /**
   * Validate if session is still active
   */
  validateSession(sessionId) {
    if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
      return false;
    }
    if (Date.now() > this.activeSession.expiresAt) {
      this.releaseSession('EXPIRED');
      return false;
    }
    return true;
  }

  heartbeat(sessionId) {
    if (!this.validateSession(sessionId)) {
      return false;
    }
    this.activeSession.expiresAt = Date.now() + (config.session.timeoutSeconds * 1000);
    this.scheduleTimeout();
    return true;
  }

  bindOrder(sessionId, orderId) {
    if (this.validateSession(sessionId)) {
      this.activeSession.orderId = orderId;
      return true;
    }
    return false;
  }

  setPrinting(orderId) {
    this.status = 'PRINTING';
    if (this.activeSession) {
      this.activeSession.orderId = orderId;
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    }
    this.notifyStateChange();
  }

  setCompleted(orderId) {
    this.status = 'COMPLETED';
    this.notifyStateChange();

    // After reset delay, unlock kiosk and generate brand new QR code!
    setTimeout(() => {
      this.releaseSession('COMPLETED');
    }, config.session.resetDelaySeconds * 1000);
  }

  /**
   * Releases session and immediately generates a NEW single-use token for the next person
   */
  releaseSession(reason = 'NORMAL') {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.status = 'IDLE';
    this.activeSession = null;

    // Generate a fresh QR token for the outside TV screen!
    this.generateNewClaimToken();

    this.notifyStateChange();
  }

  forceReset() {
    this.releaseSession('ADMIN_FORCE_RESET');
    return this.getStatus();
  }

  scheduleTimeout() {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    const delay = Math.max(1000, (this.activeSession?.expiresAt || 0) - Date.now());
    this.timeoutTimer = setTimeout(() => {
      console.log(`[SessionManager] Session timed out. Generating fresh QR token for next customer.`);
      this.releaseSession('TIMEOUT');
    }, delay);
  }
}

export const sessionManager = new SessionManager();
