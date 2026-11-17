module.exports = {
  apps: [
    {
      name: 'periodistapp-api',
      script: 'dist/server/index.js',
      cwd: '.',
      // NUNCA cluster/'max': el proceso guarda estado en memoria que no se
      // comparte entre workers — sesiones Socket.IO, schedulers (jobQueue,
      // transmissions, retention, backup), workers en vuelo y el estado de
      // capturas de stream. Con N instancias cada tick corre N veces y los
      // clientes WS se conectan a un proceso distinto del que emite.
      // Para aislar cómputo usar PROCESS_ROLE=api|worker (ver index.ts y
      // .env.example), no instancias PM2.
      instances: 1,
      exec_mode: 'fork',
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
