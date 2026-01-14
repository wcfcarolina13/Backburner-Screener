module.exports = {
  apps: [{
    name: 'backburner',
    script: 'dist/web-server.js',

    // Restart settings
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',

    // Logging - SAVE EVERYTHING
    error_file: 'logs/pm2-error.log',
    out_file: 'logs/pm2-out.log',
    log_file: 'logs/pm2-combined.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Keep logs forever (rotate at 10MB, keep 30 files)
    max_size: '10M',
    retain: 30,

    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },

    // Crash handling - restart with exponential backoff
    exp_backoff_restart_delay: 100,
    restart_delay: 5000,

    // Stop gracefully (allow position saving)
    kill_timeout: 10000,
    listen_timeout: 10000,

    // Cron restart daily at 4am to clean up memory
    cron_restart: '0 4 * * *',
  }]
};
