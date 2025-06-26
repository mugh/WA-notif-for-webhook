const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Database = require('better-sqlite3');

// Configuration
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'wawebhook.db');
const BACKUP_PATH = process.env.DB_BACKUP_PATH || path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;

// Ensure backup directory exists
if (!fs.existsSync(BACKUP_PATH)) {
  fs.mkdirSync(BACKUP_PATH, { recursive: true });
}

// Generate backup filename with timestamp
function generateBackupFilename() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + 
                   now.toTimeString().split(' ')[0].replace(/:/g, '-');
  return `wawebhook-backup-${timestamp}.db`;
}

// Create backup using SQLite VACUUM
function createBackup() {
  return new Promise((resolve, reject) => {
    const backupFile = path.join(BACKUP_PATH, generateBackupFilename());
    
    try {
      // Open source database
      const sourceDb = new Database(DB_PATH);
      
      // Create backup database
      const backupDb = new Database(backupFile);
      
      // Copy all data from source to backup
      const tables = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      
      for (const table of tables) {
        const tableName = table.name;
        
        // Get table schema
        const schema = sourceDb.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
        if (schema) {
          backupDb.prepare(schema.sql).run();
        }
        
        // Copy data
        const data = sourceDb.prepare(`SELECT * FROM ${tableName}`).all();
        if (data.length > 0) {
          const columns = Object.keys(data[0]);
          const placeholders = columns.map(() => '?').join(',');
          const insertStmt = backupDb.prepare(`INSERT INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`);
          
          for (const row of data) {
            insertStmt.run(...columns.map(col => row[col]));
          }
        }
      }
      
      // Copy indexes and triggers
      const indexes = sourceDb.prepare("SELECT sql FROM sqlite_master WHERE type='index'").all();
      for (const index of indexes) {
        if (index.sql) {
          backupDb.prepare(index.sql).run();
        }
      }
      
      const triggers = sourceDb.prepare("SELECT sql FROM sqlite_master WHERE type='trigger'").all();
      for (const trigger of triggers) {
        if (trigger.sql) {
          backupDb.prepare(trigger.sql).run();
        }
      }
      
      // Close databases
      sourceDb.close();
      backupDb.close();
      
      console.log(`Backup created successfully: ${backupFile}`);
      resolve(backupFile);
      
    } catch (error) {
      console.error('Backup creation failed:', error);
      reject(error);
    }
  });
}

// Clean up old backups
function cleanupOldBackups() {
  try {
    const files = fs.readdirSync(BACKUP_PATH);
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - (RETENTION_DAYS * 24 * 60 * 60 * 1000));
    
    let deletedCount = 0;
    
    for (const file of files) {
      if (file.startsWith('wawebhook-backup-') && file.endsWith('.db')) {
        const filePath = path.join(BACKUP_PATH, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          console.log(`Deleted old backup: ${file}`);
          deletedCount++;
        }
      }
    }
    
    console.log(`Cleanup completed. Deleted ${deletedCount} old backup(s).`);
    return deletedCount;
    
  } catch (error) {
    console.error('Backup cleanup failed:', error);
    return 0;
  }
}

// Compress backup file
function compressBackup(backupFile) {
  return new Promise((resolve, reject) => {
    const compressedFile = backupFile + '.gz';
    
    exec(`gzip -f "${backupFile}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('Compression failed:', error);
        reject(error);
      } else {
        console.log(`Backup compressed: ${compressedFile}`);
        resolve(compressedFile);
      }
    });
  });
}

// Verify backup integrity
function verifyBackup(backupFile) {
  return new Promise((resolve, reject) => {
    try {
      const db = new Database(backupFile);
      
      // Check if we can read from the database
      const tableCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get();
      const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get();
      const webhookCount = db.prepare("SELECT COUNT(*) as count FROM webhooks").get();
      
      db.close();
      
      console.log(`Backup verification: ${tableCount.count} tables, ${userCount.count} users, ${webhookCount.count} webhooks`);
      resolve(true);
      
    } catch (error) {
      console.error('Backup verification failed:', error);
      reject(error);
    }
  });
}

// Main backup function
async function performBackup() {
  console.log('Starting database backup...');
  
  try {
    // Check if source database exists
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`Source database not found: ${DB_PATH}`);
    }
    
    // Create backup
    const backupFile = await createBackup();
    
    // Verify backup
    await verifyBackup(backupFile);
    
    // Compress backup
    await compressBackup(backupFile);
    
    // Clean up old backups
    cleanupOldBackups();
    
    console.log('Backup process completed successfully');
    
  } catch (error) {
    console.error('Backup process failed:', error);
    process.exit(1);
  }
}

// Run backup if called directly
if (require.main === module) {
  performBackup();
}

module.exports = { performBackup, createBackup, cleanupOldBackups }; 