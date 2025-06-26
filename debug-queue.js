const path = require('path');
const fs = require('fs');

console.log('🔍 WhatsApp Queue Debug Script');
console.log('================================\n');

// Import the database operations
const db = require('./db.js');

console.log('✅ Database connected successfully\n');

// Start debugging
debugQueue();

function debugQueue() {
  console.log('📊 Checking Webhooks and Recipients...\n');
  
  try {
    // Get all webhooks
    const webhooks = db.webhookOperations.getAllWebhooks();
    
    console.log(`📋 Found ${webhooks.length} webhook(s):`);
    webhooks.forEach((webhook, index) => {
      console.log(`   ${index + 1}. ${webhook.name} (ID: ${webhook.id}, Webhook ID: ${webhook.webhook_id})`);
    });
    console.log('');
    
    // Check recipients for each webhook
    webhooks.forEach((webhook, index) => {
      const recipients = db.recipientOperations.getRecipientsByWebhookId(webhook.id);
      
      console.log(`📞 Recipients for "${webhook.name}" (${webhook.id}):`);
      if (recipients.length === 0) {
        console.log('   ❌ No recipients configured!');
        console.log('   💡 Add at least one recipient to receive WhatsApp messages.');
      } else {
        recipients.forEach((recipient, rIndex) => {
          const status = recipient.active ? '✅ Active' : '❌ Inactive';
          console.log(`   ${rIndex + 1}. ${recipient.name} (${recipient.phone_number}) - ${status}`);
        });
      }
      console.log('');
    });
    
    // If no webhooks, still check connection
    if (webhooks.length === 0) {
      console.log('❌ No webhooks found!');
      console.log('💡 Create a webhook first to start receiving messages.\n');
    }
    
    checkConnectionStatus();
    
  } catch (error) {
    console.error('❌ Error during debugging:', error.message);
    checkConnectionStatus();
  }
}

function checkConnectionStatus() {
  console.log('🔌 Checking WhatsApp Connection Status...\n');
  
  // Check if sessions directory exists
  const sessionsDir = path.join(__dirname, 'sessions');
  
  if (fs.existsSync(sessionsDir)) {
    const files = fs.readdirSync(sessionsDir);
    const sessionFiles = files.filter(file => 
      file === 'creds.json' || 
      file.startsWith('session-') || 
      file.startsWith('app-state-') || 
      file.startsWith('pre-key-')
    );
    
    console.log(`📁 Sessions directory found with ${sessionFiles.length} session file(s):`);
    sessionFiles.forEach(file => {
      console.log(`   📄 ${file}`);
    });
    
    if (sessionFiles.length === 0) {
      console.log('   ❌ No session files found!');
      console.log('   💡 Scan QR code to connect WhatsApp.');
    } else {
      console.log('   ✅ Session files exist - WhatsApp should be connected.');
    }
  } else {
    console.log('❌ Sessions directory not found!');
    console.log('💡 Start the server to create sessions directory.');
  }
  
  console.log('\n🔧 Troubleshooting Steps:');
  console.log('1. Make sure WhatsApp is connected (scan QR code if needed)');
  console.log('2. Add at least one recipient to your webhook');
  console.log('3. Ensure the recipient is marked as "Active"');
  console.log('4. Check that the webhook URL is correct');
  console.log('5. Send a test webhook to verify the queue is working');
  
  console.log('\n📝 To test the webhook, send a POST request to:');
  console.log('   http://localhost:3000/api/webhook/YOUR_WEBHOOK_ID');
  console.log('   with JSON body: {"message": "Test message"}');
  
  console.log('\n🔍 Common Issues:');
  console.log('- Queue not processing: Check if WhatsApp is connected');
  console.log('- No messages sent: Check if recipients are configured and active');
  console.log('- Connection lost: Re-scan QR code');
  console.log('- Rate limiting: System limits configurable messages per hour per recipient');
} 