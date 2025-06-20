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

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Load configurations
const USERS_FILE = path.join(__dirname, 'config', 'users.json');
const RECIPIENTS_FILE = path.join(__dirname, 'config', 'recipients.json');

// Ensure config directory exists
if (!fs.existsSync(path.join(__dirname, 'config'))) {
  fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
}

// Ensure users.json exists
if (!fs.existsSync(USERS_FILE)) {
  const defaultUsers = {
    users: [
      {
        username: 'admin',
        password: 'admin123',
        role: 'admin'
      }
    ]
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
}

// Ensure recipients.json exists
if (!fs.existsSync(RECIPIENTS_FILE)) {
  const defaultRecipients = {
    recipients: [
      {
        id: 'default',
        name: 'Default Recipient',
        number: '6281234567890',
        active: true,
        createdAt: new Date().toISOString()
      }
    ]
  };
  fs.writeFileSync(RECIPIENTS_FILE, JSON.stringify(defaultRecipients, null, 2));
}

// Load users and recipients configurations
let users = require(USERS_FILE);
let recipientsConfig = require(RECIPIENTS_FILE);

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret: 'wawebhook-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 } // 1 hour
}));

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

// Authentication middleware
function isAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  res.redirect('/login');
}

// Save recipients configuration to file
function saveRecipientsConfig() {
  fs.writeFileSync(RECIPIENTS_FILE, JSON.stringify(recipientsConfig, null, 2));
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

    waClient = makeWASocket({
      auth: state,
      defaultQueryTimeoutMs: undefined
    });

    // Handle connection updates
    waClient.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('QR Code received, scan with WhatsApp app:');
        qrCodeDataURL = await qrcode.toDataURL(qr);
      }

      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
        connectionStatus = 'disconnected';
        
        if (shouldReconnect) {
          initWhatsApp();
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

  } catch (error) {
    console.error('Error initializing WhatsApp:', error);
    connectionStatus = 'error';
  }
}

// Function to send a message to a recipient
async function sendMessage(recipientNumber, message) {
  if (!waClient || connectionStatus !== 'connected') {
    throw new Error('WhatsApp client not connected');
  }

  try {
    // Format the recipient number to ensure it has @s.whatsapp.net
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Send the message
    await waClient.sendMessage(formattedNumber, { text: message });
    console.log(`Message sent to ${formattedNumber}: ${message}`);
    return true;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

// Function to send an image message to a recipient
async function sendImageMessage(recipientNumber, imageUrl, caption = '') {
  if (!waClient || connectionStatus !== 'connected') {
    throw new Error('WhatsApp client not connected');
  }

  try {
    // Format the recipient number
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Send the image
    await waClient.sendMessage(formattedNumber, {
      image: { url: imageUrl },
      caption: caption
    });
    
    console.log(`Image message sent to ${formattedNumber}: ${imageUrl}`);
    return true;
  } catch (error) {
    console.error('Error sending image message:', error);
    throw error;
  }
}

// Function to add a message to the queue
function addToQueue(message) {
  messageQueue.push(message);
  console.log(`Added message to queue. Queue length: ${messageQueue.length}`);
  
  // Start processing the queue if not already processing
  if (!isProcessingQueue && connectionStatus === 'connected') {
    processQueue();
  }
}

// Function to format webhook messages in a more readable way
function formatWebhookMessage(payload) {
  // Start with a header
  let formattedMessage = "📩 *New Notification*\n\n";
  
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
  if (isProcessingQueue || messageQueue.length === 0 || connectionStatus !== 'connected') {
    return;
  }

  isProcessingQueue = true;
  console.log(`Processing message queue. ${messageQueue.length} messages in queue.`);

  try {
    while (messageQueue.length > 0 && connectionStatus === 'connected') {
      const message = messageQueue.shift();
      const activeRecipients = recipientsConfig.recipients.filter(r => r.active);
      
      for (const recipient of activeRecipients) {
        try {
          if (message.type === 'image') {
            await sendImageMessage(recipient.number, message.imageUrl, message.caption || '');
          } else {
            await sendMessage(recipient.number, message.text);
          }
          // Add a small delay between messages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Error sending message to ${recipient.number}:`, error);
          // Continue with next recipient even if one fails
        }
      }
    }
  } catch (error) {
    console.error('Error processing queue:', error);
  } finally {
    isProcessingQueue = false;
    
    // If there are still messages in the queue and we're connected, continue processing
    if (messageQueue.length > 0 && connectionStatus === 'connected') {
      setTimeout(processQueue, 1000);
    }
  }
}

// Routes
// Login page
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

// Login process
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  const user = users.users.find(u => u.username === username && u.password === password);
  
  if (user) {
    req.session.user = {
      username: user.username,
      role: user.role
    };
    res.redirect('/dashboard');
  } else {
    res.render('login', { error: 'Invalid username or password' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.render('dashboard', { 
    user: req.session.user,
    connectionStatus,
    lastConnected,
    recipientsCount: recipientsConfig.recipients.length,
    activeRecipientsCount: recipientsConfig.recipients.filter(r => r.active).length,
    queueLength: messageQueue.length,
    message: req.session.message
  });
  delete req.session.message;
});

// Recipients list
app.get('/recipients', isAuthenticated, (req, res) => {
  res.render('recipients', { 
    user: req.session.user,
    recipients: recipientsConfig.recipients,
    message: req.session.message
  });
  delete req.session.message;
});

// New recipient form
app.get('/recipients/new', isAuthenticated, (req, res) => {
  res.render('recipient-form', { 
    user: req.session.user,
    isNew: true,
    recipient: {},
    error: null
  });
});

// Create new recipient
app.post('/recipients', isAuthenticated, (req, res) => {
  try {
    const { name, number, active } = req.body;
    
    if (!name || !number) {
      return res.render('recipient-form', { 
        user: req.session.user,
        isNew: true,
        recipient: req.body,
        error: 'Name and number are required'
      });
    }
    
    // Check for duplicate number
    if (recipientsConfig.recipients.some(r => r.number === number)) {
      return res.render('recipient-form', { 
        user: req.session.user,
        isNew: true,
        recipient: req.body,
        error: 'A recipient with this number already exists'
      });
    }
    
    // Create new recipient
    const newRecipient = {
      id: uuidv4(),
      name,
      number,
      active: active === 'on',
      createdAt: new Date().toISOString()
    };
    
    // Add to config
    recipientsConfig.recipients.push(newRecipient);
    saveRecipientsConfig();
    
    req.session.message = {
      type: 'success',
      text: 'Recipient added successfully'
    };
    
    res.redirect('/recipients');
  } catch (error) {
    console.error('Error creating recipient:', error);
    res.render('recipient-form', { 
      user: req.session.user,
      isNew: true,
      recipient: req.body,
      error: `Error creating recipient: ${error.message}`
    });
  }
});

// Edit recipient form
app.get('/recipients/:id/edit', isAuthenticated, (req, res) => {
  const { id } = req.params;
  const recipient = recipientsConfig.recipients.find(r => r.id === id);
  
  if (!recipient) {
    req.session.message = {
      type: 'danger',
      text: 'Recipient not found'
    };
    return res.redirect('/recipients');
  }
  
  res.render('recipient-form', { 
    user: req.session.user,
    isNew: false,
    recipient,
    error: null
  });
});

// Update recipient
app.post('/recipients/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    const { name, number, active } = req.body;
    
    // Find recipient
    const recipientIndex = recipientsConfig.recipients.findIndex(r => r.id === id);
    if (recipientIndex === -1) {
      req.session.message = {
        type: 'danger',
        text: 'Recipient not found'
      };
      return res.redirect('/recipients');
    }
    
    const recipient = recipientsConfig.recipients[recipientIndex];
    
    if (!name || !number) {
      return res.render('recipient-form', { 
        user: req.session.user,
        isNew: false,
        recipient: { ...recipient, ...req.body },
        error: 'Name and number are required'
      });
    }
    
    // Check for duplicate number
    if (number !== recipient.number && 
        recipientsConfig.recipients.some(r => r.number === number)) {
      return res.render('recipient-form', { 
        user: req.session.user,
        isNew: false,
        recipient: { ...recipient, ...req.body },
        error: 'A recipient with this number already exists'
      });
    }
    
    // Update recipient
    recipientsConfig.recipients[recipientIndex] = {
      ...recipient,
      name,
      number,
      active: active === 'on'
    };
    
    saveRecipientsConfig();
    
    req.session.message = {
      type: 'success',
      text: 'Recipient updated successfully'
    };
    
    res.redirect('/recipients');
  } catch (error) {
    console.error('Error updating recipient:', error);
    res.render('recipient-form', { 
      user: req.session.user,
      isNew: false,
      recipient: { ...recipientsConfig.recipients.find(r => r.id === req.params.id), ...req.body },
      error: `Error updating recipient: ${error.message}`
    });
  }
});

// Delete recipient
app.delete('/api/recipients/:id', isAuthenticated, (req, res) => {
  try {
    const { id } = req.params;
    
    // Find recipient
    const recipientIndex = recipientsConfig.recipients.findIndex(r => r.id === id);
    if (recipientIndex === -1) {
      return res.json({
        success: false,
        message: 'Recipient not found'
      });
    }
    
    // Remove from config
    recipientsConfig.recipients.splice(recipientIndex, 1);
    saveRecipientsConfig();
    
    res.json({
      success: true,
      message: 'Recipient deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting recipient:', error);
    res.json({
      success: false,
      message: `Error deleting recipient: ${error.message}`
    });
  }
});

// QR code page
app.get('/qrcode', isAuthenticated, (req, res) => {
  res.render('qrcode', { 
    user: req.session.user,
    qrCode: qrCodeDataURL,
    connectionStatus,
    message: req.session.message
  });
  delete req.session.message;
});

// Generate QR code
app.post('/api/qrcode', isAuthenticated, async (req, res) => {
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
    
    res.json({
      success: true,
      message: 'QR code generation initiated'
    });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.json({
      success: false,
      message: `Error generating QR code: ${error.message}`
    });
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

// Test send message form
app.get('/test', isAuthenticated, (req, res) => {
  res.render('test', { 
    user: req.session.user,
    recipients: recipientsConfig.recipients,
    connectionStatus,
    message: req.session.message
  });
  delete req.session.message;
});

// Send test message
app.post('/test', isAuthenticated, async (req, res) => {
  try {
    const { messageType, text, imageUrl, caption } = req.body;
    
    if (connectionStatus !== 'connected') {
      req.session.message = {
        type: 'danger',
        text: 'WhatsApp is not connected'
      };
      return res.redirect('/test');
    }
    
    if (messageType === 'image') {
      if (!imageUrl) {
        req.session.message = {
          type: 'danger',
          text: 'Image URL is required for image messages'
        };
        return res.redirect('/test');
      }
      
      addToQueue({
        type: 'image',
        imageUrl,
        caption: caption || ''
      });
    } else {
      if (!text) {
        req.session.message = {
          type: 'danger',
          text: 'Message text is required'
        };
        return res.redirect('/test');
      }
      
      addToQueue({
        type: 'text',
        text
      });
    }
    
    req.session.message = {
      type: 'success',
      text: 'Message added to queue and will be sent to all active recipients'
    };
    
    res.redirect('/test');
  } catch (error) {
    console.error('Error sending test message:', error);
    req.session.message = {
      type: 'danger',
      text: `Error sending test message: ${error.message}`
    };
    res.redirect('/test');
  }
});

// Webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook received:', req.body);
    
    if (connectionStatus !== 'connected') {
      return res.status(503).json({
        success: false,
        message: 'WhatsApp is not connected'
      });
    }
    
    const payload = req.body;
    
    // Check if the payload contains a message type
    if (payload.type === 'image' && payload.imageUrl) {
      // Add image message to queue
      addToQueue({
        type: 'image',
        imageUrl: payload.imageUrl,
        caption: payload.caption || ''
      });
    } else {
      // Format the message based on the payload structure in a more readable way
      let messageText = '';
      
      if (typeof payload === 'object') {
        if (payload.message) {
          // If there's a specific message field, use that
          messageText = payload.message;
        } else {
          // Format the payload in a more readable way
          messageText = formatWebhookMessage(payload);
        }
      } else {
        messageText = `${payload}`;
      }
      
      // Add text message to queue
      addToQueue({
        type: 'text',
        text: messageText
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Webhook processed and added to queue',
      queueLength: messageQueue.length
    });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing webhook',
      error: error.message
    });
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

// Root redirect
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Initialize WhatsApp
  await initWhatsApp();
  
  console.log('WhatsApp Webhook Manager is ready!');
}); 