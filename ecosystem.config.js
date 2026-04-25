module.exports = {
  apps: [
    {
      name: 'periodistapp-api',
      script: 'dist/server/index.js',
      cwd: '.',
      instances: 'max', // Utiliza todos los cores disponibles
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3001,
      },
      // Configuración de logging
      log_file: 'logs/combined.log',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Configuración de restart
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',
      
      // Graceful shutdown
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      
      // Política de restart automático
      autorestart: true,
      restart_delay: 4000,
    },
  ],
  
  // Deploy configuration
  deploy: {
    production: {
      user: 'ubuntu',
      host: 'YOUR_VPS_IP',
      ref: 'origin/main',
      repo: 'https://github.com/YOUR_USERNAME/periodistapp.git',
      path: '/var/www/periodistapp',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run build:server && npm run build:client && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
    },
  },
};
