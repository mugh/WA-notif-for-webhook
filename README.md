# WhatsApp Webhook Manager

A production-ready application that listens for webhook requests and forwards them to multiple registered WhatsApp numbers using Baileys.

## 🚀 Features

- **Multi-User Support**: Individual WhatsApp sessions per user
- **Queue System**: Reliable message delivery with retry mechanism
- **Web Interface**: Modern UI for managing webhooks and recipients
- **Message Types**: Support for text, image, and custom template messages
- **QR Code Authentication**: Easy WhatsApp connection setup
- **Production Ready**: Docker, monitoring, logging, and backup systems
- **Security**: CSRF protection, rate limiting, and secure sessions
- **High Availability**: PM2 cluster mode and health monitoring

## 📋 Table of Contents

1. [Quick Start](#quick-start)
2. [Features](#-features)
3. [Prerequisites](#prerequisites)
4. [Installation](#installation)
5. [Usage](#usage)
6. [Webhook API](#webhook-api)
7. [Production Deployment](#production-deployment)
8. [Monitoring & Logging](#monitoring--logging)
9. [Backup & Recovery](#backup--recovery)
10. [Troubleshooting](#troubleshooting)
11. [Security](#security)
12. [License](#license)

## 🚀 Quick Start

### Development Setup

```bash
# Clone repository
git clone <repository-url>
cd wawebhook

# Install dependencies
npm install

# Start development server
npm run dev
```

### Production Setup

```bash
# Copy environment configuration
cp env.example .env

# Edit production settings
nano .env

# Deploy with Docker (recommended)
./scripts/deploy.sh deploy production

# Or deploy with PM2
npm install -g pm2
npm run pm2:start
```

## Prerequisites

### Development Requirements
- Node.js (v18 or higher)
- npm (v8 or higher)
- A WhatsApp account

### Production Requirements
- **OS**: Ubuntu 20.04+ / CentOS 8+ / Debian 11+
- **CPU**: 2+ cores
- **RAM**: 4GB+ (8GB recommended)
- **Storage**: 20GB+ available space
- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **Domain name**: For SSL certificate
- **SSL certificate**: Let's Encrypt or commercial

## Installation

### 1. Development Installation

```bash
# Clone this repository
git clone <repository-url>
cd wawebhook

# Install dependencies
npm install

# Start the application
npm start
```

For development with auto-restart on file changes:
```bash
npm run dev
```

### 2. Production Installation

#### Option A: Docker Compose (Recommended)

```bash
# Copy environment configuration
cp env.example .env

# Edit production settings
nano .env

# Deploy to production
./scripts/deploy.sh deploy production
```

#### Option B: PM2 Process Manager

```bash
# Install PM2 globally
npm install -g pm2

# Install dependencies
npm ci --only=production

# Build CSS
npm run build:css

# Start with PM2
npm run pm2:start
```

#### Option C: Manual Deployment

```bash
# Install dependencies
npm ci --only=production

# Build CSS
npm run build:css

# Start application
npm run prod
```

## Usage

### 1. Initial Setup

1. Access the web interface at `http://localhost:3000`
2. Login with default credentials:
   - Username: `admin`
   - Password: `admin123`
3. Navigate to the QR Code page and scan with your WhatsApp app to connect
4. Add webhooks and recipient numbers through the web interface

### 2. Webhook Management

- Create webhooks with custom endpoints
- Add multiple recipients per webhook
- Configure message templates
- Monitor webhook delivery status

### 3. Message Delivery

The application uses a queue system to handle message delivery:

1. Webhook request is received and validated
2. Message is added to the processing queue
3. Queue processor sends message to each active recipient
4. Failed deliveries are retried automatically
5. Delivery status is logged and monitored

## Webhook API

### Send a Text Message

```bash
curl -X POST http://localhost:3000/api/webhook/YOUR_WEBHOOK_ID \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from webhook!"}'
```

### Send an Image Message

```bash
curl -X POST http://localhost:3000/api/webhook/YOUR_WEBHOOK_ID \
  -H "Content-Type: application/json" \
  -d '{
    "type": "image", 
    "imageUrl": "https://example.com/image.jpg", 
    "caption": "Image caption"
  }'
```

### Custom Template Message

```bash
curl -X POST http://localhost:3000/api/webhook/YOUR_WEBHOOK_ID \
  -H "Content-Type: application/json" \
  -d '{
    "user": "John Doe",
    "order": "12345",
    "amount": "$99.99"
  }'
```

## Production Deployment

### Environment Configuration

Create your production environment file:

```bash
# Copy the example environment file
cp env.example .env

# Edit the environment file with your production settings
nano .env
```

**Essential Configuration:**

```bash
# Application
NODE_ENV=production
PORT=3000
HOST=0.0.0.0

# Security (CHANGE THESE!)
SESSION_SECRET=your-super-secret-session-key-minimum-32-characters
CSRF_SECRET=your-csrf-secret-key-minimum-32-characters

# Database
DB_PATH=./data/wawebhook.db
DB_BACKUP_PATH=./data/backups

# WhatsApp Configuration
WHATSAPP_SESSION_PATH=./sessions
WHATSAPP_MAX_RETRIES=3
WHATSAPP_RETRY_DELAY=5000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
LOGIN_RATE_LIMIT_MAX=5
LOGIN_RATE_LIMIT_WINDOW_MS=900000

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/app.log
LOG_MAX_SIZE=10m
LOG_MAX_FILES=5

# Backup Configuration
BACKUP_ENABLED=true
BACKUP_INTERVAL_HOURS=24
BACKUP_RETENTION_DAYS=7
```

### Deployment Options

#### 1. Docker Compose (Recommended)

```bash
# Make deployment script executable
chmod +x scripts/deploy.sh

# Deploy to production
./scripts/deploy.sh deploy production

# Check status
./scripts/deploy.sh status

# View logs
./scripts/deploy.sh logs
```

#### 2. PM2 Process Manager

```bash
# Install PM2 globally
npm install -g pm2

# Start with PM2
npm run pm2:start

# Monitor
npm run pm2:monit

# View logs
npm run pm2:logs
```

### Security Configuration

#### 1. Firewall Setup

```bash
# Allow SSH, HTTP, HTTPS
sudo ufw allow ssh
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

#### 2. SSL Certificate (Let's Encrypt)

```bash
# Install Certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx

# Get SSL certificate
sudo certbot --nginx -d yourdomain.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

## Monitoring & Logging

### Application Logs

Logs are automatically rotated and stored in the `logs/` directory:

- `combined-YYYY-MM-DD.log`: All application logs
- `error-YYYY-MM-DD.log`: Error logs only
- `exceptions-YYYY-MM-DD.log`: Unhandled exceptions
- `rejections-YYYY-MM-DD.log`: Unhandled promise rejections

### Health Monitoring

```bash
# Manual health check
./scripts/deploy.sh health

# Or directly
node scripts/health-check.js

# Check health endpoint
curl http://localhost/health
```

### System Monitoring

```bash
# Monitor system resources
htop

# Monitor disk usage
df -h

# Monitor memory usage
free -h

# Docker logs
docker-compose logs -f
```

## Backup & Recovery

### Automatic Backups

Backups are automatically created daily and stored in `backups/` directory.

### Manual Backup

```bash
# Create manual backup
./scripts/deploy.sh backup

# Or directly
node scripts/backup.js
```

### Restore from Backup

```bash
# Stop the application
./scripts/deploy.sh stop

# Restore database
cp backups/wawebhook-backup-YYYY-MM-DD-HH-MM-SS.db data/wawebhook.db

# Start the application
./scripts/deploy.sh start
```

## Troubleshooting

### Common Issues

#### 1. Application Won't Start

```bash
# Check logs
docker-compose logs wawebhook

# Check environment variables
docker-compose exec wawebhook env

# Check database
docker-compose exec wawebhook node -e "console.log(require('fs').existsSync('./data/wawebhook.db'))"
```

#### 2. WhatsApp Connection Issues

```bash
# Check WhatsApp session
ls -la sessions/

# Clear session and reconnect
rm -rf sessions/*
docker-compose restart wawebhook
```

#### 3. Database Issues

```bash
# Check database integrity
docker-compose exec wawebhook node -e "
const db = require('better-sqlite3')('./data/wawebhook.db');
console.log('Database integrity:', db.pragma('integrity_check'));
db.close();
"
```

#### 4. Memory Issues

```bash
# Check memory usage
docker stats

# Restart with more memory
docker-compose down
docker-compose up -d --scale wawebhook=1
```

### Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=debug
docker-compose restart wawebhook
```

## Security

### Built-in Security Features

- **CSRF Protection**: All forms protected against CSRF attacks
- **Rate Limiting**: API endpoints protected against abuse
- **Session Security**: Secure, HTTP-only cookies with proper expiration
- **Input Validation**: All user inputs validated and sanitized
- **SQL Injection Protection**: Parameterized queries prevent SQL injection
- **XSS Protection**: Content Security Policy headers
- **Helmet.js**: Security headers for protection against common vulnerabilities

### Default Credentials

The web interface is protected with authentication. Default credentials:
- Username: `admin`
- Password: `admin123`

**⚠️ Important**: Change these credentials immediately in production!

You can change these credentials in the `config/users.json` file or through the admin interface.

### Security Best Practices

1. **Change Default Passwords**: Update admin credentials immediately
2. **Use HTTPS**: Configure SSL/TLS certificates
3. **Regular Updates**: Keep dependencies and system updated
4. **Firewall**: Configure proper firewall rules
5. **Backup**: Regular database backups
6. **Monitoring**: Monitor logs and system resources
7. **Access Control**: Limit access to admin interfaces

## Maintenance

### Regular Maintenance Tasks

```bash
# Daily: Check logs
./scripts/deploy.sh logs

# Weekly: Update dependencies
npm update
docker-compose build --no-cache

# Monthly: Database optimization
docker-compose exec wawebhook node -e "
const db = require('better-sqlite3')('./data/wawebhook.db');
db.pragma('VACUUM');
db.pragma('ANALYZE');
db.close();
"
```

### Security Updates

```bash
# Update base images
docker-compose pull
docker-compose build --no-cache

# Update Node.js dependencies
npm audit fix
npm update
```

## Available Scripts

```bash
# Development
npm run dev          # Start development server with auto-restart
npm run build:css    # Build CSS files
npm start           # Start production server

# Production
npm run prod        # Start in production mode
npm run pm2:start   # Start with PM2
npm run pm2:stop    # Stop PM2 processes
npm run pm2:restart # Restart PM2 processes
npm run pm2:logs    # View PM2 logs
npm run pm2:monit   # Monitor PM2 processes

# Maintenance
npm run backup      # Create database backup
npm run health-check # Run health check
npm run migrate     # Run database migrations
npm run seed        # Seed initial data
```

## Support

For additional support:

1. Check the application logs in `logs/` directory
2. Review the troubleshooting section above
3. Check the GitHub issues page
4. Contact the development team

## License

This project is licensed under the ISC License. 