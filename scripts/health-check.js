const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';

// Check if database file exists and is accessible
function checkDatabase() {
  try {
    const dbPath = path.join(__dirname, '..', 'data', 'wawebhook.db');
    if (!fs.existsSync(dbPath)) {
      console.error('Database file not found');
      return false;
    }
    
    // Try to read the file to ensure it's accessible
    fs.accessSync(dbPath, fs.constants.R_OK);
    return true;
  } catch (error) {
    console.error('Database access error:', error.message);
    return false;
  }
}

// Check if sessions directory exists
function checkSessions() {
  try {
    const sessionsPath = path.join(__dirname, '..', 'sessions');
    if (!fs.existsSync(sessionsPath)) {
      fs.mkdirSync(sessionsPath, { recursive: true });
    }
    return true;
  } catch (error) {
    console.error('Sessions directory error:', error.message);
    return false;
  }
}

// Check if logs directory exists
function checkLogs() {
  try {
    const logsPath = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }
    return true;
  } catch (error) {
    console.error('Logs directory error:', error.message);
    return false;
  }
}

// Check application health via HTTP
function checkHttpHealth() {
  return new Promise((resolve) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: '/health',
      method: 'GET',
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        console.error(`Health check failed with status: ${res.statusCode}`);
        resolve(false);
      }
    });

    req.on('error', (error) => {
      console.error('Health check request error:', error.message);
      resolve(false);
    });

    req.on('timeout', () => {
      console.error('Health check timeout');
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

// Main health check function
async function performHealthCheck() {
  console.log('Starting health check...');
  
  const checks = [
    { name: 'Database', check: checkDatabase },
    { name: 'Sessions Directory', check: checkSessions },
    { name: 'Logs Directory', check: checkLogs }
  ];

  let allChecksPassed = true;

  // Perform file system checks
  for (const check of checks) {
    const passed = check.check();
    console.log(`${check.name}: ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed) {
      allChecksPassed = false;
    }
  }

  // Perform HTTP health check if application is running
  try {
    const httpHealth = await checkHttpHealth();
    console.log(`HTTP Health Check: ${httpHealth ? 'PASS' : 'FAIL'}`);
    if (!httpHealth) {
      allChecksPassed = false;
    }
  } catch (error) {
    console.log('HTTP Health Check: SKIP (application may not be running)');
  }

  if (allChecksPassed) {
    console.log('All health checks passed');
    process.exit(0);
  } else {
    console.error('Some health checks failed');
    process.exit(1);
  }
}

// Run health check if called directly
if (require.main === module) {
  performHealthCheck();
}

module.exports = { performHealthCheck }; 