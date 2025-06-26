@echo off
setlocal enabledelayedexpansion

REM Production Deployment Script for WhatsApp Webhook (Windows)
REM Usage: scripts\deploy.bat [environment]

set ENVIRONMENT=%1
if "%ENVIRONMENT%"=="" set ENVIRONMENT=production

set APP_NAME=wawebhook
set DOCKER_COMPOSE_FILE=docker-compose.yml
set BACKUP_BEFORE_DEPLOY=true

echo [%date% %time%] Starting deployment for environment: %ENVIRONMENT%

REM Check if Docker is installed
docker --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH
    exit /b 1
)

REM Check if Docker Compose is installed
docker-compose --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Compose is not installed or not in PATH
    exit /b 1
)

REM Check if .env file exists
if not exist .env (
    echo [ERROR] .env file not found. Please create one from env.example
    exit /b 1
)

REM Function to create backup
if "%BACKUP_BEFORE_DEPLOY%"=="true" (
    echo [INFO] Creating database backup...
    if exist scripts\backup.js (
        node scripts\backup.js
    ) else (
        echo [WARNING] Backup script not found, skipping backup
    )
)

REM Function to check health
echo [INFO] Checking application health...
timeout /t 10 /nobreak >nul

if exist scripts\health-check.js (
    node scripts\health-check.js
    if errorlevel 1 (
        echo [ERROR] Health check failed
        exit /b 1
    ) else (
        echo [INFO] Health check passed
    )
) else (
    echo [WARNING] Health check script not found, skipping health check
)

REM Function to stop services
echo [INFO] Stopping existing services...
docker-compose -f %DOCKER_COMPOSE_FILE% down --remove-orphans

REM Function to start services
echo [INFO] Starting services...
docker-compose -f %DOCKER_COMPOSE_FILE% up -d --build

if errorlevel 1 (
    echo [ERROR] Failed to start services
    exit /b 1
) else (
    echo [INFO] Services started successfully
)

REM Function to update code
echo [INFO] Updating application code...

REM Pull latest changes if git repository
if exist .git (
    git pull origin main
    if errorlevel 1 (
        echo [WARNING] Failed to pull latest changes
    )
)

REM Install dependencies
echo [INFO] Installing dependencies...
call npm ci --only=production

REM Build CSS
echo [INFO] Building CSS...
call npm run build:css

REM Function to run migrations
echo [INFO] Running database migrations...
if exist scripts\migrate.js (
    node scripts\migrate.js
) else (
    echo [WARNING] Migration script not found, skipping migrations
)

REM Function to seed data
echo [INFO] Seeding initial data...
if exist scripts\seed.js (
    node scripts\seed.js
) else (
    echo [WARNING] Seed script not found, skipping data seeding
)

REM Function to show status
echo [INFO] Application status:
docker-compose -f %DOCKER_COMPOSE_FILE% ps

echo [INFO] Recent logs:
docker-compose -f %DOCKER_COMPOSE_FILE% logs --tail=20

REM Function to cleanup
echo [INFO] Cleaning up...
docker system prune -f
docker image prune -f

echo [INFO] Deployment completed successfully!

echo [INFO] Application should be available at:
echo [INFO]   - HTTP: http://localhost:80
echo [INFO]   - HTTPS: https://localhost:443 (if configured)
echo.
echo [INFO] To view logs: docker-compose logs -f
echo [INFO] To stop: docker-compose down

endlocal 