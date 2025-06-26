module.exports = {
  apps: [{
    name: 'wawebhook',
    script: 'server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    // Logging
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Process management
    max_memory_restart: '1G',
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    
    // Watch mode (development only)
    watch: false,
    ignore_watch: ['node_modules', 'logs', 'data', 'sessions', 'backups'],
    
    // Health check
    health_check_grace_period: 3000,
    
    // Kill timeout
    kill_timeout: 5000,
    
    // Environment variables
    env_file: '.env',
    
    // Cron jobs
    cron_restart: '0 2 * * *', // Restart daily at 2 AM
    
    // Metrics
    pmx: true,
    
    // Node options
    node_args: '--max-old-space-size=1024',
    
    // Merge logs
    merge_logs: true,
    
    // Source map support
    source_map_support: true,
    
    // Disable source map cache
    disable_source_map_support: false,
    
    // Instance vars
    instance_var: 'INSTANCE_ID',
    
    // Listen timeout
    listen_timeout: 8000,
    
    // Kill timeout
    kill_timeout: 5000,
    
    // Wait ready
    wait_ready: true,
    
    // Listen timeout
    listen_timeout: 8000,
    
    // Graceful shutdown
    shutdown_with_message: true,
    
    // Auto restart
    autorestart: true,
    
    // Error log
    error_log: './logs/error.log',
    
    // Out log
    out_log: './logs/out.log',
    
    // Combined log
    log_file: './logs/combined.log',
    
    // Log date format
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Merge logs
    merge_logs: true,
    
    // PMX
    pmx: true,
    
    // Source map support
    source_map_support: true,
    
    // Disable source map cache
    disable_source_map_support: false,
    
    // Instance var
    instance_var: 'INSTANCE_ID',
    
    // Wait ready
    wait_ready: true,
    
    // Shutdown with message
    shutdown_with_message: true,
    
    // Auto restart
    autorestart: true
  }],
  
  deploy: {
    production: {
      user: 'wawebhook',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:yourusername/wawebhook.git',
      path: '/var/www/wawebhook',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
}; 