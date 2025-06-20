const http = require('http');
const readline = require('readline');

// Configuration
const port = process.env.PORT || 3000;
const webhookPath = process.env.WEBHOOK_PATH || '/webhook';
const host = 'localhost';

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Available test payloads
const testPayloads = {
  text: {
    type: 'text',
    message: 'This is a simple text message from the webhook'
  },
  json: {
    type: 'json',
    title: 'System Notification',
    status: 'success',
    timestamp: new Date().toISOString(),
    source: 'API Server',
    data: {
      key1: 'value1',
      key2: 'value2',
      nested: {
        key: 'value'
      }
    }
  },
  order: {
    type: 'order',
    orderId: 'ORD-' + Math.floor(10000 + Math.random() * 90000),
    customerName: 'John Doe',
    orderDate: new Date().toISOString(),
    status: 'confirmed',
    items: [
      { name: 'Product A', quantity: 2, price: 25.99 },
      { name: 'Product B', quantity: 1, price: 59.99 }
    ],
    totalAmount: 111.97,
    shippingAddress: {
      street: '123 Main St',
      city: 'Anytown',
      zipCode: '12345'
    },
    paymentMethod: 'Credit Card'
  },
  alert: {
    type: 'alert',
    alertLevel: 'critical',
    system: 'Database Server',
    message: 'High CPU usage detected',
    timestamp: new Date().toISOString(),
    metrics: {
      cpu: '92%',
      memory: '87%',
      disk: '65%'
    },
    actionRequired: true
  },
  image: {
    type: 'image',
    imageUrl: 'https://picsum.photos/200/300', // Random image from Lorem Picsum
    caption: 'This is an image sent via webhook'
  }
};

// Function to send webhook
function sendWebhook(payload) {
  // Options for the HTTP request
  const options = {
    hostname: host,
    port: port,
    path: webhookPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(JSON.stringify(payload))
    }
  };

  console.log(`Sending test webhook to http://${host}:${port}${webhookPath}`);
  console.log('Payload:', JSON.stringify(payload, null, 2));

  // Create and send the request
  const req = http.request(options, (res) => {
    console.log(`STATUS: ${res.statusCode}`);
    console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
    
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      console.log('Response body:', data);
      console.log('Test webhook sent successfully!');
      process.exit(0);
    });
  });

  req.on('error', (e) => {
    console.error(`Error sending test webhook: ${e.message}`);
    process.exit(1);
  });

  // Write the payload and end the request
  req.write(JSON.stringify(payload));
  req.end();
}

// Display menu
console.log('WhatsApp Webhook Tester');
console.log('======================');
console.log('Select a test payload type:');
console.log('1. Text message');
console.log('2. JSON data (System notification)');
console.log('3. Order confirmation');
console.log('4. System alert');
console.log('5. Image with caption');
console.log('6. Custom payload');

// Get user choice
rl.question('Enter your choice (1-6): ', (choice) => {
  let payload;
  
  switch (choice) {
    case '1':
      payload = testPayloads.text;
      break;
    case '2':
      payload = testPayloads.json;
      break;
    case '3':
      payload = testPayloads.order;
      break;
    case '4':
      payload = testPayloads.alert;
      break;
    case '5':
      payload = testPayloads.image;
      break;
    case '6':
      // Custom payload
      rl.question('Enter your custom JSON payload: ', (customPayload) => {
        try {
          payload = JSON.parse(customPayload);
          sendWebhook(payload);
        } catch (error) {
          console.error('Invalid JSON payload:', error.message);
          process.exit(1);
        }
        rl.close();
      });
      return;
    default:
      console.log('Invalid choice. Please enter a number between 1 and 6.');
      rl.close();
      process.exit(1);
  }
  
  sendWebhook(payload);
  rl.close();
}); 