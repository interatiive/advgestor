const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsear JSON e logar requisições
app.use(express.raw({ type: '*/*' }), (req, res, next) => {
  console.log('Cabeçalhos da requisição:', req.headers);
  if (req.body && req.body.length > 0) {
    const bodyString = req.body.toString();
    console.log('Corpo bruto da requisição recebido:', bodyString);
    if (req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(bodyString);
      } catch (error) {
        console.error('Erro ao parsear JSON:', error.message);
        return res.status(400).json({ error: 'JSON inválido: ' + error.message });
      }
    } else {
      console.log('Content-Type não é application/json:', req.headers['content-type']);
      return res.status(400).json({ error: 'Content-Type deve ser application/json' });
    }
  } else {
    console.log('Corpo bruto da requisição vazio.');
  }
  next();
});

app.use(cors());

// Endpoint para receber mensagens do Evolution API
app.post('/render', async (req, res) => {
  const message = req.body;
  console.log('Mensagem recebida do Evolution API:', message);

  try {
    const lawyerName = process.env.LAWYER_NAME?.toLowerCase();
    if (!lawyerName) {
      console.error('Variável de ambiente LAWYER_NAME não configurada.');
      return res.status(500).json({ error: 'Configuração do servidor incompleta' });
    }
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('Variável de ambiente WEBHOOK_URL não configurada.');
      return res.status(500).json({ error: 'Configuração do servidor incompleta' });
    }

    const messageBody = message.body ? message.body.toLowerCase() : '';
    const lawyerVariations = [
      lawyerName,
      `dr. ${lawyerName}`,
      `dr ${lawyerName}`,
      `doutor ${lawyerName}`,
      `dr.${lawyerName}`
    ];

    if (messageBody && lawyerVariations.some(variation => messageBody.includes(variation))) {
      console.log(`Mensagem com "${lawyerName}" detectada de ${message.from}`);

      // Enviar para o webhook
      const webhookResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactId: message.from,
          message: messageBody,
          instanceId: 'evolution-api'
        })
      });
      console.log('Webhook enviado:', webhookResponse.status);
    }

    res.status(200).json({ success: true, message: 'Mensagem processada' });
  } catch (error) {
    console.error('Erro ao processar mensagem:', error);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
