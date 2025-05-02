module.exports = {
    apps: [
      {
        name: 'api-server',
        script: './src/server.js',
        watch: false,
        env_file: '.env'
      },
      {
        name: 'worker',
        script: './src/worker.js',
        watch: false,
        env_file: '.env'
      }
    ]
  };