const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// Manipulação de SIGTERM
process.on('SIGTERM', () => {
  console.log('Recebido SIGTERM. Encerrando servidor...');
  app.close(() => {
    console.log('Servidor encerrado com sucesso');
    process.exit(0);
  });
});

console.log('Iniciando servidor...');

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Pong!');
});

// Inicia o servidor
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
