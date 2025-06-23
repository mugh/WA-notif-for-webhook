const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

// Salt rounds for bcrypt
const SALT_ROUNDS = 10;

// Ensure the data directory exists
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize database
const db = new Database(path.join(DATA_DIR, 'wawebhook.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Function to check if a column exists in a table
function columnExists(table, column) {
  const result = db.prepare(`PRAGMA table_info(${table})`).all();
  return result.some(col => col.name === column);
}

// Function to migrate user table to add subscription columns
function migrateUserTable() {
  try {
    // Check if subscription_status column exists
    if (!columnExists('users', 'subscription_status')) {
      console.log('Migrating users table: Adding subscription_status column');
      db.prepare('ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT "trial"').run();
    }
    
    // Check if trial_start_date column exists
    if (!columnExists('users', 'trial_start_date')) {
      console.log('Migrating users table: Adding trial_start_date column');
      db.prepare('ALTER TABLE users ADD COLUMN trial_start_date TIMESTAMP').run();
      // Update existing records with current timestamp
      db.prepare('UPDATE users SET trial_start_date = CURRENT_TIMESTAMP WHERE trial_start_date IS NULL').run();
    }
    
    // Check if trial_end_date column exists
    if (!columnExists('users', 'trial_end_date')) {
      console.log('Migrating users table: Adding trial_end_date column');
      db.prepare('ALTER TABLE users ADD COLUMN trial_end_date TIMESTAMP').run();
      // Update existing records with trial end date (14 days from now)
      db.prepare('UPDATE users SET trial_end_date = datetime("now", "+14 days") WHERE trial_end_date IS NULL').run();
    }
    
    // Check if subscription_start_date column exists
    if (!columnExists('users', 'subscription_start_date')) {
      console.log('Migrating users table: Adding subscription_start_date column');
      db.prepare('ALTER TABLE users ADD COLUMN subscription_start_date TIMESTAMP').run();
    }
    
    // Check if subscription_end_date column exists
    if (!columnExists('users', 'subscription_end_date')) {
      console.log('Migrating users table: Adding subscription_end_date column');
      db.prepare('ALTER TABLE users ADD COLUMN subscription_end_date TIMESTAMP').run();
    }
    
    // Check if custom_whatsapp_enabled column exists
    if (!columnExists('users', 'custom_whatsapp_enabled')) {
      console.log('Migrating users table: Adding custom_whatsapp_enabled column');
      db.prepare('ALTER TABLE users ADD COLUMN custom_whatsapp_enabled BOOLEAN NOT NULL DEFAULT 0').run();
    }
    
    // Check if whatsapp_session_active column exists
    if (!columnExists('users', 'whatsapp_session_active')) {
      console.log('Migrating users table: Adding whatsapp_session_active column');
      db.prepare('ALTER TABLE users ADD COLUMN whatsapp_session_active BOOLEAN NOT NULL DEFAULT 0').run();
    }
    
    console.log('User table migration completed successfully');
  } catch (error) {
    console.error('Error migrating users table:', error);
  }
}

// Function to migrate user table to add phone number column
function migrateUserTableForPhone() {
  try {
    // Check if phone_number column exists
    if (!columnExists('users', 'phone_number')) {
      console.log('Migrating users table: Adding phone_number column');
      db.prepare('ALTER TABLE users ADD COLUMN phone_number TEXT').run();
    }
    
    // Check if phone_verified column exists
    if (!columnExists('users', 'phone_verified')) {
      console.log('Migrating users table: Adding phone_verified column');
      db.prepare('ALTER TABLE users ADD COLUMN phone_verified BOOLEAN NOT NULL DEFAULT 0').run();
    }
    
    console.log('User table phone migration completed successfully');
  } catch (error) {
    console.error('Error migrating users table for phone:', error);
  }
}

// Function to migrate webhook table to add format_type column
function migrateWebhookTable() {
  try {
    // Check if format_type column exists
    if (!columnExists('webhooks', 'format_type')) {
      console.log('Migrating webhooks table: Adding format_type column');
      db.prepare('ALTER TABLE webhooks ADD COLUMN format_type TEXT NOT NULL DEFAULT "formatted"').run();
    }
    
    // Check if custom_template column exists
    if (!columnExists('webhooks', 'custom_template')) {
      console.log('Migrating webhooks table: Adding custom_template column');
      db.prepare('ALTER TABLE webhooks ADD COLUMN custom_template TEXT').run();
    }
    
    // Check if is_published column exists
    if (!columnExists('webhooks', 'is_published')) {
      console.log('Migrating webhooks table: Adding is_published column');
      db.prepare('ALTER TABLE webhooks ADD COLUMN is_published BOOLEAN NOT NULL DEFAULT 0').run();
    }
    
    console.log('Webhook table migration completed successfully');
  } catch (error) {
    console.error('Error migrating webhooks table:', error);
  }
}

// Function to migrate user table to make email nullable
function migrateUserTableEmail() {
  try {
    // Check current email column constraint
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const emailColumn = tableInfo.find(col => col.name === 'email');
    
    if (emailColumn && emailColumn.notnull === 1) {
      console.log('Migrating users table: Making email column nullable');
      
      // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
      // First, get all current data
      const users = db.prepare('SELECT * FROM users').all();
      
      // Create new table without NOT NULL constraint on email
      db.prepare(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          email TEXT UNIQUE,
          phone_number TEXT,
          phone_verified BOOLEAN NOT NULL DEFAULT 0,
          role TEXT NOT NULL DEFAULT 'user',
          subscription_status TEXT NOT NULL DEFAULT 'trial',
          trial_start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          trial_end_date TIMESTAMP DEFAULT (datetime('now', '+14 days')),
          subscription_start_date TIMESTAMP NULL,
          subscription_end_date TIMESTAMP NULL,
          custom_whatsapp_enabled BOOLEAN NOT NULL DEFAULT 0,
          whatsapp_session_active BOOLEAN NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      
      // Copy data to new table
      if (users.length > 0) {
        const insertStmt = db.prepare(`
          INSERT INTO users_new (
            id, username, password, email, phone_number, phone_verified, role, 
            subscription_status, trial_start_date, trial_end_date, 
            subscription_start_date, subscription_end_date, 
            custom_whatsapp_enabled, whatsapp_session_active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        users.forEach(user => {
          insertStmt.run(
            user.id, user.username, user.password, user.email, 
            user.phone_number, user.phone_verified || 0, user.role, 
            user.subscription_status, user.trial_start_date, user.trial_end_date,
            user.subscription_start_date, user.subscription_end_date,
            user.custom_whatsapp_enabled || 0, user.whatsapp_session_active || 0,
            user.created_at, user.updated_at
          );
        });
      }
      
      // Drop old table and rename new one
      db.prepare('DROP TABLE users').run();
      db.prepare('ALTER TABLE users_new RENAME TO users').run();
      
      console.log('Email column migration completed successfully');
    }
  } catch (error) {
    console.error('Error migrating email column:', error);
  }
}

// Create tables if they don't exist
function initializeDatabase() {
  // Users table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT UNIQUE,
      phone_number TEXT UNIQUE,
      phone_verified BOOLEAN NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      subscription_status TEXT NOT NULL DEFAULT 'trial',
      trial_start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      trial_end_date TIMESTAMP DEFAULT (datetime('now', '+14 days')),
      subscription_start_date TIMESTAMP NULL,
      subscription_end_date TIMESTAMP NULL,
      custom_whatsapp_enabled BOOLEAN NOT NULL DEFAULT 0,
      whatsapp_session_active BOOLEAN NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Check if subscription columns exist, if not add them
  migrateUserTable();
  
  // Check if phone columns exist, if not add them
  migrateUserTableForPhone();
  
  // Make email column nullable
  migrateUserTableEmail();

  // OTP Verification table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS otp_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      otp_code TEXT NOT NULL,
      otp_type TEXT NOT NULL, -- 'register' or 'forgot_password'
      expires_at TIMESTAMP NOT NULL,
      is_used BOOLEAN NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Webhooks table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      webhook_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      format_type TEXT NOT NULL DEFAULT "formatted",
      custom_template TEXT,
      is_published BOOLEAN NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `).run();
  
  // Check if format_type column exists in webhooks table, if not add it
  migrateWebhookTable();

  // Recipients table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    )
  `).run();

  // Subscription plans table
  db.prepare(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      duration_months INTEGER NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT,
      active BOOLEAN NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // Insert default subscription plans if table is empty
  const planCount = db.prepare('SELECT COUNT(*) as count FROM subscription_plans').get();
  if (planCount.count === 0) {
    const defaultPlans = [
      { name: '1 Month', duration_months: 1, price: 9.99, description: 'Monthly subscription' },
      { name: '3 Months', duration_months: 3, price: 24.99, description: 'Quarterly subscription - Save 17%' },
      { name: '6 Months', duration_months: 6, price: 44.99, description: 'Semi-annual subscription - Save 25%' },
      { name: '12 Months', duration_months: 12, price: 79.99, description: 'Annual subscription - Save 33%' }
    ];
    
    const insertPlan = db.prepare(
      'INSERT INTO subscription_plans (name, duration_months, price, description) VALUES (?, ?, ?, ?)'
    );
    
    defaultPlans.forEach(plan => {
      insertPlan.run(plan.name, plan.duration_months, plan.price, plan.description);
    });
    
    console.log('Default subscription plans created');
  }

  // Create admin user if not exists
  const adminExists = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    db.prepare(
      'INSERT INTO users (username, password, email, phone_number, phone_verified, role, subscription_status) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('admin', 'admin123', 'admin@example.com', '+6281234567890', 1, 'admin', 'lifetime');
  }
}

// User operations
const userOperations = {
  async createUser(username, password, phoneNumber) {
    try {
      // Check if username already exists
      const existingUsername = this.getUserByUsername(username);
      if (existingUsername) {
        throw new Error('Username already exists');
      }
      
      // Check if phone number already exists
      if (phoneNumber) {
        const existingPhone = this.getUserByPhoneNumber(phoneNumber);
        if (existingPhone) {
          throw new Error('Phone number already exists');
        }
      }
      
      // Hash the password
      const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
      
      const stmt = db.prepare(
        'INSERT INTO users (username, password, email, phone_number) VALUES (?, ?, ?, ?)'
      );
      const result = stmt.run(username, hashedPassword, null, phoneNumber);
      return result.lastInsertRowid;
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('Username already exists');
      }
      throw error;
    }
  },

  getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  getUserByPhoneNumber(phoneNumber) {
    return db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber);
  },

  getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },

  getAllUsers() {
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
  },

  updateSubscription(userId, status, startDate = null, endDate = null) {
    const stmt = db.prepare(
      'UPDATE users SET subscription_status = ?, subscription_start_date = ?, subscription_end_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    return stmt.run(status, startDate, endDate, userId);
  },

  checkUserSubscription(userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return null;

    const now = new Date();
    
    // Check if trial expired
    if (user.subscription_status === 'trial') {
      const trialEnd = new Date(user.trial_end_date);
      if (now > trialEnd) {
        // Update status to expired
        this.updateSubscription(userId, 'expired');
        return { ...user, subscription_status: 'expired' };
      }
    }
    
    // Check if paid subscription expired
    if (user.subscription_status === 'active' && user.subscription_end_date) {
      const subEnd = new Date(user.subscription_end_date);
      if (now > subEnd) {
        // Update status to expired
        this.updateSubscription(userId, 'expired');
        return { ...user, subscription_status: 'expired' };
      }
    }

    return user;
  },

  getTrialInfo(userId) {
    const user = db.prepare('SELECT trial_start_date, trial_end_date FROM users WHERE id = ?').get(userId);
    if (!user) return null;

    const trialStart = new Date(user.trial_start_date);
    const trialEnd = new Date(user.trial_end_date);
    const now = new Date();
    
    // Calculate days left in trial
    const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
    
    return {
      trialStartDate: user.trial_start_date,
      trialEndDate: user.trial_end_date,
      daysLeft: Math.max(0, daysLeft),
      isExpired: now > trialEnd
    };
  },
  
  updateWhatsAppConfig(userId, useCustomWhatsApp) {
    const stmt = db.prepare(
      'UPDATE users SET custom_whatsapp_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    
    // If disabling custom WhatsApp, also reset the session active status
    if (!useCustomWhatsApp) {
      const resetStmt = db.prepare(
        'UPDATE users SET custom_whatsapp_enabled = 0, whatsapp_session_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      );
      return resetStmt.run(userId);
    }
    
    return stmt.run(useCustomWhatsApp ? 1 : 0, userId);
  },
  
  updateWhatsAppSessionStatus(userId, isActive) {
    const stmt = db.prepare(
      'UPDATE users SET whatsapp_session_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    return stmt.run(isActive ? 1 : 0, userId);
  },
  
  getWhatsAppConfig(userId) {
    const user = db.prepare('SELECT custom_whatsapp_enabled, whatsapp_session_active FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    
    return {
      customWhatsAppEnabled: !!user.custom_whatsapp_enabled,
      sessionActive: !!user.whatsapp_session_active
    };
  },

  async verifyPassword(user, password) {
    if (!user || !password) return false;
    
    try {
      // Check if password is hashed (starts with $2b$)
      if (user.password.startsWith('$2b$')) {
        // Password is already hashed, use bcrypt compare
        return await bcrypt.compare(password, user.password);
      } else {
        // Legacy plain text password, verify and update if correct
        if (user.password === password) {
          // Update to hashed password
          const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
          this.updatePassword(user.id, hashedPassword);
          return true;
        }
        return false;
      }
    } catch (error) {
      console.error('Password verification error:', error);
      return false;
    }
  },

  async updatePassword(userId, newPassword) {
    try {
      // Check if password is already hashed
      if (!newPassword.startsWith('$2b$')) {
        // Hash the new password
        newPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
      }
      
      const stmt = db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      return stmt.run(newPassword, userId);
    } catch (error) {
      console.error('Error updating password:', error);
      throw error;
    }
  },

  verifyPhone(userId) {
    const stmt = db.prepare('UPDATE users SET phone_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    return stmt.run(userId);
  },

  deleteUser(userId) {
    try {
      // Start a transaction to ensure all data is deleted together
      const deleteTransaction = db.transaction(() => {
        // Get user's webhooks first
        const userWebhooks = db.prepare('SELECT id FROM webhooks WHERE user_id = ?').all(userId);
        
        // Delete recipients for all user's webhooks
        for (const webhook of userWebhooks) {
          db.prepare('DELETE FROM recipients WHERE webhook_id = ?').run(webhook.id);
        }
        
        // Delete user's webhooks
        db.prepare('DELETE FROM webhooks WHERE user_id = ?').run(userId);
        
        // Delete user's OTP records
        const userRecord = db.prepare('SELECT phone_number FROM users WHERE id = ?').get(userId);
        if (userRecord && userRecord.phone_number) {
          db.prepare('DELETE FROM otp_verifications WHERE phone_number = ?').run(userRecord.phone_number);
        }
        
        // Finally, delete the user
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      });
      
      // Execute the transaction
      deleteTransaction();
      return true;
    } catch (error) {
      console.error('Error deleting user:', error);
      throw error;
    }
  }
};

// Webhook operations
const webhookOperations = {
  createWebhook(userId, webhookId, name, formatType = 'formatted', customTemplate = null, isPublished = false) {
    try {
      const stmt = db.prepare(
        'INSERT INTO webhooks (user_id, webhook_id, name, format_type, custom_template, is_published) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const result = stmt.run(userId, webhookId, name, formatType, customTemplate, isPublished ? 1 : 0);
      return result.lastInsertRowid;
    } catch (error) {
      throw error;
    }
  },

  getWebhookById(id) {
    return db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
  },

  getWebhookByWebhookId(webhookId) {
    return db.prepare('SELECT * FROM webhooks WHERE webhook_id = ?').get(webhookId);
  },

  getWebhooksByUserId(userId) {
    return db.prepare('SELECT * FROM webhooks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  },

  getAllWebhooks() {
    return db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
  },

  updateWebhook(id, name, formatType, customTemplate = null, isPublished = false) {
    if (formatType) {
      const stmt = db.prepare('UPDATE webhooks SET name = ?, format_type = ?, custom_template = ?, is_published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      return stmt.run(name, formatType, customTemplate, isPublished ? 1 : 0, id);
    } else {
      const stmt = db.prepare('UPDATE webhooks SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      return stmt.run(name, id);
    }
  },

  deleteWebhook(id) {
    const stmt = db.prepare('DELETE FROM webhooks WHERE id = ?');
    return stmt.run(id);
  }
};

// Recipient operations
const recipientOperations = {
  createRecipient(webhookId, phoneNumber, name) {
    try {
      // Check if the webhook already has 2 recipients
      const count = db.prepare('SELECT COUNT(*) as count FROM recipients WHERE webhook_id = ?').get(webhookId);
      if (count.count >= 2) {
        throw new Error('Maximum of 2 recipients allowed per webhook');
      }

      const stmt = db.prepare(
        'INSERT INTO recipients (webhook_id, phone_number, name) VALUES (?, ?, ?)'
      );
      const result = stmt.run(webhookId, phoneNumber, name);
      return result.lastInsertRowid;
    } catch (error) {
      throw error;
    }
  },

  getRecipientById(id) {
    return db.prepare('SELECT * FROM recipients WHERE id = ?').get(id);
  },

  getRecipientsByWebhookId(webhookId) {
    return db.prepare('SELECT * FROM recipients WHERE webhook_id = ? ORDER BY created_at DESC').all(webhookId);
  },

  updateRecipient(id, name, phoneNumber, active) {
    const stmt = db.prepare(
      'UPDATE recipients SET name = ?, phone_number = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    return stmt.run(name, phoneNumber, active ? 1 : 0, id);
  },

  deleteRecipient(id) {
    const stmt = db.prepare('DELETE FROM recipients WHERE id = ?');
    return stmt.run(id);
  }
};

// Subscription plan operations
const subscriptionPlanOperations = {
  getAllPlans() {
    return db.prepare('SELECT * FROM subscription_plans ORDER BY duration_months ASC').all();
  },

  getActivePlans() {
    return db.prepare('SELECT * FROM subscription_plans WHERE active = 1 ORDER BY duration_months ASC').all();
  },

  getPlanById(id) {
    return db.prepare('SELECT * FROM subscription_plans WHERE id = ?').get(id);
  },

  createPlan(name, durationMonths, price, currency = 'USD', description = '') {
    try {
      const stmt = db.prepare(
        'INSERT INTO subscription_plans (name, duration_months, price, currency, description) VALUES (?, ?, ?, ?, ?)'
      );
      const result = stmt.run(name, durationMonths, price, currency, description);
      return result.lastInsertRowid;
    } catch (error) {
      throw error;
    }
  },

  updatePlan(id, name, durationMonths, price, currency, description, active) {
    const stmt = db.prepare(
      'UPDATE subscription_plans SET name = ?, duration_months = ?, price = ?, currency = ?, description = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    return stmt.run(name, durationMonths, price, currency, description, active ? 1 : 0, id);
  },

  deletePlan(id) {
    const stmt = db.prepare('DELETE FROM subscription_plans WHERE id = ?');
    return stmt.run(id);
  },

  togglePlanStatus(id) {
    const plan = this.getPlanById(id);
    if (!plan) return null;
    
    const newStatus = plan.active ? 0 : 1;
    const stmt = db.prepare('UPDATE subscription_plans SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    return stmt.run(newStatus, id);
  }
};

// OTP operations
const otpOperations = {
  createOTP(phoneNumber, otpCode, otpType) {
    try {
      // Clean up expired OTP codes for this phone number
      this.cleanupExpiredOTP(phoneNumber);
      
      // Set expiration time (5 minutes from now)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      
      const stmt = db.prepare(
        'INSERT INTO otp_verifications (phone_number, otp_code, otp_type, expires_at) VALUES (?, ?, ?, ?)'
      );
      const result = stmt.run(phoneNumber, otpCode, otpType, expiresAt);
      return result.lastInsertRowid;
    } catch (error) {
      throw error;
    }
  },

  verifyOTP(phoneNumber, otpCode, otpType) {
    try {
      const stmt = db.prepare(`
        SELECT * FROM otp_verifications 
        WHERE phone_number = ? AND otp_code = ? AND otp_type = ? 
        AND is_used = 0 AND expires_at > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `);
      const otp = stmt.get(phoneNumber, otpCode, otpType);
      
      if (otp) {
        // Mark OTP as used
        const updateStmt = db.prepare('UPDATE otp_verifications SET is_used = 1 WHERE id = ?');
        updateStmt.run(otp.id);
        return true;
      }
      return false;
    } catch (error) {
      throw error;
    }
  },

  cleanupExpiredOTP(phoneNumber = null) {
    try {
      let stmt;
      if (phoneNumber) {
        stmt = db.prepare(`
          DELETE FROM otp_verifications 
          WHERE phone_number = ? AND (expires_at < datetime('now') OR is_used = 1)
        `);
        stmt.run(phoneNumber);
      } else {
        stmt = db.prepare(`
          DELETE FROM otp_verifications 
          WHERE expires_at < datetime('now') OR is_used = 1
        `);
        stmt.run();
      }
    } catch (error) {
      console.error('Error cleaning up expired OTP:', error);
    }
  },

  generateOTPCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
};

module.exports = {
  initializeDatabase,
  userOperations,
  webhookOperations,
  recipientOperations,
  subscriptionPlanOperations,
  otpOperations
}; 