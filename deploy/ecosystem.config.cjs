// pm2 : MP_NODE=/chemin/vers/node22 pm2 start deploy/ecosystem.config.cjs
// Un seul process (mode fork) : les compteurs et sessions sont dans data/ (fichiers locaux).
// Les variables sont lues dans .env (chargé par l'app via process.loadEnvFile) : rien de secret ici.
const path = require('node:path')
module.exports = {
  apps: [
    {
      name: 'marie-poule',
      script: 'src/server.js',
      cwd: path.resolve(__dirname, '..'),
      interpreter: process.env.MP_NODE || 'node', // Node >= 22 requis
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      time: true, // horodate les journaux
    },
  ],
}
