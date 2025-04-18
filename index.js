const express = require('express');
const fetch = require('node-fetch');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const DATAJUD_API_KEY = process.env.DATAJUD_API_KEY;
const DATAJUD_TRIBUNAL = process.env.DATAJUD_TRIBUNAL || 'tjba';
const ADVOCATE_NAME = process.env.ADVOCATE_NAME;
const FETCH_TIMEOUT = 10_000;

// Controle de busca de publicações
let publicationCheck = {
  date: null,
  completed: false
};
let isCheckingPublications = false;

// Verificar variáveis de ambiente
console.log('Verificando variáveis de ambiente...');
if (!WEBHOOK_URL) throw new Error('WEBHOOK_URL não definida');
if (!DATAJUD_API_KEY) throw new Error('DATAJUD_API_KEY não definida');
if (!ADVOCATE_NAME) throw new Error('ADVOCATE_NAME não definida');
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
        console.log('Dados enviados com sucesso');
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

// Função para buscar publicações com paginação (data fixa: 2025-04-16)
async function fetchDatajudPublications() {
  if (isCheckingPublications) {
    console.log('Busca de publicações já em andamento, ignorando...');
    return [];
  }
  isCheckingPublications = true;

  // Verificar duplicatas
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
  const maxPages = 10; // Limite de segurança
  let page = 0;

  const endpoint = `https://api-publica.datajud.cnj.jus.br/api_publica_${DATAJUD_TRIBUNAL}/_search`;

  try {
    while (page < maxPages) {
      console.log(`Buscando página ${page + 1}...`);
      const requestBody = {
        query: {
          bool: {
            filter: [
              {
                range: {
                  dataPublicacao: {
                    gte: '2025-04-16',
                    lte: '2025-04-16'
                  }
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
        dataPublicacao: hit._source.dataPublicacao || '2025-04-16',
        grau: hit._source.grau || 'Desconhecido',
        classeProcessual: hit._source.classeProcessual?.nome || 'Desconhecida'
      }));

      allPublications.push(...publications);
      console.log(`Página ${page + 1}: ${publications.length} publicações`);

      if (publications.length < size) break; // Fim da paginação
      from += size;
      page++;
    }

    console.log(`Total de publicações encontradas: ${allPublications.length}`);

    // Enviar ao Make
    let allSent = true;
    for (const pub of allPublications) {
      const success = await sendToMake(pub);
      if (!success) {
        console.error(`Falha ao enviar publicação: ${JSON.stringify(pub)}`);
        allSent = false;
      }
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 segundos
    }

    // Marcar como concluído se todas foram enviadas
    if (allSent && allPublications.length > 0) {
      publicationCheck = { date: currentDate, completed: true };
    }

    return allPublications;
  } catch (error) {
    console.error('Erro ao buscar publicações:', error.message);
    return [];
  } finally {
    isCheckingPublications = false;
  }
}

// Rota de teste
app.get('/test-fetch-publications', async (req, res) => {
  console.log('Iniciando teste de busca de publicações no TJBA para 2025-04-16');
  try {
    const publications = await fetchDatajudPublications();
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

// Rota de ping
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Pong!');
});

// Inicia o servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
