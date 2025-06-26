#!/bin/bash

# Production Deployment Script for WhatsApp Webhook
# Usage: ./scripts/deploy.sh [environment]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ENVIRONMENT=${1:-production}
APP_NAME="wawebhook"
DOCKER_COMPOSE_FILE="docker-compose.yml"
BACKUP_BEFORE_DEPLOY=true

# Logging function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] $1${NC}"
}

warn() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}"
}

error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}"
    exit 1
}

info() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $1${NC}"
}

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   error "This script should not be run as root"
fi

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    error "Docker is not installed"
fi

# Check if Docker Compose is installed
if ! command -v docker-compose &> /dev/null; then
    error "Docker Compose is not installed"
fi

# Check if .env file exists
if [ ! -f .env ]; then
    error ".env file not found. Please create one from env.example"
fi

# Function to create backup
create_backup() {
    if [ "$BACKUP_BEFORE_DEPLOY" = true ]; then
        log "Creating database backup..."
        if [ -f "scripts/backup.js" ]; then
            node scripts/backup.js
        else
            warn "Backup script not found, skipping backup"
        fi
    fi
}

# Function to check health
check_health() {
    log "Checking application health..."
    sleep 10
    
    if [ -f "scripts/health-check.js" ]; then
        if node scripts/health-check.js; then
            log "Health check passed"
        else
            error "Health check failed"
        fi
    else
        warn "Health check script not found, skipping health check"
    fi
}

# Function to stop services
stop_services() {
    log "Stopping existing services..."
    docker-compose -f $DOCKER_COMPOSE_FILE down --remove-orphans || true
}

# Function to start services
start_services() {
    log "Starting services..."
    docker-compose -f $DOCKER_COMPOSE_FILE up -d --build
    
    if [ $? -eq 0 ]; then
        log "Services started successfully"
    else
        error "Failed to start services"
    fi
}

# Function to update code
update_code() {
    log "Updating application code..."
    
    # Pull latest changes if git repository
    if [ -d ".git" ]; then
        git pull origin main || warn "Failed to pull latest changes"
    fi
    
    # Install dependencies
    log "Installing dependencies..."
    npm ci --only=production
    
    # Build CSS
    log "Building CSS..."
    npm run build:css
}

# Function to run migrations
run_migrations() {
    log "Running database migrations..."
    if [ -f "scripts/migrate.js" ]; then
        node scripts/migrate.js
    else
        warn "Migration script not found, skipping migrations"
    fi
}

# Function to seed data
seed_data() {
    log "Seeding initial data..."
    if [ -f "scripts/seed.js" ]; then
        node scripts/seed.js
    else
        warn "Seed script not found, skipping data seeding"
    fi
}

# Function to show status
show_status() {
    log "Application status:"
    docker-compose -f $DOCKER_COMPOSE_FILE ps
    
    log "Recent logs:"
    docker-compose -f $DOCKER_COMPOSE_FILE logs --tail=20
}

# Function to cleanup
cleanup() {
    log "Cleaning up..."
    docker system prune -f || true
    docker image prune -f || true
}

# Main deployment function
deploy() {
    log "Starting deployment for environment: $ENVIRONMENT"
    
    # Pre-deployment checks
    log "Running pre-deployment checks..."
    
    # Create backup
    create_backup
    
    # Update code
    update_code
    
    # Stop existing services
    stop_services
    
    # Run migrations
    run_migrations
    
    # Start services
    start_services
    
    # Check health
    check_health
    
    # Seed data if needed
    seed_data
    
    # Show status
    show_status
    
    # Cleanup
    cleanup
    
    log "Deployment completed successfully!"
    
    # Show access information
    info "Application should be available at:"
    info "  - HTTP: http://localhost:80"
    info "  - HTTPS: https://localhost:443 (if configured)"
    info ""
    info "To view logs: docker-compose logs -f"
    info "To stop: docker-compose down"
}

# Function to rollback
rollback() {
    log "Rolling back deployment..."
    
    # Stop current services
    stop_services
    
    # Restore from backup if available
    if [ -d "backups" ] && [ "$(ls -A backups)" ]; then
        warn "Manual rollback required. Please restore from backup in backups/ directory"
    fi
    
    # Start previous version
    start_services
    
    log "Rollback completed"
}

# Function to show help
show_help() {
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  deploy [environment]  Deploy the application (default: production)"
    echo "  rollback             Rollback to previous version"
    echo "  status               Show application status"
    echo "  logs                 Show application logs"
    echo "  stop                 Stop all services"
    echo "  start                Start all services"
    echo "  restart              Restart all services"
    echo "  backup               Create database backup"
    echo "  health               Run health check"
    echo "  help                 Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 deploy production"
    echo "  $0 rollback"
    echo "  $0 status"
}

# Main script logic
case "${1:-deploy}" in
    "deploy")
        deploy
        ;;
    "rollback")
        rollback
        ;;
    "status")
        show_status
        ;;
    "logs")
        docker-compose -f $DOCKER_COMPOSE_FILE logs -f
        ;;
    "stop")
        stop_services
        ;;
    "start")
        start_services
        ;;
    "restart")
        stop_services
        start_services
        ;;
    "backup")
        create_backup
        ;;
    "health")
        check_health
        ;;
    "help"|"-h"|"--help")
        show_help
        ;;
    *)
        error "Unknown command: $1. Use 'help' for usage information."
        ;;
esac 