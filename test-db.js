const Database = require('better-sqlite3');
const db = new Database('./data/wawebhook.db');

// Check table schema
console.log('=== Checking subscription_plans table schema ===');
const schema = db.prepare('PRAGMA table_info(subscription_plans)').all();
console.log('Schema:', JSON.stringify(schema, null, 2));

// Check if payment_link column exists
const hasPaymentLink = schema.some(col => col.name === 'payment_link');
console.log('Has payment_link column:', hasPaymentLink);

// Get current plans
console.log('\n=== Current plans ===');
const plans = db.prepare('SELECT * FROM subscription_plans').all();
console.log('Plans:', JSON.stringify(plans, null, 2));

// Add payment_link column if it doesn't exist
if (!hasPaymentLink) {
  console.log('\n=== Adding payment_link column ===');
  db.prepare('ALTER TABLE subscription_plans ADD COLUMN payment_link TEXT').run();
  console.log('Payment link column added successfully');
}

// Update existing plans with sample payment links
console.log('\n=== Updating existing plans with sample payment links ===');
const updateStmt = db.prepare('UPDATE subscription_plans SET payment_link = ? WHERE id = ?');

// Update plan with ID 21 (Yearly)
updateStmt.run('https://example.com/payment/yearly', 21);
console.log('Updated plan ID 21 with payment link');

// Update plan with ID 22 (Monthly)
updateStmt.run('https://example.com/payment/monthly', 22);
console.log('Updated plan ID 22 with payment link');

// Check updated plans
console.log('\n=== Updated plans ===');
const updatedPlans = db.prepare('SELECT * FROM subscription_plans').all();
console.log('Updated plans:', JSON.stringify(updatedPlans, null, 2));

db.close();
console.log('\n=== Test completed ==='); 