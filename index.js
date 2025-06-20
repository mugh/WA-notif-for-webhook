const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const express = require('express');
const bodyParser = require('body-parser');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Create sessions directory if it doesn't exist
const SESSION_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Configuration
const port = process.env.PORT || 3000;
const webhookPath = process.env.WEBHOOK_PATH || '/webhook';
const recipientNumber = process.env.RECIPIENT_NUMBER || '6281234567890'; // Default number if not in .env

// Initialize Express app
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// WhatsApp client
let sock;
let isConnected = false;

// Connect to WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('sessions');

  sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    defaultQueryTimeoutMs: undefined
  });

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR Code received, scan with WhatsApp app:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting:', shouldReconnect);
      
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection established!');
      isConnected = true;
    }
  });

  // Save credentials whenever they are updated
  sock.ev.on('creds.update', saveCreds);
}

// Start WhatsApp connection
connectToWhatsApp();

// Function to send a text message to the recipient
async function sendTextMessage(message) {
  if (!isConnected) {
    console.log('WhatsApp client not connected yet');
    return false;
  }

  try {
    // Format the recipient number to ensure it has @s.whatsapp.net
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Send the message
    await sock.sendMessage(formattedNumber, { text: message });
    console.log(`Text message sent to ${formattedNumber}: ${message}`);
    return true;
  } catch (error) {
    console.error('Error sending text message:', error);
    return false;
  }
}

// Function to send an image message to the recipient
async function sendImageMessage(imageUrl, caption = '') {
  if (!isConnected) {
    console.log('WhatsApp client not connected yet');
    return false;
  }

  try {
    // Format the recipient number
    const formattedNumber = recipientNumber.includes('@s.whatsapp.net') 
      ? recipientNumber 
      : `${recipientNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    // Send the image
    await sock.sendMessage(formattedNumber, {
      image: { url: imageUrl },
      caption: caption
    });
    
    console.log(`Image message sent to ${formattedNumber}: ${imageUrl}`);
    return true;
  } catch (error) {
    console.error('Error sending image message:', error);
    return false;
  }
}

// Webhook endpoint
app.post(webhookPath, async (req, res) => {
  try {
    console.log('Webhook received:', req.body);
    
    // Extract message from webhook payload
    const payload = req.body;
    let sent = false;
    
    // Check if the payload contains a message type
    if (payload.type === 'image' && payload.imageUrl) {
      // Handle image message
      sent = await sendImageMessage(payload.imageUrl, payload.caption || '');
    } else {
      // Default to text message
      // Format the message based on the payload structure
      let messageToForward = '';
      
      if (typeof payload === 'object') {
        if (payload.message) {
          // If there's a specific message field, use that
          messageToForward = payload.message;
        } else {
          // Otherwise, stringify the whole payload
          messageToForward = `Webhook notification:\n${JSON.stringify(payload, null, 2)}`;
        }
      } else {
        messageToForward = `Webhook notification: ${payload}`;
      }
      
      // Send the message
      sent = await sendTextMessage(messageToForward);
    }
    
    if (sent) {
      res.status(200).json({ success: true, message: 'Webhook processed and forwarded to WhatsApp' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to send WhatsApp message' });
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ success: false, message: 'Error processing webhook', error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    whatsappConnected: isConnected 
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Webhook endpoint: POST http://localhost:${port}${webhookPath}`);
}); 