const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { 
  initializeDatabase, 
  userOperations, 
  webhookOperations, 
  recipientOperations,
  subscriptionPlanOperations,
  otpOperations,
  settingsOperations
} = require('./db');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const csrf = require('csurf');
const crypto = require('crypto');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for rate limiter to work correctly with X-Forwarded-For header
app.set('trust proxy', 1);

// Initialize database
initializeDatabase();

// Clean up expired OTPs every 10 minutes
setInterval(() => {
  try {
    otpOperations.cleanupExpiredOTP();
    console.log('Cleaned up expired OTP codes');
  } catch (error) {
    console.error('Error cleaning up expired OTPs:', error);
  }
}, 10 * 60 * 1000);

// Clean up expired sessions every 30 minutes
setInterval(() => {
  try {
    // This would require access to all active sessions
    // For now, we'll rely on the session store's built-in cleanup
    // and manual cleanup in the registration routes
    console.log('Session cleanup check completed');
  } catch (error) {
    console.error('Error during session cleanup:', error);
  }
}, 30 * 60 * 1000);

// Get base URL for webhook URLs
const getBaseUrl = (req) => {
  // Check if request is HTTPS by examining headers or protocol
  const isHttps = req.secure || 
                 (req.headers['x-forwarded-proto'] === 'https') || 
                 (req.headers['x-forwarded-ssl'] === 'on') ||
                 (req.protocol === 'https');
  
  return `${isHttps ? 'https' : 'http'}://${req.get('host')}`;
};

// Generate CSP nonce for each request
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
      styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "cdnjs.cloudflare.com", "*.cloudflare.com"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));

// Rate limiting middleware
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per windowMs
  message: 'Too many login attempts, please try again after 15 minutes',
  standardHeaders: true,
  legacyHeaders: false,
});

// Standard middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration
const SESSION_SECRET = process.env.SESSION_SECRET || uuidv4(); // Generate random secret if not provided
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 3600000, // 1 hour
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
    sameSite: 'lax' // Protect against CSRF
  }
}));

// CSRF protection - apply to all routes except API webhook endpoints and OTP verification
const csrfProtection = csrf({ 
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
});
app.use((req, res, next) => {
  // Skip CSRF for webhook API endpoints, JSON requests, and OTP verification routes
  if (req.path.startsWith('/api/webhook/') || 
      req.is('json') ||
      req.path === '/register/verify' ||
      req.path === '/register/resend-otp') {
    next();
  } else {
    csrfProtection(req, res, next);
  }
});

// Add CSRF token to all rendered views
app.use((req, res, next) => {
  if (req.csrfToken) {
    res.locals.csrfToken = req.csrfToken();
  }
  next();
});

// Debug middleware for registration routes
app.use('/register', (req, res, next) => {
  console.log(`[DEBUG] ${req.method} ${req.path}`);
  console.log('Session ID:', req.sessionID);
  console.log('Has pending registration:', !!req.session.pendingRegistration);
  if (req.session.pendingRegistration) {
    console.log('Pending registration timestamp:', req.session.pendingRegistration.timestamp);
    console.log('Registration age (ms):', Date.now() - req.session.pendingRegistration.timestamp);
  }
  console.log('Session keys:', Object.keys(req.session));
  next();
});

// CSRF error handler
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    console.log('CSRF Error on path:', req.path, 'Method:', req.method);
    
    // Handle CSRF token errors
    if (req.path === '/register') {
      // For registration form CSRF errors, just redirect to refresh
      return res.redirect('/register');
    } else {
      // For other CSRF errors, show generic error
      res.status(403);
      res.send('Invalid CSRF token. Please refresh the page and try again.');
    }
  } else {
    next(err);
  }
});

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// WhatsApp client
let waClient = null;
let qrCodeDataURL = null;
let connectionStatus = 'disconnected';
let lastConnected = null;

// Message queue
const messageQueue = [];
let isProcessingQueue = false;

// Track message counts per recipient
const messageCountPerRecipient = {};
const lastMessageTimePerRecipient = {};
const errorCountPerRecipient = {};

// Global variable to store the last received webhook data for each webhook ID
const lastReceivedWebhooks = new Map();

// Global variable to store the structure of last received webhooks for each webhook ID
const lastReceivedWebhookStructures = new Map();

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
}

// Admin only middleware
function isAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  
  // Check if it's an API request
  if (req.originalUrl.startsWith('/api/')) {
    res.status(403).json({ success: false, message: 'Admin access required' });
  } else {
    req.session.message = {
      type: 'danger',
      text: 'Admin access required'
    };
    res.redirect('/dashboard');
  }
}

// Subscription check middleware
function checkSubscription(req, res, next) {
  // Skip for admin users
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }

  if (req.session.user) {
    const subscription = userOperations.checkUserSubscription(req.session.user.id);
    
    if (!subscription || subscription.subscription_status === 'expired') {
      // Check if it's an API request
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ 
          success: false, 
          message: 'Subscription expired. Please renew your subscription.' 
        });
      } else {
        req.session.message = {
          type: 'warning',
          text: 'Your subscription has expired. Please renew to continue using webhooks.'
        };
        return res.redirect('/subscription');
      }
    }
    
    // Update session with current subscription info
    req.session.user.subscription_status = subscription.subscription_status;
  }
  
  next();
}

// Initialize WhatsApp client
async function initWhatsApp() {
  try {
    // Create session directory if it doesn't exist
    const SESSION_DIR = path.join(__dirname, 'sessions');
    if (!fs.existsSync(SESSION_DIR)) {
      fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState('sessions');

    // Tutup klien lama jika ada
    if (waClient) {
      try {
        console.log('Closing existing system WhatsApp client');
        // Hapus event listeners sebelum mengganti klien
        if (waClient.ev) {
          waClient.ev.removeAllListeners('connection.update');
          waClient.ev.removeAllListeners('creds.update');
        }
        
        // Coba tutup koneksi dengan aman
        if (typeof waClient.end === 'function') {
          await waClient.end();
        }
      } catch (err) {
        console.log('Error closing old system client:', err);
        // Lanjutkan meskipun ada error
      }
    }

    waClient = makeWASocket({
      auth: state,
      defaultQueryTimeoutMs: undefined,
      printQRInTerminal: true,
      browser: ['WA Webhook System', 'Chrome', '1.0.0'],
      retryRequestDelayMs: 2000
    });

    // Handle connection updates
    waClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      console.log('System WhatsApp connection update:', update);

      if (qr) {
        console.log('QR Code received, scan with WhatsApp app:');
        qrCodeDataURL = await qrcode.toDataURL(qr);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('Connection closed due to:', lastDisconnect?.error, 
                   'Status code:', statusCode, 
                   'Reconnecting:', shouldReconnect);
                   
        connectionStatus = 'disconnected';
        
        if (shouldReconnect) {
          console.log('Attempting to reconnect system WhatsApp');
          // Gunakan setTimeout untuk mencegah loop reconnect yang terlalu cepat
          setTimeout(() => {
            try {
              initWhatsApp();
            } catch (err) {
              console.error('Error during system WhatsApp reconnect:', err);
            }
          }, 3000);
        } else {
          console.log('System WhatsApp logged out, not reconnecting automatically');
        }
      } else if (connection === 'open') {
        console.log('WhatsApp connection established!');
        connectionStatus = 'connected';
        lastConnected = new Date().toISOString();
        qrCodeDataURL = null;
        
        // Process any pending messages in the queue
        processQueue();
      }
    });

    // Save credentials whenever they are updated
    waClient.ev.on('creds.update', saveCreds);
    
    // Tangani error untuk mencegah crash
    waClient.ev.on('error', (err) => {
      console.error('System WhatsApp client error:', err);
    });

  } catch (error) {
    console.error('Error initializing WhatsApp:', error);
    connectionStatus = 'error';
  }
}

// Initialize user-specific WhatsApp client
async function initUserWhatsApp(userId) {
  try {
    // Create user-specific session directory if it doesn't exist
    const USER_SESSION_DIR = path.join(__dirname, 'sessions', `user_${userId}`);
    if (!fs.existsSync(USER_SESSION_DIR)) {
      fs.mkdirSync(USER_SESSION_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(USER_SESSION_DIR);

    // Store user-specific client in a map
    if (!global.userWAClients) {
      global.userWAClients = new Map();
    }
    
    // Hapus klien lama jika ada untuk mencegah duplikasi
    if (global.userWAClients.has(userId)) {
      try {
        const oldClient = global.userWAClients.get(userId);
        if (oldClient) {
          console.log(`Closing existing WhatsApp client for user ${userId}`);
          // Hapus event listeners sebelum mengganti klien
          oldClient.ev.removeAllListeners('connection.update');
          oldClient.ev.removeAllListeners('creds.update');
          oldClient.ev.removeAllListeners('error');
          
          // Coba tutup koneksi dengan aman
          if (typeof oldClient.end === 'function') {
            await oldClient.end();
          }
        }
      } catch (err) {
        console.log(`Error closing old client for user ${userId}:`, err);
        // Lanjutkan meskipun ada error
      }
    }
    
    // Hapus timeout lama jika ada
    if (global.userQRTimeouts && global.userQRTimeouts.has(userId)) {
      clearTimeout(global.userQRTimeouts.get(userId));
      global.userQRTimeouts.delete(userId);
    }
    
    const userClient = makeWASocket({
      auth: state,
      defaultQueryTimeoutMs: undefined,
      printQRInTerminal: false,
      browser: ['WA Webhook', 'Chrome', '1.0.0'],
      // Tambahkan opsi untuk menangani reconnect dengan lebih baik
      retryRequestDelayMs: 2000
    });
    
    // Store QR code for this user
    if (!global.userQRCodes) {
      global.userQRCodes = new Map();
    }
    
    // Store connection status for this user
    if (!global.userConnectionStatus) {
      global.userConnectionStatus = new Map();
    }
    global.userConnectionStatus.set(userId, 'disconnected');
    
    // Store QR timeouts
    if (!global.userQRTimeouts) {
      global.userQRTimeouts = new Map();
    }

    // Handle connection updates
    userClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log(`User ${userId} connection update:`, update);

      if (qr) {
        console.log(`User ${userId} QR Code received, scan with WhatsApp app:`);
        const userQRCodeDataURL = await qrcode.toDataURL(qr);
        global.userQRCodes.set(userId, userQRCodeDataURL);
        
        // Set timeout to kill instance if not connected within 1 minute
        const qrTimeout = setTimeout(() => {
          if (global.userConnectionStatus.get(userId) !== 'connected') {
            console.log(`QR code timeout for user ${userId}, closing WhatsApp instance`);
            
            try {
              // Hapus event listeners
              if (userClient && userClient.ev) {
                userClient.ev.removeAllListeners('connection.update');
                userClient.ev.removeAllListeners('creds.update');
                userClient.ev.removeAllListeners('error');
              }
              
              // Tutup koneksi
              if (typeof userClient.end === 'function') {
                userClient.end();
              }
              
              // Hapus dari map
              global.userWAClients.delete(userId);
              global.userQRCodes.delete(userId);
              
              // Update status
              global.userConnectionStatus.set(userId, 'timeout');
              userOperations.updateWhatsAppSessionStatus(userId, false);
              
              // Hapus file sesi jika perlu
              try {
                const USER_SESSION_DIR = path.join(__dirname, 'sessions', `user_${userId}`);
                if (fs.existsSync(USER_SESSION_DIR)) {
                  // Hapus file kunci sesi (creds.json)
                  const credsFile = path.join(USER_SESSION_DIR, 'creds.json');
                  if (fs.existsSync(credsFile)) {
                    fs.unlinkSync(credsFile);
                    console.log(`Deleted creds file for user ${userId} after timeout`);
                  }
                }
              } catch (err) {
                console.log(`Error deleting session files for user ${userId} after timeout:`, err);
              }
            } catch (err) {
              console.error(`Error during QR timeout cleanup for user ${userId}:`, err);
            }
          }
        }, 60000); // 1 menit
        
        // Simpan timeout ID
        global.userQRTimeouts.set(userId, qrTimeout);
      }

      if (connection === 'close') {
        // Periksa kode error untuk menentukan apakah perlu reconnect
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`User ${userId} connection closed due to:`, lastDisconnect?.error, 
                    'Status code:', statusCode, 
                    'Reconnecting:', shouldReconnect);
        
        global.userConnectionStatus.set(userId, 'disconnected');
        
        // Update user's WhatsApp session status in database
        userOperations.updateWhatsAppSessionStatus(userId, false);
        
        // Hapus timeout jika ada
        if (global.userQRTimeouts && global.userQRTimeouts.has(userId)) {
          clearTimeout(global.userQRTimeouts.get(userId));
          global.userQRTimeouts.delete(userId);
        }
        
        if (shouldReconnect) {
          console.log(`Attempting to reconnect for user ${userId}`);
          // Gunakan setTimeout untuk mencegah loop reconnect yang terlalu cepat
          setTimeout(() => {
            try {
              initUserWhatsApp(userId);
            } catch (err) {
              console.error(`Error during reconnect for user ${userId}:`, err);
            }
          }, 3000);
        } else {
          console.log(`User ${userId} logged out, not reconnecting`);
          // Hapus sesi jika user logout
          if (global.userWAClients) {
            global.userWAClients.delete(userId);
          }
          if (global.userQRCodes) {
            global.userQRCodes.delete(userId);
          }
        }
      } else if (connection === 'open') {
        console.log(`User ${userId} WhatsApp connection established!`);
        global.userConnectionStatus.set(userId, 'connected');
        global.userQRCodes.delete(userId); // Clear QR code when connected
        
        // Hapus timeout jika ada
        if (global.userQRTimeouts && global.userQRTimeouts.has(userId)) {
          clearTimeout(global.userQRTimeouts.get(userId));
          global.userQRTimeouts.delete(userId);
        }
        
        // Update user's WhatsApp session status in database
        userOperations.updateWhatsAppSessionStatus(userId, true);
      }
    });

    // Save credentials whenever they are updated
    userClient.ev.on('creds.update', saveCreds);
    
    // Tangani error untuk mencegah crash
    userClient.ev.on('error', (err) => {
      console.error(`WhatsApp client error for user ${userId}:`, err);
    });
    
    // Store the client in the map
    global.userWAClients.set(userId, userClient);
    
    return userClient;

  } catch (error) {
    console.error(`Error initializing WhatsApp for user ${userId}:`, error);
    global.userConnectionStatus.set(userId, 'error');
    return null;
  }
}

// Get the appropriate WhatsApp client for a user
function getWhatsAppClient(userId) {
  // If no userId provided, return system client
  if (!userId) {
    console.log('No userId provided, using system WhatsApp client');
    return waClient;
  }
  
  // Check if user has custom WhatsApp enabled and session is active
  const config = userOperations.getWhatsAppConfig(userId);
  
  console.log(`Getting WhatsApp client for user ${userId}:`, {
    hasConfig: !!config,
    customWhatsAppEnabled: config ? config.customWhatsAppEnabled : false,
    sessionActive: config ? config.sessionActive : false,
    hasUserClient: global.userWAClients && global.userWAClients.has(userId),
    systemConnected: connectionStatus === 'connected'
  });
  
  // Check actual connection status
  const isConnected = global.userConnectionStatus && 
                      global.userConnectionStatus.get(userId) === 'connected';
                      
  // If there's a mismatch between database and actual connection status, update database
  if (config && config.sessionActive !== isConnected) {
    console.log(`Updating WhatsApp session status for user ${userId} from ${config.sessionActive} to ${isConnected}`);
    userOperations.updateWhatsAppSessionStatus(userId, isConnected);
  }
  
  // Only use user's WhatsApp if:
  // 1. Custom WhatsApp is enabled in config
  // 2. User actually wants to use their own WhatsApp (not system)
  // 3. User's WhatsApp is connected
  if (config && 
      config.customWhatsAppEnabled && 
      isConnected && 
      global.userWAClients && 
      global.userWAClients.has(userId)) {
    console.log(`Using existing WhatsApp client for user ${userId}`);
    return global.userWAClients.get(userId);
  }
  
  // Return system client as fallback
  console.log(`Falling back to system WhatsApp client for user ${userId}`);
  return waClient;
}

// Function to send a message to a recipient
async function sendMessage(recipientNumber, message, userId = null) {
  console.log(`Sending message with userId: ${userId}`);
  
  // Check if user wants to use their own WhatsApp
  let useUserWhatsApp = false;
  let userClientConnected = false;
  let systemClientConnected = connectionStatus === 'connected';
  
  if (userId) {
    const config = userOperations.getWhatsAppConfig(userId);
    useUserWhatsApp = config && config.customWhatsAppEnabled;
    userClientConnected = global.userConnectionStatus && 
                         global.userConnectionStatus.get(userId) === 'connected';
  }
  
  console.log(`WhatsApp status check for sending:`, {
    userId: userId,
    useUserWhatsApp: useUserWhatsApp,
    userClientConnected: userClientConnected,
    systemClientConnected: systemClientConnected
  });
  
  // First try user's WhatsApp if enabled and connected
  if (useUserWhatsApp && userClientConnected && global.userWAClients && global.userWAClients.has(userId)) {
    try {
      const userClient = global.userWAClients.get(userId);
      console.log(`Attempting to send with user's WhatsApp client`);
      
      // Format the recipient number
      const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
        ? recipientNumber 
        : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      
      // Send the message
      await userClient.sendMessage(formattedNumber, { text: message });
      console.log(`Message sent to ${formattedNumber} using user's WhatsApp: ${message.substring(0, 50)}...`);
      return true;
    } catch (userError) {
      console.error(`Error sending with user's WhatsApp:`, userError);
      console.log(`Falling back to system WhatsApp client...`);
      // Fall back to system client
    }
  } else if (useUserWhatsApp) {
    console.log(`User has custom WhatsApp enabled but client is not connected. Falling back to system client.`);
  }
  
  // If we're here, either user client failed or is not available/enabled
  // Try system client
  if (!systemClientConnected) {
    console.error(`System WhatsApp client not connected. Cannot send message.`);
    throw new Error('WhatsApp client not connected');
  }
  
  try {
    // Format the recipient number
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    
    // Send the message using system client
    await waClient.sendMessage(formattedNumber, { text: message });
    console.log(`Message sent to ${formattedNumber} using system WhatsApp: ${message.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`Error sending message with system WhatsApp:`, error);
    throw error;
  }
}

// Function to send an image message to a recipient
async function sendImageMessage(recipientNumber, imageUrl, caption = '', userId = null) {
  console.log(`Sending image message with userId: ${userId}`);
  
  // Check if user wants to use their own WhatsApp
  let useUserWhatsApp = false;
  let userClientConnected = false;
  let systemClientConnected = connectionStatus === 'connected';
  
  if (userId) {
    const config = userOperations.getWhatsAppConfig(userId);
    useUserWhatsApp = config && config.customWhatsAppEnabled;
    userClientConnected = global.userConnectionStatus && 
                         global.userConnectionStatus.get(userId) === 'connected';
  }
  
  console.log(`WhatsApp status check for sending image:`, {
    userId: userId,
    useUserWhatsApp: useUserWhatsApp,
    userClientConnected: userClientConnected,
    systemClientConnected: systemClientConnected
  });
  
  // First try user's WhatsApp if enabled and connected
  if (useUserWhatsApp && userClientConnected && global.userWAClients && global.userWAClients.has(userId)) {
    try {
      const userClient = global.userWAClients.get(userId);
      console.log(`Attempting to send image with user's WhatsApp client`);
      
      // Format the recipient number
      const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
        ? recipientNumber 
        : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
      
      // Send the image
      await userClient.sendMessage(formattedNumber, {
        image: { url: imageUrl },
        caption: caption
      });
      
      console.log(`Image message sent to ${formattedNumber} using user's WhatsApp: ${imageUrl}`);
      return true;
    } catch (userError) {
      console.error(`Error sending image with user's WhatsApp:`, userError);
      console.log(`Falling back to system WhatsApp client...`);
      // Fall back to system client
    }
  } else if (useUserWhatsApp) {
    console.log(`User has custom WhatsApp enabled but client is not connected. Falling back to system client.`);
  }
  
  // If we're here, either user client failed or is not available/enabled
  // Try system client
  if (!systemClientConnected) {
    console.error(`System WhatsApp client not connected. Cannot send image message.`);
    throw new Error('WhatsApp client not connected');
  }
  
  try {
    // Format the recipient number
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    
    // Send the image using system client
    await waClient.sendMessage(formattedNumber, {
      image: { url: imageUrl },
      caption: caption
    });
    
    console.log(`Image message sent to ${formattedNumber} using system WhatsApp: ${imageUrl}`);
    return true;
  } catch (error) {
    console.error(`Error sending image message with system WhatsApp:`, error);
    throw error;
  }
}

// Function to add a message to the queue
function addToQueue(message) {
  console.log(`Adding message to queue:`, {
    type: message.type,
    webhookId: message.webhookId,
    userId: message.userId,
    hasText: !!message.text,
    textPreview: message.text ? message.text.substring(0, 50) + '...' : null
  });

  // Ensure userId is included in the message object
  if (!message.userId && message.webhookId) {
    // Try to get the user ID from the webhook
    const webhook = webhookOperations.getWebhookByWebhookId(message.webhookId);
    if (webhook) {
      message.userId = webhook.user_id;
      console.log(`Set userId to ${message.userId} from webhook ${message.webhookId}`);
    } else {
      console.log(`Could not find webhook with ID ${message.webhookId}`);
    }
  }
  
  messageQueue.push(message);
  console.log(`Added message to queue. Queue length: ${messageQueue.length}, userId: ${message.userId || 'none'}`);
  
  // Start processing the queue if not already processing
  if (!isProcessingQueue) {
    // Check if we should use system client or user client for connection status
    const isConnected = message.userId && 
      global.userConnectionStatus && 
      global.userConnectionStatus.get(message.userId) === 'connected';
      
    console.log(`Queue processing check:`, {
      userId: message.userId,
      hasUserConnectionStatus: !!global.userConnectionStatus,
      userConnectionStatus: message.userId && global.userConnectionStatus ? 
                           global.userConnectionStatus.get(message.userId) : 'unknown',
      isUserConnected: isConnected,
      systemConnectionStatus: connectionStatus,
      willProcessQueue: isConnected || connectionStatus === 'connected'
    });
      
    if (isConnected || connectionStatus === 'connected') {
      processQueue();
    }
  }
}

// Function to extract domain from URL
function extractDomainFromUrl(url) {
  try {
    if (!url) return null;
    
    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }
    
    const parsedUrl = new URL(url);
    return parsedUrl.hostname;
  } catch (error) {
    return null;
  }
}

// Function to get a nested value from an object using dot notation
function getNestedValue(obj, path) {
  const keys = path.split('.');
  return keys.reduce((o, key) => (o && o[key] !== undefined) ? o[key] : undefined, obj);
}

// Function to process a template with placeholders
function processTemplate(template, payload) {
  if (!template) return null;
  
  // Add current timestamp as a common variable
  const data = {
    ...payload,
    timestamp: new Date().toLocaleString()
  };
  
  // Replace all placeholders with their values
  return template.replace(/\{\{\{([^}]+)\}\}\}/g, (match, path) => {
    const value = getNestedValue(data, path.trim());
    return value !== undefined ? value : match;
  });
}

// Function to format webhook messages in a more readable way
function formatWebhookMessage(payload, sourceUrl = null, customTemplate = null, webhookName = null) {
  // If a custom template is provided and valid, use it
  if (customTemplate) {
    const processedMessage = processTemplate(customTemplate, payload);
    if (processedMessage) {
      return processedMessage;
    }
  }
  
  // Otherwise, use the default formatting
  // Start with a header based on webhook name if available
  let formattedMessage = "";
  
  if (webhookName) {
    formattedMessage = `📩 *Message from ${webhookName}*\n\n`;
  } else {
    formattedMessage = "📩 *Webhook Notification*\n\n";
  }
  
  // Add timestamp
  formattedMessage += `🕒 *Time*: ${new Date().toLocaleString()}\n\n`;
  
  // Process each key in the payload
  Object.keys(payload).forEach(key => {
    // Skip type key as it's used for message type determination
    if (key === 'type') return;
    
    // Format the value based on its type
    const value = payload[key];
    
    if (typeof value === 'object' && value !== null) {
      // Handle nested objects
      formattedMessage += `*${capitalizeFirstLetter(key)}*:\n`;
      
      if (Array.isArray(value)) {
        // Handle arrays
        value.forEach((item, index) => {
          if (typeof item === 'object' && item !== null) {
            formattedMessage += `   ${index + 1}. `;
            Object.keys(item).forEach(itemKey => {
              formattedMessage += `*${capitalizeFirstLetter(itemKey)}*: ${item[itemKey]}, `;
            });
            formattedMessage = formattedMessage.slice(0, -2); // Remove trailing comma and space
            formattedMessage += '\n';
          } else {
            formattedMessage += `   ${index + 1}. ${item}\n`;
          }
        });
      } else {
        // Handle regular objects
        Object.keys(value).forEach(subKey => {
          const subValue = value[subKey];
          if (typeof subValue === 'object' && subValue !== null) {
            formattedMessage += `   *${capitalizeFirstLetter(subKey)}*: ${JSON.stringify(subValue)}\n`;
          } else {
            formattedMessage += `   *${capitalizeFirstLetter(subKey)}*: ${subValue}\n`;
          }
        });
      }
      
      formattedMessage += '\n';
    } else {
      // Handle simple values
      formattedMessage += `*${capitalizeFirstLetter(key)}*: ${value}\n`;
    }
  });
  
  return formattedMessage;
}

// Helper function to capitalize the first letter of a string
function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

// Function to process the message queue
async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) {
    console.log(`Queue processing skipped: isProcessing=${isProcessingQueue}, queueLength=${messageQueue.length}`);
    return;
  }

  isProcessingQueue = true;
  console.log(`Processing message queue. ${messageQueue.length} messages in queue.`);

  try {
    while (messageQueue.length > 0) {
      const message = messageQueue.shift();
      console.log(`Processing message:`, { 
        type: message.type, 
        webhookId: message.webhookId, 
        userId: message.userId, 
        hasText: !!message.text,
        textPreview: message.text ? message.text.substring(0, 50) + '...' : null
      });
      
      // Double check that userId is set correctly
      if (!message.userId && message.webhookId) {
        const webhook = webhookOperations.getWebhookByWebhookId(message.webhookId);
        if (webhook) {
          message.userId = webhook.user_id;
          console.log(`Updated userId for message to ${message.userId} from webhook`);
        }
      }
      
      // Check if system WhatsApp is connected (we'll always try to fall back to it)
      const systemConnected = connectionStatus === 'connected';
      
      // Check if user's WhatsApp is connected (we'll try this first if enabled)
      const userConnected = message.userId && 
                           global.userConnectionStatus && 
                           global.userConnectionStatus.get(message.userId) === 'connected';
      
      // Check if user has custom WhatsApp enabled
      let useUserWhatsApp = false;
      if (message.userId) {
        const config = userOperations.getWhatsAppConfig(message.userId);
        useUserWhatsApp = config && config.customWhatsAppEnabled;
      }
      
      console.log(`Queue processing status check:`, {
        userId: message.userId,
        useUserWhatsApp: useUserWhatsApp,
        userConnected: userConnected,
        systemConnected: systemConnected
      });
      
      // Skip if system WhatsApp is not connected (we need it as fallback)
      if (!systemConnected) {
        console.log(`Skipping message: System WhatsApp not connected. Putting message back in queue.`);
        // Put the message back in the queue for later processing
        messageQueue.unshift(message);
        break;
      }
      
      // Get recipients based on webhook ID if provided, otherwise use all active recipients
      let recipients = [];
      if (message.webhookId) {
        console.log(`Looking for recipients with webhook ID: ${message.webhookId} (type: ${typeof message.webhookId})`);
        recipients = recipientOperations.getRecipientsByWebhookId(message.webhookId).filter(r => r.active);
        console.log(`Found ${recipients.length} active recipients for webhook ${message.webhookId}`);
      } else {
        // For backward compatibility and admin test messages - get all recipients
        recipients = [];
        console.log('No webhookId provided, no recipients will be processed');
      }
      
      // Reset message counts every hour
      const currentHour = new Date().getHours();
      if (!global.lastResetHour || global.lastResetHour !== currentHour) {
        console.log('Resetting message counts for all recipients');
        for (const key in messageCountPerRecipient) {
          messageCountPerRecipient[key] = 0;
        }
        global.lastResetHour = currentHour;
      }
      
      for (const recipient of recipients) {
        const phoneNumber = recipient.phone_number;
        console.log(`Processing recipient: ${recipient.name} (${phoneNumber})`);
        
        // Initialize tracking for this recipient if not exists
        if (!messageCountPerRecipient[phoneNumber]) {
          messageCountPerRecipient[phoneNumber] = 0;
        }
        if (!errorCountPerRecipient[phoneNumber]) {
          errorCountPerRecipient[phoneNumber] = 0;
        }
        
        // Check if we've sent too many messages to this recipient recently (limit: configurable per hour)
        const messageRateLimit = settingsOperations.getSettingAsNumber('message_rate_limit', 20);
        if (messageCountPerRecipient[phoneNumber] >= messageRateLimit) {
          console.log(`Skipping message to ${phoneNumber}: Rate limit reached (${messageCountPerRecipient[phoneNumber]}/${messageRateLimit} messages this hour)`);
          continue;
        }
        
        // Check if we need to wait before sending to this recipient
        const now = Date.now();
        const lastMessageTime = lastMessageTimePerRecipient[phoneNumber] || 0;
        
        // Calculate delay based on error count (exponential backoff)
        let baseDelay = 2000; // 2 seconds base delay (increased from 1 second)
        if (errorCountPerRecipient[phoneNumber] > 0) {
          // Apply exponential backoff: 2s, 4s, 8s, 16s, etc.
          baseDelay = baseDelay * Math.pow(2, Math.min(errorCountPerRecipient[phoneNumber], 5));
          console.log(`Applied exponential backoff for ${phoneNumber}: ${baseDelay}ms delay due to ${errorCountPerRecipient[phoneNumber]} errors`);
        }
        
        // Add random variation (±30%) to make the pattern more natural
        const variation = baseDelay * (0.7 + Math.random() * 0.6); // 70% to 130% of base delay
        const requiredDelay = Math.round(variation);
        
        const timeElapsed = now - lastMessageTime;
        if (lastMessageTime > 0 && timeElapsed < requiredDelay) {
          const waitTime = requiredDelay - timeElapsed;
          console.log(`Waiting ${waitTime}ms before sending next message to ${phoneNumber}`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
                  try {
            console.log(`Sending message to ${phoneNumber} for webhook ${message.webhookId} (userId: ${message.userId})...`);
            if (message.type === 'image') {
              await sendImageMessage(phoneNumber, message.imageUrl, message.caption || '', message.userId);
            } else {
              await sendMessage(phoneNumber, message.text, message.userId);
            }
            
            console.log(`✅ Message sent successfully to ${phoneNumber}`);
            
            // Update tracking
            messageCountPerRecipient[phoneNumber]++;
            lastMessageTimePerRecipient[phoneNumber] = Date.now();
            
            // Reset error count on success
            errorCountPerRecipient[phoneNumber] = 0;
            
          } catch (error) {
            console.error(`❌ Error sending message to ${phoneNumber}:`, error);
            
            // Increment error count for this recipient
            errorCountPerRecipient[phoneNumber]++;
            
            // Continue with next recipient even if one fails
          }
      }
      
      // Add a delay between processing different messages in the queue
      await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1000)); // 1.5-2.5s delay
    }
  } catch (error) {
    console.error('Error processing queue:', error);
  } finally {
    isProcessingQueue = false;
    console.log(`Queue processing finished. Remaining messages: ${messageQueue.length}`);
    
    // If there are still messages in the queue, continue processing after a delay
    if (messageQueue.length > 0) {
      setTimeout(processQueue, 2000 + Math.random() * 2000); // 2-4s delay before next batch
    }
  }
}

// Helper function to create a toast response for API endpoints
function createToastResponse(success, message, data = {}) {
  return {
    success,
    message,
    toast: {
      type: success ? 'success' : 'danger',
      text: message
    },
    ...data
  };
}

// Routes
// Login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  
  // Check for success message from query parameters (e.g., after account deletion)
  const message = req.query.message;
  res.render('login', { 
    error: null,
    success: message || null,
    csrfToken: req.csrfToken()
  });
});

// Login process with rate limiting
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  
  try {
    // Input validation
    if (!username || !password) {
      return res.render('login', { 
        error: 'Username and password are required', 
        csrfToken: req.csrfToken() 
      });
    }
    
    const user = userOperations.getUserByUsername(username);
    
    // Verify password using the new secure method
    const isValidPassword = user ? await userOperations.verifyPassword(user, password) : false;
    
    if (user && isValidPassword) {
      // Reset failed login attempts if tracking them
      
      // Set session data
      req.session.user = {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      };
      
      // Set last login time if needed
      // userOperations.updateLastLogin(user.id);
      
      res.redirect('/dashboard');
    } else {
      // Increment failed login attempts if tracking them
      
      // Generic error message (don't specify if username or password is incorrect)
      res.render('login', { 
        error: 'Invalid credentials', 
        csrfToken: req.csrfToken() 
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { 
      error: 'An error occurred during login', 
      csrfToken: req.csrfToken() 
    });
  }
});

// Helper function to send OTP via WhatsApp
async function sendOTPViaWhatsApp(phoneNumber, otpCode) {
  try {
    const message = `Your verification code is: ${otpCode}\n\nThis code will expire in 5 minutes. Do not share this code with anyone.`;
    await sendMessage(phoneNumber, message);
    return true;
  } catch (error) {
    console.error('Error sending OTP via WhatsApp:', error);
    return false;
  }
}

// Registration page
app.get('/register', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  
  // Get error message from session (if any)
  const errorMessage = req.session.registrationError;
  
  // Clear any pending registration data when accessing the registration page
  if (req.session.pendingRegistration) {
    delete req.session.pendingRegistration;
  }
  
  // Clear error message from session
  if (req.session.registrationError) {
    delete req.session.registrationError;
  }
  
  res.render('register', { 
    error: errorMessage || null, 
    step: 'register',
    phoneNumber: null,
    csrfToken: req.csrfToken()
  });
});

// Route to go back to registration (clears session)
app.get('/register/back', (req, res) => {
  // Clear pending registration data
  if (req.session.pendingRegistration) {
    delete req.session.pendingRegistration;
  }
  res.redirect('/register');
});

// Route to handle lost session during OTP verification
app.get('/register/session-lost', (req, res) => {
  // Clear any remaining registration data
  if (req.session.pendingRegistration) {
    delete req.session.pendingRegistration;
  }
  
  req.session.registrationError = 'Your session has expired during OTP verification. Please register again.';
  res.redirect('/register');
});

// Fallback OTP verification route without CSRF (for emergency cases)
app.post('/register/verify-fallback', async (req, res) => {
  const { otpCode, phoneNumber } = req.body;
  
  console.log('Fallback OTP verification attempt for phone:', phoneNumber);
  
  try {
    if (!otpCode || !phoneNumber) {
      return res.json({ 
        success: false, 
        message: 'OTP code and phone number are required' 
      });
    }
    
    // Verify OTP directly
    const isValidOTP = otpOperations.verifyOTP(phoneNumber, otpCode, 'register');
    
    if (!isValidOTP) {
      return res.json({ 
        success: false, 
        message: 'Invalid or expired OTP code' 
      });
    }
    
    // Find pending registration by phone number (as fallback)
    // This is a fallback mechanism when session is lost
    return res.json({ 
      success: false, 
      message: 'OTP is valid but session is lost. Please register again.',
      action: 'restart'
    });
    
  } catch (error) {
    console.error('Fallback OTP verification error:', error);
    return res.json({ 
      success: false, 
      message: 'Verification failed. Please try again.' 
    });
  }
});

// Resend OTP route
app.post('/register/resend-otp', async (req, res) => {
  try {
    // Session-based security: Check if there's a valid pending registration
    if (!req.session.pendingRegistration) {
      req.session.registrationError = 'No registration session found. Please start registration again.';
      return res.redirect('/register');
    }

    const { phoneNumber, timestamp } = req.session.pendingRegistration;
    
    // Check if pending registration is expired (older than 10 minutes)
    const now = Date.now();
    const registrationAge = now - timestamp;
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    if (registrationAge > maxAge) {
      // Clear expired pending registration
      delete req.session.pendingRegistration;
      
      // Set error message in session and redirect
      req.session.registrationError = 'Registration session expired. Please register again.';
      return res.redirect('/register');
    }
    
    // Rate limiting: Check if user is trying to resend too frequently
    if (!req.session.lastResendTime) {
      req.session.lastResendTime = now;
    } else {
      const timeSinceLastResend = now - req.session.lastResendTime;
      if (timeSinceLastResend < 30000) { // 30 seconds minimum between resends
        const waitTime = Math.ceil((30000 - timeSinceLastResend) / 1000);
        return res.render('register', {
          error: `Please wait ${waitTime} seconds before requesting a new OTP.`,
          step: 'verify',
          phoneNumber: phoneNumber,
          message: null
        });
      }
      req.session.lastResendTime = now;
    }
    
    // Generate and send new OTP
    const otpCode = otpOperations.generateOTPCode();
    otpOperations.createOTP(phoneNumber, otpCode, 'register');
    
    // Send OTP via WhatsApp
    const otpSent = await sendOTPViaWhatsApp(phoneNumber, otpCode);
    
    if (!otpSent) {
      return res.render('register', {
        error: 'Failed to send OTP. Please try again.',
        step: 'verify',
        phoneNumber: phoneNumber,
        message: null
      });
    }
    
    // Update timestamp and reset OTP fail count
    req.session.pendingRegistration.timestamp = Date.now();
    delete req.session.otpFailCount;
    
    res.render('register', {
      error: null,
      step: 'verify',
      phoneNumber: phoneNumber,
      message: 'New OTP has been sent to your WhatsApp number'
    });
    
  } catch (error) {
    console.error('Resend OTP error:', error);
    
    res.render('register', {
      error: 'Failed to resend OTP. Please try again.',
      step: 'verify',
      phoneNumber: req.session.pendingRegistration?.phoneNumber || null,
      message: null
    });
  }
});

// Registration process - Step 1: Send OTP
app.post('/register', async (req, res) => {
  const { username, phoneNumber, password, confirmPassword } = req.body;
  
  try {
    // Validate inputs
    if (!username || !phoneNumber || !password || !confirmPassword) {
      return res.render('register', { 
        error: 'All fields are required',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    if (password !== confirmPassword) {
      return res.render('register', { 
        error: 'Passwords do not match',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Stronger password validation
    const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*]).{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.render('register', { 
        error: 'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and special characters',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Username validation
    const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
    if (!usernameRegex.test(username)) {
      return res.render('register', { 
        error: 'Username must be 3-20 characters and can only contain letters, numbers, underscores and hyphens',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }

    // Validate phone number format (basic validation)
    const phoneRegex = /^(\+62|62|0)[0-9]{9,12}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.render('register', { 
        error: 'Please enter a valid Indonesian phone number',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }

    // Format phone number to international format
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '+62' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('62')) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+62')) {
      formattedPhone = '+62' + formattedPhone;
    }
    
    // Check if phone number already exists (including in pending registration)
    const existingUser = userOperations.getUserByPhoneNumber(formattedPhone);
    if (existingUser) {
      return res.render('register', { 
        error: 'Phone number already registered',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }

    // Check if username already exists (including in pending registration)
    const existingUsername = userOperations.getUserByUsername(username);
    if (existingUsername) {
      return res.render('register', { 
        error: 'Username already exists',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Check if there's already a pending registration for this phone number or username
    if (req.session.pendingRegistration) {
      const pending = req.session.pendingRegistration;
      const pendingAge = Date.now() - pending.timestamp;
      const maxAge = 10 * 60 * 1000; // 10 minutes
      
      // If pending registration is still valid and matches current request
      if (pendingAge <= maxAge && 
          (pending.phoneNumber === formattedPhone || pending.username === username)) {
        return res.render('register', { 
          error: 'Registration already in progress. Please check your WhatsApp for OTP.',
          step: 'verify',
          phoneNumber: pending.phoneNumber,
          csrfToken: req.csrfToken()
        });
      } else {
        // Clear expired or mismatched pending registration
        delete req.session.pendingRegistration;
      }
    }
    
    // Generate and send OTP
    const otpCode = otpOperations.generateOTPCode();
    otpOperations.createOTP(formattedPhone, otpCode, 'register');
    
    // Send OTP via WhatsApp
    const otpSent = await sendOTPViaWhatsApp(formattedPhone, otpCode);
    
    if (!otpSent) {
      return res.render('register', { 
        error: 'Failed to send OTP. Please check your phone number and try again.',
        step: 'register',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Store registration data in session temporarily
    req.session.pendingRegistration = {
      username,
      phoneNumber: formattedPhone,
      password,
      timestamp: Date.now() // Add timestamp for expiration check
    };
    
    res.render('register', { 
      error: null,
      step: 'verify',
      phoneNumber: formattedPhone,
      message: 'OTP has been sent to your WhatsApp number'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.render('register', { 
      error: error.message,
      step: 'register',
      phoneNumber: null,
      csrfToken: req.csrfToken()
    });
  }
});

// Registration process - Step 2: Verify OTP
app.post('/register/verify', async (req, res) => {
  const { otpCode } = req.body;
  
  try {
    console.log('OTP verification attempt. Session pending registration:', !!req.session.pendingRegistration);
    
    // Session-based security: Check if there's a valid pending registration
    if (!req.session.pendingRegistration) {
      console.log('No pending registration found, redirecting to register');
      req.session.registrationError = 'No registration session found. Please start registration again.';
      return res.redirect('/register');
    }

    const { username, phoneNumber, password, timestamp } = req.session.pendingRegistration;
    console.log('Pending registration found for phone:', phoneNumber);
    
    // Additional security: Check request timing (prevent rapid-fire attempts)
    if (!req.session.lastOtpAttempt) {
      req.session.lastOtpAttempt = Date.now();
    } else {
      const timeSinceLastAttempt = Date.now() - req.session.lastOtpAttempt;
      if (timeSinceLastAttempt < 3000) { // 3 seconds minimum between attempts
        return res.render('register', {
          error: 'Please wait a moment before trying again.',
          step: 'verify',
          phoneNumber: phoneNumber,
          message: null
        });
      }
      req.session.lastOtpAttempt = Date.now();
    }
    
    // Check if pending registration is expired (older than 10 minutes)
    const now = Date.now();
    const registrationAge = now - timestamp;
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    if (registrationAge > maxAge) {
      console.log('Pending registration expired, age:', registrationAge, 'ms');
      // Clear expired pending registration
      delete req.session.pendingRegistration;
      delete req.session.lastOtpAttempt;
      
      // Set error message in session and redirect
      req.session.registrationError = 'Registration session expired. Please register again.';
      return res.redirect('/register');
    }
    
    // Additional security: Validate OTP format
    if (!otpCode || !/^\d{6}$/.test(otpCode)) {
      return res.render('register', {
        error: 'Please enter a valid 6-digit OTP code.',
        step: 'verify',
        phoneNumber: phoneNumber,
        message: null
      });
    }
    
    // Verify OTP
    console.log('Verifying OTP for phone:', phoneNumber);
    const isValidOTP = otpOperations.verifyOTP(phoneNumber, otpCode, 'register');
    
    if (!isValidOTP) {
      console.log('Invalid OTP provided');
      
      // Count failed attempts
      if (!req.session.otpFailCount) {
        req.session.otpFailCount = 1;
      } else {
        req.session.otpFailCount++;
      }
      
      // After 3 failed attempts, clear session
      if (req.session.otpFailCount >= 3) {
        console.log('Too many failed OTP attempts, clearing session');
        delete req.session.pendingRegistration;
        delete req.session.lastOtpAttempt;
        delete req.session.otpFailCount;
        
        req.session.registrationError = 'Too many failed attempts. Please register again.';
        return res.redirect('/register');
      }
      
      return res.render('register', {
        error: `Invalid OTP code. ${3 - req.session.otpFailCount} attempts remaining.`,
        step: 'verify',
        phoneNumber: phoneNumber,
        message: null
      });
    }
    
    console.log('OTP verified successfully, creating user');
    // Create user (await the async function)
    const userId = await userOperations.createUser(username, password, phoneNumber);
    console.log('User created with ID:', userId);
    
    // Mark phone as verified
    userOperations.verifyPhone(userId);
    
    // Clear all session data related to registration
    delete req.session.pendingRegistration;
    delete req.session.lastOtpAttempt;
    delete req.session.otpFailCount;
    
    req.session.user = {
      id: userId,
      username: username,
      phoneNumber: phoneNumber,
      role: 'user'
    };
    
    console.log('Registration completed successfully');
    res.redirect('/dashboard');
  } catch (error) {
    console.error('OTP verification error:', error);
    
    // Clear all registration session data on any error
    delete req.session.pendingRegistration;
    delete req.session.lastOtpAttempt;
    delete req.session.otpFailCount;
    
    // Set error message in session and redirect
    req.session.registrationError = 'Registration failed. Please try again.';
    res.redirect('/register');
  }
});

// Forgot Password page
app.get('/forgot-password', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('forgot-password', { 
    error: null, 
    step: 'phone',
    phoneNumber: null,
    csrfToken: req.csrfToken()
  });
});

// Forgot Password - Step 1: Send OTP
app.post('/forgot-password', async (req, res) => {
  const { phoneNumber } = req.body;
  
  try {
    if (!phoneNumber) {
      return res.render('forgot-password', { 
        error: 'Phone number is required',
        step: 'phone',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }

    // Validate phone number format
    const phoneRegex = /^(\+62|62|0)[0-9]{9,12}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.render('forgot-password', { 
        error: 'Please enter a valid Indonesian phone number',
        step: 'phone',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }

    // Format phone number
    let formattedPhone = phoneNumber;
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '+62' + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith('62')) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+62')) {
      formattedPhone = '+62' + formattedPhone;
    }
    
    // Check if phone number exists
    const existingUser = userOperations.getUserByPhoneNumber(formattedPhone);
    if (!existingUser) {
      return res.render('forgot-password', { 
        error: 'Phone number not found',
        step: 'phone',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Generate and send OTP
    const otpCode = otpOperations.generateOTPCode();
    otpOperations.createOTP(formattedPhone, otpCode, 'forgot_password');
    
    // Send OTP via WhatsApp
    const otpSent = await sendOTPViaWhatsApp(formattedPhone, otpCode);
    
    if (!otpSent) {
      return res.render('forgot-password', { 
        error: 'Failed to send OTP. Please try again.',
        step: 'phone',
        phoneNumber: null,
        csrfToken: req.csrfToken()
      });
    }
    
    // Store phone number in session
    req.session.forgotPasswordPhone = formattedPhone;
    
    res.render('forgot-password', { 
      error: null,
      step: 'verify',
      phoneNumber: formattedPhone,
      message: 'OTP has been sent to your WhatsApp number',
      csrfToken: req.csrfToken()
    });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.render('forgot-password', { 
      error: error.message,
      step: 'phone',
      phoneNumber: null,
      csrfToken: req.csrfToken()
    });
  }
});

// Forgot Password - Step 2: Verify OTP and Reset Password
app.post('/forgot-password/verify', async (req, res) => {
  const { otpCode, newPassword, confirmPassword } = req.body;
  
  try {
    if (!req.session.forgotPasswordPhone) {
      return res.redirect('/forgot-password');
    }

    const phoneNumber = req.session.forgotPasswordPhone;
    
    if (!otpCode || !newPassword || !confirmPassword) {
      return res.render('forgot-password', { 
        error: 'All fields are required',
        step: 'verify',
        phoneNumber: phoneNumber,
        csrfToken: req.csrfToken()
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render('forgot-password', { 
        error: 'Passwords do not match',
        step: 'verify',
        phoneNumber: phoneNumber,
        csrfToken: req.csrfToken()
      });
    }

    // Stronger password validation
    const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.render('forgot-password', { 
        error: 'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and special characters',
        step: 'verify',
        phoneNumber: phoneNumber,
        csrfToken: req.csrfToken()
      });
    }
    
    // Verify OTP
    const isValidOTP = otpOperations.verifyOTP(phoneNumber, otpCode, 'forgot_password');
    
    if (!isValidOTP) {
      return res.render('forgot-password', { 
        error: 'Invalid or expired OTP code',
        step: 'verify',
        phoneNumber: phoneNumber,
        csrfToken: req.csrfToken()
      });
    }
    
    // Get user and update password
    const user = userOperations.getUserByPhoneNumber(phoneNumber);
    await userOperations.updatePassword(user.id, newPassword);
    
    // Clear session
    delete req.session.forgotPasswordPhone;
    
    req.session.message = {
      type: 'success',
      text: 'Password has been reset successfully. You can now login with your new password.'
    };
    
    res.redirect('/login');
  } catch (error) {
    console.error('Password reset error:', error);
    res.render('forgot-password', { 
      error: error.message,
      step: 'verify',
      phoneNumber: req.session.forgotPasswordPhone || null,
      csrfToken: req.csrfToken()
    });
  }
});

// Logout - GET route for displaying logout confirmation
app.get('/logout', isAuthenticated, (req, res) => {
  res.render('logout-confirm', {
    user: req.session.user,
    csrfToken: req.csrfToken()
  });
});

// Logout - POST route for actual logout (protected by CSRF)
app.post('/logout', isAuthenticated, (req, res) => {
  // Destroy session
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

// Change Password page
app.get('/change-password', isAuthenticated, (req, res) => {
  res.render('change-password', {
    user: req.session.user,
    message: req.session.message,
    csrfToken: req.csrfToken()
  });
  delete req.session.message;
});

// Change Password - POST
app.post('/change-password', isAuthenticated, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  
  try {
    // Validation
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.render('change-password', {
        user: req.session.user,
        error: 'All fields are required',
        csrfToken: req.csrfToken()
      });
    }
    
    if (newPassword !== confirmPassword) {
      return res.render('change-password', {
        user: req.session.user,
        error: 'New password and confirmation password do not match',
        csrfToken: req.csrfToken()
      });
    }
    
    // Stronger password validation
    const passwordRegex = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!@#$%^&*]).{8,}$/;
    if (!passwordRegex.test(newPassword)) {
      return res.render('change-password', {
        user: req.session.user,
        error: 'Password must be at least 8 characters long and include uppercase, lowercase, numbers, and special characters',
        csrfToken: req.csrfToken()
      });
    }
    
    // Get user and verify current password
    const user = userOperations.getUserById(req.session.user.id);
    const isValidPassword = await userOperations.verifyPassword(user, currentPassword);
    
    if (!isValidPassword) {
      return res.render('change-password', {
        user: req.session.user,
        error: 'Current password is incorrect',
        csrfToken: req.csrfToken()
      });
    }
    
    // Update password
    await userOperations.updatePassword(user.id, newPassword);
    
    req.session.message = {
      type: 'success',
      text: 'Password has been changed successfully'
    };
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Change password error:', error);
    res.render('change-password', {
      user: req.session.user,
      error: 'An error occurred while changing password',
      csrfToken: req.csrfToken()
    });
  }
});

// Delete Account page
app.get('/delete-account', isAuthenticated, (req, res) => {
  // Prevent admin from deleting their own account
  if (req.session.user.role === 'admin') {
    req.session.message = {
      type: 'danger',
      text: 'Admin accounts cannot be deleted'
    };
    return res.redirect('/dashboard');
  }
  
  res.render('delete-account', {
    user: req.session.user,
    message: req.session.message
  });
  delete req.session.message;
});

// Delete Account - POST
app.post('/delete-account', isAuthenticated, async (req, res) => {
  const { password, confirmDelete } = req.body;
  
  try {
    // Prevent admin from deleting their own account
    if (req.session.user.role === 'admin') {
      req.session.message = {
        type: 'danger',
        text: 'Admin accounts cannot be deleted'
      };
      return res.redirect('/dashboard');
    }
    
    // Validation
    if (!password || !confirmDelete) {
      return res.render('delete-account', {
        user: req.session.user,
        error: 'Password and confirmation are required'
      });
    }
    
    // Verify current password using proper bcrypt comparison
    const user = userOperations.getUserById(req.session.user.id);
    if (!user) {
      return res.render('delete-account', {
        user: req.session.user,
        error: 'User not found'
      });
    }
    
    const isValidPassword = await userOperations.verifyPassword(user, password);
    if (!isValidPassword) {
      return res.render('delete-account', {
        user: req.session.user,
        error: 'Password is incorrect'
      });
    }
    
    const userId = req.session.user.id;
    
    // Clean up user's WhatsApp sessions if they exist
    if (global.userWAClients && global.userWAClients.has(userId)) {
      try {
        const userClient = global.userWAClients.get(userId);
        if (userClient) {
          // Remove event listeners
          if (userClient.ev) {
            userClient.ev.removeAllListeners('connection.update');
            userClient.ev.removeAllListeners('creds.update');
            userClient.ev.removeAllListeners('error');
          }
          
          // Logout and close connection
          if (typeof userClient.logout === 'function') {
            userClient.logout().catch(err => {
              console.log(`Error during logout for deleted user ${userId}:`, err);
            });
          }
          
          // Close connection
          if (typeof userClient.end === 'function') {
            userClient.end();
          }
        }
        
        // Clean up from global maps
        global.userWAClients.delete(userId);
        
        if (global.userQRCodes) {
          global.userQRCodes.delete(userId);
        }
        
        if (global.userConnectionStatus) {
          global.userConnectionStatus.delete(userId);
        }
        
        if (global.userQRTimeouts && global.userQRTimeouts.has(userId)) {
          clearTimeout(global.userQRTimeouts.get(userId));
          global.userQRTimeouts.delete(userId);
        }
        
        // Clean up session files
        const USER_SESSION_DIR = path.join(__dirname, 'sessions', `user_${userId}`);
        if (fs.existsSync(USER_SESSION_DIR)) {
          fs.rmSync(USER_SESSION_DIR, { recursive: true, force: true });
        }
      } catch (error) {
        console.error('Error cleaning up WhatsApp session for deleted user:', error);
        // Continue with deletion even if cleanup fails
      }
    }
    
    // Delete user from database
    userOperations.deleteUser(userId);
    
    console.log(`User account deleted: ${user.username} (ID: ${userId})`);
    
    // Destroy session and redirect to login
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session after account deletion:', err);
      }
      res.redirect('/login?message=' + encodeURIComponent('Your account has been successfully deleted.'));
    });
    
  } catch (error) {
    console.error('Delete account error:', error);
    res.render('delete-account', {
      user: req.session.user,
      error: 'An error occurred while deleting your account. Please try again.'
    });
  }
});

// WhatsApp Configuration
app.post('/whatsapp/config', isAuthenticated, (req, res) => {
  try {
    const { whatsapp_option } = req.body;
    const useCustomWhatsApp = whatsapp_option === 'custom';
    
    userOperations.updateWhatsAppConfig(req.session.user.id, useCustomWhatsApp);
    
    // Jika mengubah konfigurasi ke sistem, hapus koneksi khusus pengguna jika ada
    if (!useCustomWhatsApp) {
      const userId = req.session.user.id;
      
      // Hapus klien jika ada
      if (global.userWAClients && global.userWAClients.has(userId)) {
        try {
          const userClient = global.userWAClients.get(userId);
          if (userClient) {
            // Hapus event listeners
            if (userClient.ev) {
              userClient.ev.removeAllListeners('connection.update');
              userClient.ev.removeAllListeners('creds.update');
              userClient.ev.removeAllListeners('error');
            }
            
            // Tutup koneksi
            if (typeof userClient.end === 'function') {
              userClient.end();
            }
          }
          
          // Hapus dari map
          global.userWAClients.delete(userId);
        } catch (err) {
          console.log(`Error closing WhatsApp client for user ${userId}:`, err);
        }
      }
      
      // Hapus QR code
      if (global.userQRCodes) {
        global.userQRCodes.delete(userId);
      }
      
      // Hapus timeout
      if (global.userQRTimeouts && global.userQRTimeouts.has(userId)) {
        clearTimeout(global.userQRTimeouts.get(userId));
        global.userQRTimeouts.delete(userId);
      }
    }
    
    // Tidak perlu memulai koneksi WhatsApp di sini
    // Pengguna akan memulai koneksi secara eksplisit dengan mengklik tombol "Generate QR Code"
    
    req.session.message = {
      type: 'success',
      text: `WhatsApp configuration updated. You are now using ${useCustomWhatsApp ? 'your own' : 'the system'} WhatsApp number.`
    };
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Error updating WhatsApp configuration:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error updating WhatsApp configuration'
    };
    res.redirect('/dashboard');
  }
});

// QR Code page for user's WhatsApp
app.get('/whatsapp/qrcode', isAuthenticated, (req, res) => {
  try {
    // Check if user has custom WhatsApp enabled
    const whatsappConfig = userOperations.getWhatsAppConfig(req.session.user.id);
    if (!whatsappConfig || !whatsappConfig.customWhatsAppEnabled) {
      req.session.message = {
        type: 'warning',
        text: 'You need to enable custom WhatsApp number first'
      };
      return res.redirect('/dashboard');
    }
    
    const userId = req.session.user.id;
    
    // Get QR code for this user if it exists
    const userQRCode = global.userQRCodes && global.userQRCodes.get(userId);
    
    // Get user-specific connection status
    let userConnectionStatus = global.userConnectionStatus && global.userConnectionStatus.get(userId) || 'disconnected';
    
    // Jika tidak ada koneksi dan tidak ada QR code, jangan buat koneksi baru
    // Biarkan user menekan tombol "Generate QR Code" untuk memulai koneksi
    
    // Jika status adalah 'disconnected' tapi tidak ada QR code dan ada timeout,
    // maka status seharusnya 'timeout'
    if (userConnectionStatus === 'disconnected' && !userQRCode && 
        global.userQRTimeouts && !global.userQRTimeouts.has(userId)) {
      userConnectionStatus = 'timeout';
    }
    
    res.render('qrcode', {
      user: req.session.user,
      qrCode: userQRCode,
      connectionStatus: userConnectionStatus,
      message: req.session.message
    });
    
    delete req.session.message;
  } catch (error) {
    console.error('Error loading QR code:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error loading QR code'
    };
    res.redirect('/dashboard');
  }
});

// Logout WhatsApp session
app.post('/whatsapp/logout', isAuthenticated, (req, res) => {
  try {
    const userId = req.session.user.id;
    
    console.log(`Attempting to logout WhatsApp session for user ${userId}`);
    
    // Check if user has custom WhatsApp enabled
    const whatsappConfig = userOperations.getWhatsAppConfig(userId);
    if (!whatsappConfig || !whatsappConfig.customWhatsAppEnabled) {
      console.log(`User ${userId} does not have custom WhatsApp enabled`);
      return res.json({ success: false, message: 'Custom WhatsApp not enabled for this user' });
    }
    
    // Check if user has a WhatsApp client or has an active session
    const hasClient = global.userWAClients && global.userWAClients.has(userId);
    const isConnected = global.userConnectionStatus && 
                        global.userConnectionStatus.get(userId) === 'connected';
    
    console.log(`Logout check for user ${userId}:`, {
      hasClient: hasClient,
      connectionStatus: global.userConnectionStatus ? global.userConnectionStatus.get(userId) : 'unknown',
      isConnected: isConnected,
      sessionActive: whatsappConfig.sessionActive
    });
    
    // If we have a client, try to disconnect it
    if (hasClient) {
      const userClient = global.userWAClients.get(userId);
      
      // Logout the client safely
      if (userClient) {
        console.log(`Logging out WhatsApp session for user ${userId}`);
        
        // Remove event listeners to prevent memory leaks
        try {
          if (userClient.ev) {
            userClient.ev.removeAllListeners('connection.update');
            userClient.ev.removeAllListeners('creds.update');
            userClient.ev.removeAllListeners('error');
          }
        } catch (err) {
          console.log(`Error removing event listeners for user ${userId}:`, err);
          // Continue even if there's an error
        }
        
        // Try to logout safely
        try {
          if (typeof userClient.logout === 'function') {
            userClient.logout().catch(err => {
              console.log(`Error during logout for user ${userId}:`, err);
              // Continue even if there's an error
            });
          }
        } catch (err) {
          console.log(`Error calling logout for user ${userId}:`, err);
          // Continue even if there's an error
        }
      }
      
      // Remove client from map
      global.userWAClients.delete(userId);
    }
    
    // Always try to delete session files regardless of client status
    try {
      const USER_SESSION_DIR = path.join(__dirname, 'sessions', `user_${userId}`);
      if (fs.existsSync(USER_SESSION_DIR)) {
        // Delete session key file (creds.json)
        const credsFile = path.join(USER_SESSION_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
          fs.unlinkSync(credsFile);
          console.log(`Deleted creds file for user ${userId}`);
        }
      }
    } catch (err) {
      console.log(`Error deleting session files for user ${userId}:`, err);
      // Continue even if there's an error
    }
    
    // Clear QR code
    if (global.userQRCodes) {
      global.userQRCodes.delete(userId);
    }
    
    // Update connection status
    if (global.userConnectionStatus) {
      global.userConnectionStatus.set(userId, 'disconnected');
    }
    
    // Update database
    userOperations.updateWhatsAppSessionStatus(userId, false);
    
    return res.json({ success: true, message: 'WhatsApp session logged out successfully' });
  } catch (error) {
    console.error('Error logging out WhatsApp session:', error);
    return res.json({ success: false, message: 'Error logging out WhatsApp session' });
  }
});

// API endpoint to regenerate QR code
app.post('/api/qrcode', isAuthenticated, (req, res) => {
  try {
    const userId = req.session.user.id;
    
    console.log(`QR code generation requested for user ${userId}`);
    
    // Check if user has custom WhatsApp enabled
    const whatsappConfig = userOperations.getWhatsAppConfig(userId);
    if (!whatsappConfig || !whatsappConfig.customWhatsAppEnabled) {
      console.log(`User ${userId} does not have custom WhatsApp enabled`);
      return res.json({ success: false, message: 'Custom WhatsApp not enabled' });
    }
    
    console.log(`QR code generation check for user ${userId}:`, {
      hasClient: global.userWAClients && global.userWAClients.has(userId),
      connectionStatus: global.userConnectionStatus ? global.userConnectionStatus.get(userId) : 'unknown',
      sessionActive: whatsappConfig.sessionActive
    });
    
    // Logout existing client if any safely
    if (global.userWAClients && global.userWAClients.has(userId)) {
      const userClient = global.userWAClients.get(userId);
      
      // Remove event listeners to prevent memory leaks
      try {
        if (userClient && userClient.ev) {
          userClient.ev.removeAllListeners('connection.update');
          userClient.ev.removeAllListeners('creds.update');
          userClient.ev.removeAllListeners('error');
        }
      } catch (err) {
        console.log(`Error removing event listeners for user ${userId}:`, err);
        // Continue even if there's an error
      }
      
      // Try to end the connection
      try {
        if (userClient && typeof userClient.end === 'function') {
          userClient.end();
          console.log(`Ended existing WhatsApp connection for user ${userId}`);
        }
      } catch (err) {
        console.log(`Error ending WhatsApp connection for user ${userId}:`, err);
        // Continue even if there's an error
      }
      
      // Remove client from map
      global.userWAClients.delete(userId);
    }
    
    // Delete session files to ensure a new QR code
    try {
      const USER_SESSION_DIR = path.join(__dirname, 'sessions', `user_${userId}`);
      if (fs.existsSync(USER_SESSION_DIR)) {
        // Delete session key file (creds.json) to force a new QR code
        const credsFile = path.join(USER_SESSION_DIR, 'creds.json');
        if (fs.existsSync(credsFile)) {
          fs.unlinkSync(credsFile);
          console.log(`Deleted creds file for user ${userId} to generate new QR`);
        }
        
        // Also delete other session files that might cause issues
        const sessionFiles = fs.readdirSync(USER_SESSION_DIR);
        sessionFiles.forEach(file => {
          if (file.startsWith('session-') || file.startsWith('app-state-')) {
            try {
              fs.unlinkSync(path.join(USER_SESSION_DIR, file));
              console.log(`Deleted session file ${file} for user ${userId}`);
            } catch (err) {
              console.log(`Error deleting session file ${file} for user ${userId}:`, err);
            }
          }
        });
      } else {
        // Create user session directory if it doesn't exist
        fs.mkdirSync(USER_SESSION_DIR, { recursive: true });
        console.log(`Created session directory for user ${userId}`);
      }
    } catch (err) {
      console.log(`Error managing session files for user ${userId}:`, err);
      // Continue even if there's an error
    }
    
    // Clean up status and old QR code
    if (global.userQRCodes) {
      global.userQRCodes.delete(userId);
    }
    if (global.userConnectionStatus) {
      global.userConnectionStatus.set(userId, 'disconnected');
    }
    
    // Update database status
    userOperations.updateWhatsAppSessionStatus(userId, false);
    
    // Initialize new client with a delay to prevent race conditions
    // This is the only place where we explicitly start a new WhatsApp connection
    console.log(`Explicitly initializing WhatsApp client for user ${userId} after QR code request`);
    setTimeout(() => {
      try {
        // Initialize new client to generate QR code
        initUserWhatsApp(userId);
      } catch (error) {
        console.error(`Error initializing WhatsApp for user ${userId} after QR request:`, error);
      }
    }, 1000);
    
    res.json({ success: true, message: 'QR code generation initiated' });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.json({ success: false, message: 'Error generating QR code' });
  }
});

// API endpoint to check WhatsApp connection status
app.get('/api/status', isAuthenticated, (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Check if user has custom WhatsApp enabled
    const whatsappConfig = userOperations.getWhatsAppConfig(userId);
    
    let connectionStatusToReturn = connectionStatus;
    let qrCodeExists = false;
    let actualSessionActive = false;
    
    if (whatsappConfig && whatsappConfig.customWhatsAppEnabled) {
      // Check if user's WhatsApp client exists and is connected
      const hasUserClient = global.userWAClients && global.userWAClients.has(userId);
      const userConnStatus = global.userConnectionStatus && 
                            global.userConnectionStatus.get(userId);
      
      // Get user-specific connection status
      connectionStatusToReturn = userConnStatus || 'disconnected';
      
      // Check if QR code exists for this user
      qrCodeExists = global.userQRCodes && global.userQRCodes.has(userId) || false;
      
      // Determine actual session active status
      actualSessionActive = connectionStatusToReturn === 'connected';
      
      console.log(`Status check for user ${userId}:`, {
        customWhatsAppEnabled: whatsappConfig.customWhatsAppEnabled,
        dbSessionActive: whatsappConfig.sessionActive,
        actualSessionActive: actualSessionActive,
        hasUserClient: hasUserClient,
        connectionStatus: connectionStatusToReturn,
        qrCodeExists: qrCodeExists
      });
      
      // Update database if there's a mismatch
      if (whatsappConfig.sessionActive !== actualSessionActive) {
        console.log(`Updating WhatsApp session status for user ${userId} from ${whatsappConfig.sessionActive} to ${actualSessionActive}`);
        userOperations.updateWhatsAppSessionStatus(userId, actualSessionActive);
      }
    }
    
    res.json({ 
      success: true, 
      connectionStatus: connectionStatusToReturn,
      customWhatsAppEnabled: whatsappConfig ? whatsappConfig.customWhatsAppEnabled : false,
      sessionActive: actualSessionActive,
      qrCodeExists: qrCodeExists
    });
  } catch (error) {
    console.error('Error checking status:', error);
    res.json({ success: false, message: 'Error checking status' });
  }
});

// Dashboard
app.get('/dashboard', isAuthenticated, (req, res) => {
  try {
    if (req.session.user.role === 'admin') {
      // Admin dashboard - focus on subscription management and WhatsApp settings
      const allUsers = userOperations.getAllUsers().filter(u => u.role !== 'admin');
      const totalUsers = allUsers.length;
      const activeSubscriptions = allUsers.filter(u => u.subscription_status === 'active').length;
      const trialUsers = allUsers.filter(u => u.subscription_status === 'trial').length;
      const expiredUsers = allUsers.filter(u => u.subscription_status === 'expired').length;
      
      res.render('admin-dashboard', { 
        user: req.session.user,
        connectionStatus,
        lastConnected,
        queueLength: messageQueue.length,
        totalUsers,
        activeSubscriptions,
        trialUsers,
        expiredUsers,
        message: req.session.message
      });
    } else {
      // User dashboard - webhooks and subscription info
      const subscription = userOperations.checkUserSubscription(req.session.user.id);
      const trialInfo = userOperations.getTrialInfo(req.session.user.id);
      
      const userWebhooks = webhookOperations.getWebhooksByUserId(req.session.user.id);
      const webhooksWithRecipients = userWebhooks.map(webhook => {
        const recipients = recipientOperations.getRecipientsByWebhookId(webhook.id);
        return {
          ...webhook,
          recipientCount: recipients.length
        };
      });
      
      const totalRecipients = userWebhooks.reduce((total, webhook) => {
        return total + recipientOperations.getRecipientsByWebhookId(webhook.id).length;
      }, 0);
      
      // Get WhatsApp configuration
      const whatsappConfig = userOperations.getWhatsAppConfig(req.session.user.id);
      
      // Get user-specific connection status if using custom WhatsApp
      let userConnectionStatus = connectionStatus;
      if (whatsappConfig && whatsappConfig.customWhatsAppEnabled) {
        userConnectionStatus = global.userConnectionStatus && global.userConnectionStatus.get(req.session.user.id) || 'disconnected';
      }
      
      res.render('dashboard', { 
        user: {
          ...req.session.user,
          custom_whatsapp_enabled: whatsappConfig ? whatsappConfig.customWhatsAppEnabled : false,
          whatsapp_session_active: whatsappConfig ? whatsappConfig.sessionActive : false
        },
        subscription,
        trialInfo,
        connectionStatus: userConnectionStatus,
        lastConnected,
        webhooksCount: userWebhooks.length,
        recipientsCount: totalRecipients,
        queueLength: messageQueue.length,
        webhooks: webhooksWithRecipients,
        baseUrl: getBaseUrl(req),
        message: req.session.message
      });
    }
    delete req.session.message;
  } catch (error) {
    console.error('Dashboard error:', error);
    res.render('dashboard', { 
      user: req.session.user,
      subscription: null,
      trialInfo: null,
      connectionStatus,
      lastConnected,
      webhooksCount: 0,
      recipientsCount: 0,
      queueLength: messageQueue.length,
      webhooks: [],
      baseUrl: getBaseUrl(req),
      message: { type: 'danger', text: 'Error loading dashboard data' }
    });
  }
});

// Webhooks list
app.get('/webhooks', isAuthenticated, checkSubscription, (req, res) => {
  try {
    const userWebhooks = webhookOperations.getWebhooksByUserId(req.session.user.id);
    const webhooksWithRecipients = userWebhooks.map(webhook => {
      const recipients = recipientOperations.getRecipientsByWebhookId(webhook.id);
      return {
        ...webhook,
        recipientCount: recipients.length
      };
    });
    
    const recipientLimit = settingsOperations.getSettingAsNumber('recipient_limit', 2);
    
    res.render('webhooks', { 
      user: req.session.user,
      webhooks: webhooksWithRecipients,
      recipientLimit,
      baseUrl: getBaseUrl(req),
      message: req.session.message
    });
    delete req.session.message;
  } catch (error) {
    console.error('Webhooks list error:', error);
    res.render('webhooks', { 
      user: req.session.user,
      webhooks: [],
      recipientLimit: 2,
      baseUrl: getBaseUrl(req),
      message: { type: 'danger', text: 'Error loading webhooks' }
    });
  }
});

// New webhook form
app.get('/webhooks/new', isAuthenticated, checkSubscription, (req, res) => {
  res.render('webhook-form', { 
    user: req.session.user,
    isNew: true,
    webhook: {},
    baseUrl: getBaseUrl(req),
    error: null
  });
});

// Create new webhook
app.post('/webhooks', isAuthenticated, checkSubscription, (req, res) => {
  try {
    const { name, format_type, custom_template, is_published } = req.body;
    const isAjaxRequest = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1);
    
    // Clear any existing message to prevent double notifications
    delete req.session.message;
    
    if (!name) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Webhook name is required'));
      } else {
        return res.render('webhook-form', { 
          user: req.session.user,
          isNew: true,
          webhook: req.body,
          baseUrl: getBaseUrl(req),
          error: 'Webhook name is required'
        });
      }
    }
    
    // Generate unique webhook ID
    const webhookId = uuidv4();
    
    // Create webhook
    const newWebhookId = webhookOperations.createWebhook(
      req.session.user.id, 
      webhookId, 
      name, 
      format_type || 'formatted',
      format_type === 'custom' ? custom_template : null,
      format_type === 'custom' ? (is_published === 'on') : false
    );
    
    if (isAjaxRequest) {
      return res.json(createToastResponse(true, 'Webhook created successfully', { webhookId: newWebhookId }));
    } else {
      req.session.message = {
        type: 'success',
        text: 'Webhook created successfully'
      };
      
      res.redirect(`/webhooks/${newWebhookId}`);
    }
  } catch (error) {
    console.error('Error creating webhook:', error);
    
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
      return res.json(createToastResponse(false, `Error creating webhook: ${error.message}`));
    } else {
      res.render('webhook-form', { 
        user: req.session.user,
        isNew: true,
        webhook: req.body,
        baseUrl: getBaseUrl(req),
        error: `Error creating webhook: ${error.message}`
      });
    }
  }
});

// View webhook details
app.get('/webhooks/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    const webhook = webhookOperations.getWebhookById(id);
    
    if (!webhook || webhook.user_id !== req.session.user.id) {
      req.session.message = {
        type: 'danger',
        text: 'Webhook not found'
      };
      return res.redirect('/webhooks');
    }
    
    const recipients = recipientOperations.getRecipientsByWebhookId(webhook.id);
    const recipientLimit = settingsOperations.getSettingAsNumber('recipient_limit', 2);
    
    res.render('webhook-form', { 
      user: req.session.user,
      isNew: false,
      webhook,
      recipients,
      recipientLimit,
      baseUrl: getBaseUrl(req),
      error: null
    });
  } catch (error) {
    console.error('Error loading webhook:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error loading webhook'
    };
    res.redirect('/webhooks');
  }
});

// Edit webhook form
app.get('/webhooks/:id/edit', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    const webhook = webhookOperations.getWebhookById(id);
    
    if (!webhook || webhook.user_id !== req.session.user.id) {
      req.session.message = {
        type: 'danger',
        text: 'Webhook not found'
      };
      return res.redirect('/webhooks');
    }
    
    // Get recipients for this webhook
    const recipients = recipientOperations.getRecipientsByWebhookId(webhook.id);
    const recipientLimit = settingsOperations.getSettingAsNumber('recipient_limit', 2);
    
    res.render('webhook-form', { 
      user: req.session.user,
      isNew: false,
      webhook,
      recipients,
      recipientLimit,
      baseUrl: getBaseUrl(req),
      error: null
    });
  } catch (error) {
    console.error('Error loading webhook for edit:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error loading webhook'
    };
    res.redirect('/webhooks');
  }
});

// Update webhook
app.post('/webhooks/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    const { name, format_type, custom_template, is_published } = req.body;
    const isAjaxRequest = req.xhr || req.headers.accept && req.headers.accept.indexOf('json') > -1;
    
    // Clear any existing message to prevent double notifications
    delete req.session.message;
    
    const webhook = webhookOperations.getWebhookById(id);
    
    if (!webhook || webhook.user_id !== req.session.user.id) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Webhook not found'));
      } else {
        req.session.message = {
          type: 'danger',
          text: 'Webhook not found'
        };
        return res.redirect('/webhooks');
      }
    }
    
    if (!name) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Webhook name is required'));
      } else {
        // Get recipients for this webhook
        const recipients = recipientOperations.getRecipientsByWebhookId(webhook.id);
        const recipientLimit = settingsOperations.getSettingAsNumber('recipient_limit', 2);
        
        return res.render('webhook-form', { 
          user: req.session.user,
          isNew: false,
          webhook: { ...webhook, ...req.body },
          recipients,
          recipientLimit,
          baseUrl: getBaseUrl(req),
          error: 'Webhook name is required'
        });
      }
    }
    
    // Update webhook
    webhookOperations.updateWebhook(
      id, 
      name, 
      format_type,
      format_type === 'custom' ? custom_template : null,
      format_type === 'custom' ? (is_published === 'on') : false
    );
    
    if (isAjaxRequest) {
      return res.json(createToastResponse(true, 'Webhook updated successfully'));
    } else {
      req.session.message = {
        type: 'success',
        text: 'Webhook updated successfully'
      };
      
      res.redirect(`/webhooks/${id}`);
    }
  } catch (error) {
    console.error('Error updating webhook:', error);
    
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
      return res.json(createToastResponse(false, `Error updating webhook: ${error.message}`));
    } else {
      const webhook = webhookOperations.getWebhookById(req.params.id);
      const recipients = webhook ? recipientOperations.getRecipientsByWebhookId(webhook.id) : [];
      const recipientLimit = settingsOperations.getSettingAsNumber('recipient_limit', 2);
      
      res.render('webhook-form', { 
        user: req.session.user,
        isNew: false,
        webhook: { ...webhook, ...req.body },
        recipients,
        recipientLimit,
        baseUrl: getBaseUrl(req),
        error: `Error updating webhook: ${error.message}`
      });
    }
  }
});

// New recipient form for webhook
app.get('/webhooks/:webhookId/recipients/new', isAuthenticated, (req, res) => {
  try {
    const { webhookId } = req.params;
    const webhook = webhookOperations.getWebhookById(webhookId);
    
    if (!webhook || webhook.user_id !== req.session.user.id) {
      req.session.message = {
        type: 'danger',
        text: 'Webhook not found'
      };
      return res.redirect('/webhooks');
    }
    
    res.render('recipient-form-new', { 
      user: req.session.user,
      isNew: true,
      recipient: {},
      webhookId,
      error: null
    });
  } catch (error) {
    console.error('Error loading new recipient form:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error loading form'
    };
    res.redirect('/webhooks');
  }
});

// Create new recipient for webhook
app.post('/webhooks/:webhookId/recipients', isAuthenticated, (req, res) => {
  try {
    const { webhookId } = req.params;
    const { name, phoneNumber, active } = req.body;
    const isAjaxRequest = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1);
    
    // Clear any existing message to prevent double notifications
    delete req.session.message;
    
    const webhook = webhookOperations.getWebhookById(webhookId);
    
    if (!webhook || webhook.user_id !== req.session.user.id) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Webhook not found'));
      } else {
        req.session.message = {
          type: 'danger',
          text: 'Webhook not found'
        };
        return res.redirect('/webhooks');
      }
    }
    
    if (!name || !phoneNumber) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Name and phone number are required'));
      } else {
        return res.render('recipient-form-new', { 
          user: req.session.user,
          isNew: true,
          recipient: req.body,
          webhookId,
          error: 'Name and phone number are required'
        });
      }
    }
    
    // Create new recipient
    recipientOperations.createRecipient(webhook.id, phoneNumber, name);
    
    if (isAjaxRequest) {
      return res.json(createToastResponse(true, 'Recipient added successfully'));
    } else {
      req.session.message = {
        type: 'success',
        text: 'Recipient added successfully'
      };
      
      res.redirect(`/webhooks/${webhookId}`);
    }
  } catch (error) {
    console.error('Error creating recipient:', error);
    
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
      return res.json(createToastResponse(false, `Error creating recipient: ${error.message}`));
    } else {
      res.render('recipient-form-new', { 
        user: req.session.user,
        isNew: true,
        recipient: req.body,
        webhookId: req.params.webhookId,
        error: `Error creating recipient: ${error.message}`
      });
    }
  }
});

// Edit recipient form
app.get('/webhooks/:webhookId/recipients/:recipientId/edit', isAuthenticated, (req, res) => {
  try {
    const { webhookId, recipientId } = req.params;
    
    const webhook = webhookOperations.getWebhookById(webhookId);
    if (!webhook || webhook.user_id !== req.session.user.id) {
      req.session.message = {
        type: 'danger',
        text: 'Webhook not found'
      };
      return res.redirect('/webhooks');
    }
    
    const recipient = recipientOperations.getRecipientById(recipientId);
    if (!recipient || recipient.webhook_id !== webhook.id) {
      req.session.message = {
        type: 'danger',
        text: 'Recipient not found'
      };
      return res.redirect(`/webhooks/${webhookId}`);
    }
    
    res.render('recipient-form-new', { 
      user: req.session.user,
      isNew: false,
      recipient,
      webhookId,
      error: null
    });
  } catch (error) {
    console.error('Error loading recipient for edit:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error loading recipient'
    };
    res.redirect('/webhooks');
  }
});

// Update recipient
app.post('/webhooks/:webhookId/recipients/:recipientId', isAuthenticated, (req, res) => {
  try {
    const { webhookId, recipientId } = req.params;
    const { name, phoneNumber, active } = req.body;
    const isAjaxRequest = req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1);
    
    // Clear any existing message to prevent double notifications
    delete req.session.message;
    
    const webhook = webhookOperations.getWebhookById(webhookId);
    if (!webhook || webhook.user_id !== req.session.user.id) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Webhook not found'));
      } else {
        req.session.message = {
          type: 'danger',
          text: 'Webhook not found'
        };
        return res.redirect('/webhooks');
      }
    }
    
    const recipient = recipientOperations.getRecipientById(recipientId);
    if (!recipient || recipient.webhook_id !== webhook.id) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Recipient not found'));
      } else {
        req.session.message = {
          type: 'danger',
          text: 'Recipient not found'
        };
        return res.redirect(`/webhooks/${webhookId}`);
      }
    }
    
    if (!name || !phoneNumber) {
      if (isAjaxRequest) {
        return res.json(createToastResponse(false, 'Name and phone number are required'));
      } else {
        return res.render('recipient-form-new', { 
          user: req.session.user,
          isNew: false,
          recipient: { ...recipient, ...req.body },
          webhookId,
          error: 'Name and phone number are required'
        });
      }
    }
    
    // Update recipient
    recipientOperations.updateRecipient(recipientId, name, phoneNumber, active === 'on');
    
    if (isAjaxRequest) {
      return res.json(createToastResponse(true, 'Recipient updated successfully'));
    } else {
      req.session.message = {
        type: 'success',
        text: 'Recipient updated successfully'
      };
      
      res.redirect(`/webhooks/${webhookId}`);
    }
  } catch (error) {
    console.error('Error updating recipient:', error);
    
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
      return res.json(createToastResponse(false, `Error updating recipient: ${error.message}`));
    } else {
      res.render('recipient-form-new', { 
        user: req.session.user,
        isNew: false,
        recipient: { ...recipientOperations.getRecipientById(req.params.recipientId), ...req.body },
        webhookId: req.params.webhookId,
        error: `Error updating recipient: ${error.message}`
      });
    }
  }
});

// QR code page (admin only)
app.get('/qrcode', isAuthenticated, isAdmin, (req, res) => {
  res.render('qrcode', { 
    user: req.session.user,
    qrCode: qrCodeDataURL,
    connectionStatus,
    message: req.session.message
  });
  delete req.session.message;
});

// Generate QR code (admin only)
app.post('/api/qrcode', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Disconnect and reinitialize WhatsApp
    if (waClient) {
      waClient.end();
      waClient = null;
    }
    
    connectionStatus = 'disconnected';
    qrCodeDataURL = null;
    
    // Initialize new connection
    await initWhatsApp();
    
    res.json(createToastResponse(true, 'QR code generation initiated'));
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.json(createToastResponse(false, `Error generating QR code: ${error.message}`));
  }
});

// Get connection status
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    connectionStatus,
    lastConnected,
    queueLength: messageQueue.length
  });
});

// Disconnect WhatsApp
app.get('/disconnect', isAuthenticated, async (req, res) => {
  try {
    if (waClient) {
      waClient.end();
      waClient = null;
    }
    
    connectionStatus = 'disconnected';
    qrCodeDataURL = null;
    
    req.session.message = {
      type: 'success',
      text: 'WhatsApp disconnected successfully'
    };
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error);
    req.session.message = {
      type: 'danger',
      text: `Error disconnecting WhatsApp: ${error.message}`
    };
    res.redirect('/dashboard');
  }
});

// API endpoint to send test message
app.post('/api/send-test', isAuthenticated, checkSubscription, async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    
    if (!phoneNumber || !message) {
      return res.status(400).json(createToastResponse(false, 'Phone number and message are required'));
    }
    
    if (connectionStatus !== 'connected') {
      return res.status(400).json(createToastResponse(false, 'WhatsApp is not connected'));
    }
    
    // Send the message directly
    await sendMessage(phoneNumber, message);
    
    return res.json(createToastResponse(true, 'Test message sent successfully'));
  } catch (error) {
    console.error('Error sending test message:', error);
    return res.status(500).json(createToastResponse(false, `Error sending test message: ${error.message}`));
  }
});

// User-specific webhook endpoint
app.post('/api/webhook/:webhookId', checkSubscription, async (req, res) => {
  try {
    const { webhookId } = req.params;
    console.log('Webhook received for:', webhookId);
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json(createToastResponse(false, 'WhatsApp is not connected'));
    }
    
    // Verify webhook exists
    const webhook = webhookOperations.getWebhookByWebhookId(webhookId);
    if (!webhook) {
      return res.status(404).json(createToastResponse(false, 'Webhook not found'));
    }
    
    console.log(`Found webhook:`, {
      id: webhook.id,
      webhookId: webhook.webhook_id,
      name: webhook.name,
      userId: webhook.user_id,
      formatType: webhook.format_type
    });
    
    const payload = req.body;
    
    // Store only the structure of the received webhook data for template customization
    // This preserves privacy by not storing actual values
    lastReceivedWebhookStructures.set(webhook.id, {
      structure: extractVariableStructure(payload),
      timestamp: new Date()
    });
    
    // Extract source URL from request headers (exclude our own domain)
    let sourceUrl = req.get('origin') || req.get('referer');
    const currentHost = req.get('host');
    
    console.log('Headers analysis:', {
      origin: req.get('origin'),
      referer: req.get('referer'),
      host: currentHost,
      sourceUrl: sourceUrl
    });
    
    // Don't use Host header as it's our own server domain
    // Also filter out if the source URL is our own domain
    if (sourceUrl) {
      const sourceDomain = extractDomainFromUrl(sourceUrl);
      
      // Skip if source domain is the same as our server domain
      if (sourceDomain === currentHost || sourceDomain === req.hostname) {
        console.log(`Skipping source domain ${sourceDomain} as it matches server domain ${currentHost}`);
        sourceUrl = null;
      }
    }
    
    // Check if user has WhatsApp configured
    const userConfig = userOperations.getWhatsAppConfig(webhook.user_id);
    console.log(`User WhatsApp configuration:`, {
      userId: webhook.user_id,
      hasConfig: !!userConfig,
      customWhatsAppEnabled: userConfig ? userConfig.customWhatsAppEnabled : false,
      sessionActive: userConfig ? userConfig.sessionActive : false
    });
    
    // Check if user's WhatsApp is connected
    const userConnected = global.userConnectionStatus && 
                         global.userConnectionStatus.get(webhook.user_id) === 'connected';
    console.log(`User WhatsApp connection status: ${userConnected ? 'connected' : 'disconnected'}`);
    
    // Check if the payload contains a message type
    if (payload.type === 'image' && payload.imageUrl) {
      // Add image message to queue
      addToQueue({
        type: 'image',
        imageUrl: payload.imageUrl,
        caption: payload.caption || '',
        webhookId: webhook.id,
        userId: webhook.user_id  // Explicitly set userId
      });
    } else {
      // Format the message based on the payload structure in a more readable way
      let messageText = '';
      
      if (typeof payload === 'object') {
        if (payload.message) {
          // If there's a specific message field, use that
          messageText = payload.message;
        } else {
          // Check webhook format_type and format accordingly
          if (webhook.format_type === 'raw') {
            // For raw format, just stringify the JSON
            messageText = JSON.stringify(payload, null, 2);
          } else if (webhook.format_type === 'custom') {
            // For custom format, check if it's published
            if (webhook.is_published) {
              // If published, use the custom template
              messageText = formatWebhookMessage(payload, sourceUrl, webhook.custom_template, webhook.name);
            } else {
              // If not published, use raw format
              messageText = JSON.stringify(payload, null, 2);
            }
          } else {
            // For formatted (pretty) format, use the system default formatting
            messageText = formatWebhookMessage(payload, sourceUrl, null, webhook.name);
          }
        }
      } else {
        messageText = `${payload}`;
      }
      
      // Add text message to queue
      addToQueue({
        type: 'text',
        text: messageText,
        webhookId: webhook.id,
        userId: webhook.user_id  // Explicitly set userId
      });
    }
    
    res.status(200).json(createToastResponse(true, 'Webhook processed and added to queue', { queueLength: messageQueue.length }));
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json(createToastResponse(false, `Error processing webhook: ${error.message}`));
  }
});

// Delete webhook API
app.delete('/api/webhooks/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    
    const webhook = webhookOperations.getWebhookById(id);
    if (!webhook || webhook.user_id !== req.session.user.id) {
      return res.json(createToastResponse(false, 'Webhook not found'));
    }
    
    webhookOperations.deleteWebhook(id);
    
    res.json(createToastResponse(true, 'Webhook deleted successfully'));
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.json(createToastResponse(false, `Error deleting webhook: ${error.message}`));
  }
});

// Delete recipient API
app.delete('/api/recipients/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    
    const recipient = recipientOperations.getRecipientById(id);
    if (!recipient) {
      return res.json(createToastResponse(false, 'Recipient not found'));
    }
    
    // Verify user owns the webhook
    const webhook = webhookOperations.getWebhookById(recipient.webhook_id);
    if (!webhook || webhook.user_id !== req.session.user.id) {
      return res.json(createToastResponse(false, 'Access denied'));
    }
    
    recipientOperations.deleteRecipient(id);
    
    res.json(createToastResponse(true, 'Recipient deleted successfully'));
  } catch (error) {
    console.error('Error deleting recipient:', error);
    res.json(createToastResponse(false, `Error deleting recipient: ${error.message}`));
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    connectionStatus,
    queueLength: messageQueue.length,
    recipientsCount: recipientsConfig.recipients.length,
    activeRecipientsCount: recipientsConfig.recipients.filter(r => r.active).length
  });
});

// Subscription page
app.get('/subscription', isAuthenticated, (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.redirect('/admin/subscriptions');
  }
  
  try {
    const subscription = userOperations.checkUserSubscription(req.session.user.id);
    const trialInfo = userOperations.getTrialInfo(req.session.user.id);
    const plans = subscriptionPlanOperations.getActivePlans();
    
    // Get webhooks and recipients count
    const userWebhooks = webhookOperations.getWebhooksByUserId(req.session.user.id);
    const totalRecipients = userWebhooks.reduce((total, webhook) => {
      return total + recipientOperations.getRecipientsByWebhookId(webhook.id).length;
    }, 0);
    
    res.render('subscription', {
      user: req.session.user,
      subscription,
      trialInfo,
      plans,
      webhooksCount: userWebhooks.length,
      recipientsCount: totalRecipients,
      message: req.session.message,
      csrfToken: req.csrfToken()
    });
    delete req.session.message;
  } catch (error) {
    console.error('Subscription page error:', error);
    res.render('subscription', {
      user: req.session.user,
      subscription: null,
      trialInfo: null,
      plans: [],
      webhooksCount: 0,
      recipientsCount: 0,
      message: { type: 'danger', text: 'Error loading subscription data' },
      csrfToken: req.csrfToken()
    });
  }
});

// Admin subscription management
app.get('/admin/subscriptions', isAuthenticated, isAdmin, (req, res) => {
  try {
    const allUsers = userOperations.getAllUsers().filter(u => u.role !== 'admin');
    const plans = subscriptionPlanOperations.getActivePlans();
    
    res.render('admin-subscriptions', {
      user: req.session.user,
      users: allUsers,
      plans,
      message: req.session.message
    });
    delete req.session.message;
  } catch (error) {
    console.error('Admin subscriptions error:', error);
    res.render('admin-subscriptions', {
      user: req.session.user,
      users: [],
      plans: [],
      message: { type: 'danger', text: 'Error loading users data' }
    });
  }
});

// Update user subscription (admin only)
app.post('/admin/subscriptions/:userId', isAuthenticated, isAdmin, (req, res) => {
  try {
    const userId = req.params.userId;
    const { status, months } = req.body;
    
    console.log('Updating subscription:', { userId, status, months });
    
    let startDate = null;
    let endDate = null;
    
    if (status === 'active' && months) {
      startDate = new Date().toISOString();
      const end = new Date();
      end.setMonth(end.getMonth() + parseInt(months));
      endDate = end.toISOString();
      console.log('Setting subscription dates:', { startDate, endDate });
    }
    
    const result = userOperations.updateSubscription(userId, status, startDate, endDate);
    console.log('Update result:', result);
    
    req.session.message = {
      type: 'success',
      text: 'Subscription updated successfully'
    };
    
    res.redirect('/admin/subscriptions');
  } catch (error) {
    console.error('Update subscription error:', error);
    req.session.message = {
      type: 'danger',
      text: `Error updating subscription: ${error.message}`
    };
    res.redirect('/admin/subscriptions');
  }
});

// User subscription activation
app.post('/subscription/activate', isAuthenticated, (req, res) => {
  try {
    const { months } = req.body;
    
    if (!months || months < 1) {
      req.session.message = {
        type: 'danger',
        text: 'Invalid subscription period'
      };
      return res.redirect('/subscription');
    }
    
    const startDate = new Date().toISOString();
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + parseInt(months));
    
    userOperations.updateSubscription(req.session.user.id, 'active', startDate, endDate.toISOString());
    
    req.session.message = {
      type: 'success',
      text: 'Subscription activated successfully!'
    };
    
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Activate subscription error:', error);
    req.session.message = {
      type: 'danger',
      text: 'Error activating subscription'
    };
    res.redirect('/subscription');
  }
});

// Admin subscription plans management
app.get('/admin/plans', isAuthenticated, isAdmin, (req, res) => {
  try {
    const plans = subscriptionPlanOperations.getAllPlans();
    
    res.render('admin-plans', {
      user: req.session.user,
      plans,
      message: req.session.message
    });
    delete req.session.message;
  } catch (error) {
    console.error('Admin plans error:', error);
    res.render('admin-plans', {
      user: req.session.user,
      plans: [],
      message: { type: 'danger', text: 'Error loading plans data' }
    });
  }
});

// Create new subscription plan
app.post('/admin/plans', isAuthenticated, isAdmin, (req, res) => {
  try {
    const { name, duration_months, price, currency, description, payment_link } = req.body;
    
    if (!name || !duration_months || !price) {
      // Check if this is an AJAX request
      const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
      
      if (isAjax) {
        return res.json(createToastResponse(false, 'Name, duration, and price are required'));
      }
      
      req.session.message = {
        type: 'danger',
        text: 'Name, duration, and price are required'
      };
      return res.redirect('/admin/plans');
    }
    
    subscriptionPlanOperations.createPlan(name, parseInt(duration_months), parseFloat(price), currency || 'USD', description || '', payment_link || '');
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      return res.json(createToastResponse(true, 'Subscription plan created successfully'));
    }
    
    req.session.message = {
      type: 'success',
      text: 'Subscription plan created successfully'
    };
    
    res.redirect('/admin/plans');
  } catch (error) {
    console.error('Create plan error:', error);
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      return res.json(createToastResponse(false, `Error creating plan: ${error.message}`));
    }
    
    req.session.message = {
      type: 'danger',
      text: `Error creating plan: ${error.message}`
    };
    res.redirect('/admin/plans');
  }
});

// Update subscription plan
app.post('/admin/plans/:id', isAuthenticated, isAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, duration_months, price, currency, description, active, payment_link } = req.body;
    
    if (!name || !duration_months || !price) {
      // Check if this is an AJAX request
      const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
      
      if (isAjax) {
        return res.json(createToastResponse(false, 'Name, duration, and price are required'));
      }
      
      req.session.message = {
        type: 'danger',
        text: 'Name, duration, and price are required'
      };
      return res.redirect('/admin/plans');
    }
    
    // Handle active flag correctly based on content-type
    let isActive = false;
    if (req.headers['content-type'] === 'application/json') {
      // For JSON requests, use the boolean value directly
      isActive = active === true;
    } else {
      // For form submissions, check for 'on' string
      isActive = active === 'on';
    }
    
    subscriptionPlanOperations.updatePlan(
      id, 
      name, 
      parseInt(duration_months), 
      parseFloat(price), 
      currency || 'USD', 
      description || '', 
      isActive,
      payment_link || ''
    );
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      return res.json(createToastResponse(true, 'Subscription plan updated successfully'));
    }
    
    req.session.message = {
      type: 'success',
      text: 'Subscription plan updated successfully'
    };
    
    res.redirect('/admin/plans');
  } catch (error) {
    console.error('Update plan error:', error);
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      return res.json(createToastResponse(false, `Error updating plan: ${error.message}`));
    }
    
    req.session.message = {
      type: 'danger',
      text: `Error updating plan: ${error.message}`
    };
    res.redirect('/admin/plans');
  }
});

// Delete subscription plan
app.delete('/admin/plans/:id', isAuthenticated, isAdmin, (req, res) => {
  try {
    const { id } = req.params;
    
    subscriptionPlanOperations.deletePlan(id);
    
    res.json(createToastResponse(true, 'Plan deleted successfully'));
  } catch (error) {
    console.error('Delete plan error:', error);
    res.json(createToastResponse(false, `Error deleting plan: ${error.message}`));
  }
});

// Toggle subscription plan status
app.post('/admin/plans/:id/toggle', isAuthenticated, isAdmin, (req, res) => {
  try {
    const { id } = req.params;
    
    subscriptionPlanOperations.togglePlanStatus(id);
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      // If it's an AJAX request, respond with JSON
      return res.json(createToastResponse(true, 'Plan status updated successfully'));
    }
    
    // For regular form submissions, use session flash message
    req.session.message = {
      type: 'success',
      text: 'Plan status updated successfully'
    };
    
    res.redirect('/admin/plans');
  } catch (error) {
    console.error('Toggle plan status error:', error);
    
    // Check if this is an AJAX request
    const isAjax = req.xhr || req.headers.accept.indexOf('json') > -1 || req.headers['content-type'] === 'application/json';
    
    if (isAjax) {
      // If it's an AJAX request, respond with JSON
      return res.json(createToastResponse(false, `Error updating plan status: ${error.message}`));
    }
    
    req.session.message = {
      type: 'danger',
      text: `Error updating plan status: ${error.message}`
    };
    res.redirect('/admin/plans');
  }
});

// Admin settings page
app.get('/admin/settings', isAuthenticated, isAdmin, (req, res) => {
  try {
    const settings = settingsOperations.getAllSettings();
    
    res.render('admin-settings', {
      user: req.session.user,
      settings,
      message: req.session.message,
      csrfToken: req.csrfToken()
    });
    delete req.session.message;
  } catch (error) {
    console.error('Admin settings error:', error);
    res.render('admin-settings', {
      user: req.session.user,
      settings: [],
      message: { type: 'danger', text: 'Error loading settings data' },
      csrfToken: req.csrfToken()
    });
  }
});

// Update admin settings
app.post('/admin/settings', isAuthenticated, isAdmin, (req, res) => {
  try {
    const { recipient_limit, message_rate_limit, trial_duration_days } = req.body;
    
    // Validate inputs
    const errors = [];
    if (!recipient_limit || recipient_limit < 1 || recipient_limit > 10) {
      errors.push('Recipient limit must be between 1 and 10');
    }
    if (!message_rate_limit || message_rate_limit < 1 || message_rate_limit > 100) {
      errors.push('Message rate limit must be between 1 and 100');
    }
    if (!trial_duration_days || trial_duration_days < 1 || trial_duration_days > 90) {
      errors.push('Trial duration must be between 1 and 90 days');
    }
    
    if (errors.length > 0) {
      req.session.message = {
        type: 'danger',
        text: errors.join(', ')
      };
      return res.redirect('/admin/settings');
    }
    
    // Update settings
    settingsOperations.updateSetting('recipient_limit', recipient_limit.toString());
    settingsOperations.updateSetting('message_rate_limit', message_rate_limit.toString());
    settingsOperations.updateSetting('trial_duration_days', trial_duration_days.toString());
    
    req.session.message = {
      type: 'success',
      text: 'Settings updated successfully'
    };
    
    res.redirect('/admin/settings');
  } catch (error) {
    console.error('Update settings error:', error);
    req.session.message = {
      type: 'danger',
      text: `Error updating settings: ${error.message}`
    };
    res.redirect('/admin/settings');
  }
});

// Backward compatibility redirects
app.get('/recipients', isAuthenticated, (req, res) => {
  res.redirect('/webhooks');
});

app.get('/recipients/new', isAuthenticated, (req, res) => {
  res.redirect('/webhooks');
});

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Test webhook for template customization
app.post('/api/webhook/:webhookId/test', isAuthenticated, (req, res) => {
  try {
    const { webhookId } = req.params;
    
    // Verify webhook exists and belongs to the user
    const webhook = webhookOperations.getWebhookById(webhookId);
    if (!webhook || webhook.user_id !== req.session.user.id) {
      return res.json(createToastResponse(false, 'Webhook not found'));
    }
    
    // Get the structure of the last received webhook for this webhook
    const webhookStructure = lastReceivedWebhookStructures.get(Number(webhookId));
    
    if (!webhookStructure) {
      return res.json(createToastResponse(false, 'No webhook data available. Please send a webhook to this endpoint first.'));
    }
    
    // Return only the structure of the webhook (variable names and types), not the actual data
    res.json(createToastResponse(true, 'Retrieved webhook structure', { 
      variableStructure: webhookStructure.structure,
      receivedAt: webhookStructure.timestamp
    }));
  } catch (error) {
    console.error('Error retrieving webhook structure:', error);
    res.json(createToastResponse(false, `Error retrieving webhook structure: ${error.message}`));
  }
});

// Helper function to extract variable structure from webhook data
function extractVariableStructure(data, prefix = '') {
  const variables = [];
  
  if (!data || typeof data !== 'object') return variables;
  
  Object.keys(data).forEach(key => {
    const value = data[key];
    const path = prefix ? `${prefix}.${key}` : key;
    
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // For nested objects, recurse
      variables.push(...extractVariableStructure(value, path));
    } else {
      // For simple values or arrays, add variable info without the actual value
      variables.push({
        path,
        type: Array.isArray(value) ? 'array' : typeof value
      });
    }
  });
  
  return variables;
}

// Admin QR code page (khusus admin, global session)
app.get('/admin/qrcode', isAuthenticated, isAdmin, (req, res) => {
  res.render('admin-qrcode', {
    user: req.session.user,
    qrCode: qrCodeDataURL,
    connectionStatus,
    message: req.session.message
  });
  delete req.session.message;
});

// Generate QR code (admin only, global session)
app.post('/admin/api/qrcode', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // Disconnect and reinitialize WhatsApp
    if (waClient) {
      waClient.end();
      waClient = null;
    }
    connectionStatus = 'disconnected';
    qrCodeDataURL = null;
    // Initialize new connection
    await initWhatsApp();
    res.json(createToastResponse(true, 'QR code generation initiated'));
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.json(createToastResponse(false, `Error generating QR code: ${error.message}`));
  }
});

// Logout admin WhatsApp (global session)
app.post('/admin/whatsapp/logout', isAuthenticated, isAdmin, async (req, res) => {
  try {
    console.log('Admin WhatsApp logout initiated');
    
    // Disconnect WhatsApp client
    if (waClient) {
      console.log('Disconnecting WhatsApp client...');
      try {
        // Remove event listeners to prevent memory leaks
        if (waClient.ev) {
          waClient.ev.removeAllListeners('connection.update');
          waClient.ev.removeAllListeners('creds.update');
          waClient.ev.removeAllListeners('error');
        }
        
        // End the connection
        if (typeof waClient.end === 'function') {
          await waClient.end();
        }
      } catch (err) {
        console.log('Error during client disconnect:', err);
        // Continue even if there's an error
      }
      waClient = null;
    }
    
    // Update connection status
    connectionStatus = 'disconnected';
    qrCodeDataURL = null;
    
    // Delete session files from sessions directory
    try {
      const SESSION_DIR = path.join(__dirname, 'sessions');
      if (fs.existsSync(SESSION_DIR)) {
        const files = fs.readdirSync(SESSION_DIR);
        
        // Delete creds.json and session files
        files.forEach(file => {
          if (file === 'creds.json' || file.startsWith('session-') || file.startsWith('app-state-') || file.startsWith('pre-key-')) {
            try {
              const filePath = path.join(SESSION_DIR, file);
              fs.unlinkSync(filePath);
              console.log(`Deleted session file: ${file}`);
            } catch (err) {
              console.log(`Error deleting file ${file}:`, err);
            }
          }
        });
      }
    } catch (err) {
      console.log('Error deleting session files:', err);
    }
    
    console.log('Admin WhatsApp logout completed successfully');
    res.json({ success: true, message: 'Admin WhatsApp session logged out successfully' });
  } catch (error) {
    console.error('Error logging out admin WhatsApp:', error);
    res.json({ success: false, message: 'Error logging out admin WhatsApp session' });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize system WhatsApp
  await initWhatsApp();
  
  // Initialize user-specific WhatsApp clients for users with custom WhatsApp enabled
  try {
    const users = userOperations.getAllUsers();
    users.forEach(user => {
      if (user.custom_whatsapp_enabled && user.whatsapp_session_active) {
        console.log(`Initializing WhatsApp client for user ${user.id} (${user.username})`);
        initUserWhatsApp(user.id);
      }
    });
  } catch (error) {
    console.error('Error initializing user WhatsApp clients:', error);
  }
  
  console.log('WhatsApp Webhook Manager is ready!');
}); 