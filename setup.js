const fs = require('fs');
const readline = require('readline');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('WhatsApp Webhook Forwarder - Setup');
console.log('==================================');
console.log('This script will help you set up your environment variables.');
console.log('Press Ctrl+C at any time to exit.\n');

// Default values
const defaults = {
  PORT: '3000',
  WEBHOOK_PATH: '/webhook',
  RECIPIENT_NUMBER: ''
};

// Questions
const questions = {
  PORT: 'Enter the port number for the webhook server (default: 3000): ',
  WEBHOOK_PATH: 'Enter the webhook path (default: /webhook): ',
  RECIPIENT_NUMBER: 'Enter your WhatsApp number with country code (e.g., 628xxxxxxxxxx): '
};

// Config object
const config = {};

// Ask questions sequentially
function askQuestion(key) {
  return new Promise((resolve) => {
    rl.question(questions[key], (answer) => {
      config[key] = answer.trim() || defaults[key];
      resolve();
    });
  });
}

// Main function
async function main() {
  try {
    // Ask all questions
    for (const key of Object.keys(questions)) {
      await askQuestion(key);
    }

    // Validate recipient number
    if (!config.RECIPIENT_NUMBER) {
      console.error('\nError: WhatsApp recipient number is required.');
      process.exit(1);
    }

    // Format the recipient number (remove any non-digits)
    config.RECIPIENT_NUMBER = config.RECIPIENT_NUMBER.replace(/[^0-9]/g, '');

    // Create .env file content
    const envContent = Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    // Write to .env file
    fs.writeFileSync(path.join(__dirname, '.env'), envContent);

    console.log('\nConfiguration saved to .env file.');
    console.log('You can now start the application with: npm start');
  } catch (error) {
    console.error('Error during setup:', error);
  } finally {
    rl.close();
  }
}

// Run the main function
main(); 