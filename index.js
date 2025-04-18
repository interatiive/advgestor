const express = require('express');
const fetch = require('node-fetch');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjba';
const ADVOCATE_NAME = process.env.ADVOCATE_NAME;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const FETCH_TIMEOUT = 10_000;
const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000; // 14 minutos
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || `https://advgestor.onrender.com/ping`;

// Controle de busca de publicações
let publicationCheck = { date: null, completed: false };
let isCheckingPublications = false;

// Manipulação de SIGTERM
let server;
process.on('SIGTERM', () => {
  console.log('Recebido SIGTERM. Encerrando servidor...');
  if (server) {
    server.close(() => {
      console.log('Servidor encerrado com sucesso');
      process.exit(0);
    });
  } else {
    console.log('Nenhum servidor ativo para encerrar');
    process.exit(0);
  }
});

// Verificar variáveis de ambiente
console.log('Verificando variáveis de ambiente...');
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL não definida');
if (!DATAJUD_API_KEY) throw new Error('DATAJUD_API_KEY não definida');
if (!ADVOCATE_NAME) throw new Error('ADVOCATE_NAME não definida');
if (!EVOLUTION_API_URL) throw new Error('EVOLUTION_API_URL não definida');
if (!EVOLUTION_API_KEY) throw new Error('EVOLUTION_API_KEY não definida');
console.log('Variáveis de ambiente OK');

// Middleware
app.use(express.json());

// Função para enviar dados ao Make
async function sendToMake(data) {
  console.log('Enviando ao Make:', data);
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        timeout: FETCH_TIMEOUT,
      });
      if (response.ok) {
        console.log('Dados enviados ao Make com sucesso');
        return true;
      }
      console.error(`Erro no Make: Status ${response.status}`);
      throw new Error(`Status ${response.status}`);
    } catch (error) {
      retries--;
      console.error(`Erro ao enviar ao Make (tentativa ${4 - retries}/3):`, error.message);
      if (retries === 0) return false;
      await new Promise(resolve => setTimeout(resolve, 2000 * (3 - retries)));
    }
  }
  return false;
}

// Função para classificar tipo de publicação
function classifyPublicationType(movement) {
  if (!movement) return 'Outros';
  movement = movement.toLowerCase();
  if (movement.includes('intima')) return 'Intimação';
  if (movement.includes('despacho')) return 'Despacho';
  if (movement.includes('decis')) return 'Decisão';
  if (movement.includes('sentença')) return 'Sentença';
  return 'Outros';
}

// Função para buscar publicações com paginação
async function fetchDatajudPublications(dateRange = { gte: 'now/d', lte: 'now/d' }) {
  if (isCheckingPublications) {
    console.log('Busca de publicações já em andamento, ignorando...');
    return [];
  }
  isCheckingPublications = true;

  const currentDate = new Date().toISOString().split('T')[0];
  if (publicationCheck.date !== currentDate) {
    publicationCheck = { date: null, completed: false }; // Reset ao mudar de dia
  }
  if (publicationCheck.completed) {
    console.log('Publicações já enviadas hoje, ignorando busca');
    isCheckingPublications = false;
    return [];
  }

  let allPublications = [];
  let from = 0;
  const size = 10;
  const maxPages = 10;

  const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;

  try {
    while (from < maxPages * size) {
      console.log(`Buscando página ${(from / size) + 1} para data ${dateRange.gte}...`);
      const requestBody = {
        query: {
          bool: {
            filter: [
              {
                range: {
                  dataPublicacao: dateRange
                }
              }
            ],
            must: [
              {
                query_string: {
                  query: `"${ADVOCATE_NAME}"`,
                  fields: ['textoPublicacao']
                }
              }
            ]
          }
        },
        from,
        size,
        _source: ['id', 'orgaoJulgador.nome', 'movimentos.nome', 'dataPublicacao', 'grau', 'classeProcessual.nome']
      };

      const response = await axios.post(endpoint, requestBody, {
        headers: {
          'Authorization': `APIKey ${DATAJUD_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: FETCH_TIMEOUT
      });

      if (response.status !== 200) {
        console.error(`Erro na API do Datajud: Status ${response.status}`);
        break;
      }

      const publications = response.data.hits.hits.map(hit => ({
        numeroProcesso: hit._source.id || 'Desconhecido',
        tipoPublicacao: classifyPublicationType(hit._source.movimentos?.nome),
        orgaoJulgador: hit._source.orgaoJulgador?.nome || 'Desconhecido',
        dataPublicacao: hit._source.dataPublicacao || dateRange.gte,
        grau: hit._source.grau || 'Desconhecido',
        classeProcessual: hit._source.classeProcessual?.nome || 'Desconhecida'
      }));

      allPublications.push(...publications);
      console.log(`Página ${(from / size) + 1}: ${publications.length} publicações`);

      if (publications.length < size) break;
      from += size;
    }

    console.log(`Total de publicações encontradas: ${allPublications.length}`);

    let allSent = true;
    for (const pub of allPublications) {
      const success = await sendToMake(pub);
      if (!success) {
        console.error(`Falha ao enviar publicação: ${JSON.stringify(pub)}`);
        allSent = false;
      }
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
    }

    if (allSent && allPublications.length > 0) {
      publicationCheck = { date: currentDate, completed: true };
      console.log('Busca concluída com sucesso, publicationCheck atualizado:', publicationCheck);
    }

    return allPublications;
  } catch (error) {
    console.error('Erro ao buscar publicações:', error.message);
    return [];
  } finally {
    isCheckingPublications = false;
  }
}

// Rota de teste para Datajud
app.get('/test-fetch-publications', async (req, res) => {
  console.log('Iniciando teste de busca de publicações no TJBA para 2025-04-16');
  try {
    const publications = await fetchDatajudPublications({ gte: '2025-04-16', lte: '2025-04-16' });
    res.status(200).json({
      message: `Encontradas ${publications.length} publicações para 2025-04-16`,
      publications,
      sentToMake: publicationCheck.completed
    });
  } catch (error) {
    console.error('Erro no teste:', error.message);
    res.status(500).json({ error: 'Erro ao buscar publicações' });
  }
});

// Rota para obter QR code do WhatsApp via Evolution API
app.get('/qrcode', async (req, res) => {
  console.log('Solicitando QR code da Evolution API...');
  try {
    const response = await axios.get(`${EVOLUTION_API_URL}/instance/connect`, {
      headers: { 'apikey': EVOLUTION_API_KEY }
    });
    console.log('QR code obtido com sucesso');
    res.json({ qrcode: response.data.qrcode });
  } catch (error) {
    console.error('Erro ao obter QR code:', error.message);
    res.status(500).json({ error: 'Erro ao obter QR code' });
  }
});

// Rota para enviar mensagem via WhatsApp
app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ error: 'Número e mensagem são obrigatórios' });
  }
  console.log(`Enviando mensagem para ${number}: ${message}`);
  try {
    await axios.post(`${EVOLUTION_API_URL}/message/sendText`, {
      number: `${number}@s.whatsapp.net`,
      text: message
    }, {
      headers: { 'apikey': EVOLUTION_API_KEY }
    });
    console.log('Mensagem enviada com sucesso');
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Pong!');
});

// Agendamento: 8h, segunda a sexta, para data atual
cron.schedule('0 8 * * 1-5', async () => {
  console.log('Iniciando busca automática às 8h (America/Sao_Paulo)');
  try {
    const publications = await fetchDatajudPublications({ gte: 'now/d', lte: 'now/d' });
    console.log(`Busca automática concluída: ${publications.length} publicações encontradas`);
  } catch (error) {
    console.error('Erro na busca automática:', error.message);
  }
}, { timezone: 'America/Sao_Paulo' });

// Keep-alive
setInterval(async () => {
  console.log('Enviando keep-alive para', KEEP_ALIVE_URL);
  try {
    const response = await fetch(KEEP_ALIVE_URL, { timeout: FETCH_TIMEOUT });
    console.log(`Keep-alive resposta: ${response.status}`);
  } catch (error) {
    console.error('Erro no keep-alive:', error.message);
  }
}, KEEP_ALIVE_INTERVAL);

// Inicia o servidor
server = app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
