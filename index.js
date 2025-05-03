const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Regex de palavras-chave (case insensitive)
const palavraChaveRegex = new RegExp(process.env.PALAVRA_CHAVE, 'i');

app.post('/', async (req, res) => {
  const textoRecebido = JSON.stringify(req.body);

  if (palavraChaveRegex.test(textoRecebido)) {
    try {
      await axios.post(process.env.MAKE_WEBHOOK_URL, req.body);
      return res.status(200).send('Mensagem encaminhada ao Make.');
    } catch (err) {
      console.error('Erro ao encaminhar para o Make:', err.message);
      return res.status(500).send('Erro ao encaminhar ao Make.');
    }
  }

  res.status(200).send('Mensagem ignorada.');
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
