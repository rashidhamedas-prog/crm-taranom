module.exports = {
  apps: [{
    name: 'crm-taranom',
    script: 'server.js',
    cwd: '/home/taranom-admin/crm-taranom/server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
      JWT_SECRET: 'taranom-crm-secret-2024-change-this'
    }
  }]
};
