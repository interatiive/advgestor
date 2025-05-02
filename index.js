const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 3000;
const INSTANCE_ID = 'cliente1';
const WEBHOOK_URL = 'https://hook.us1.make.com/replace_with_your_make_webhook_url'; // Replace with your actual Make webhook URL

// Middleware to parse raw body and log request details
app.use(express.raw({ type: '*/*' }), (req, res, next) => {
  console.log(`[${INSTANCE_ID}] Request headers:`, req.headers);
  if (req.body && req.body.length > 0) {
    const bodyString = req.body.toString();
    console.log(`[${INSTANCE_ID}] Raw request body received:`, bodyString);
    if (req.headers['content-type']?.includes('application/json')) {
      try {
        req.body = JSON.parse(bodyString);
      } catch (error) {
        console.error(`[${INSTANCE_ID}] Error parsing JSON:`, error.message);
        return res.status(400).json({ error: 'Invalid JSON: ' + error.message });
      }
    } else {
      console.log(`[${INSTANCE_ID}] Content-Type is not application/json:`, req.headers['content-type']);
      return res.status(400).json({ error: 'Content-Type must be application/json' });
    }
  } else {
    console.log(`[${INSTANCE_ID}] Raw request body is empty.`);
  }
  next();
});

app.use(cors());

// Ping endpoint to keep Render active
app.get('/', (req, res) => {
  console.log(`[${INSTANCE_ID}] Ping request received at /`, { ip: req.ip, timestamp: new Date().toISOString() });
  res.json({ message: `Server running (instance: ${INSTANCE_ID})` });
});

// Endpoint to receive messages from Evolution API
app.post('/receive', async (req, res) => {
  console.log(`[${INSTANCE_ID}] Request received at /receive. Body:`, req.body);

  try {
    const messageData = req.body;
    if (!messageData || !messageData.message || !messageData.from) {
      console.log(`[${INSTANCE_ID}] Invalid request format:`, req.body);
      return res.status(400).json({ error: 'Invalid request format: message and from fields are required' });
    }

    const messageBody = messageData.message.toLowerCase();
    const advocateVariations = ['dr. advogado', 'dr advogado', 'doutor advogado', 'dr.advogado']; // Adjust variations as needed
    const matchesAdvocate = advocateVariations.some(variation => messageBody.includes(variation));

    if (matchesAdvocate) {
      console.log(`[${INSTANCE_ID}] Message with advocate name detected from ${messageData.from}`);
      try {
        const response = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contactId: messageData.from,
            message: messageData.message,
            instanceId: INSTANCE_ID
          })
        });
        console.log(`[${INSTANCE_ID}] Webhook sent:`, response.status);
        return res.status(200).json({ success: true, message: 'Message forwarded to webhook' });
      } catch (error) {
        console.error(`[${INSTANCE_ID}] Error sending webhook:`, error);
        return res.status(500).json({ error: 'Error sending webhook' });
      }
    } else {
      console.log(`[${INSTANCE_ID}] Message does not contain advocate name.`);
      return res.status(200).json({ success: true, message: 'Message ignored (no advocate name)' });
    }
  } catch (error) {
    console.error(`[${INSTANCE_ID}] Error processing request:`, error);
    return res.status(500).json({ error: 'Error processing request' });
  }
});

app.listen(PORT, () => {
  console.log(`[${INSTANCE_ID}] Server running on port ${PORT}`);
});
