import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';

const clientOptions = {
  serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: false },
  tls: true,
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
};

let cachedClient = null;

async function getClient() {
  if (cachedClient?.topology?.isConnected()) return cachedClient;
  cachedClient = null;
  const client = new MongoClient(process.env.MONGODB_URI, clientOptions);
  await client.connect();
  cachedClient = client;
  return client;
}

async function extractContactInfo(messages) {
  const textSample = messages
    .map(m => `${m.role === 'user' ? 'Usuário' : 'IA'}: ${m.content}`)
    .join('\n')
    .slice(0, 4000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Analise esta conversa e retorne SOMENTE um JSON:
{"contact_name": "nome do lead/contato/pessoa mencionada em qualquer idioma (não o nome do funcionário da Samba), ou null se não encontrado", "follow_up_date": "data de follow-up/próximo contato no formato YYYY-MM-DD, ou null", "status": "ok se a conversa indica que foi resolvido/feito/concluído/done, senão pending"}

Conversa:
${textSample}

JSON:`
        }]
      })
    });
    const data = await res.json();
    const raw = data?.content?.[0]?.text || '{}';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { contact_name: null, follow_up_date: null, status: 'pending' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = await getClient();
    const db = client.db('samba');
    const col = db.collection('conversations');

    // GET — buscar por ID ou listar por usuário
    if (req.method === 'GET') {
      const { user, id } = req.query;

      if (id) {
        const conv = await col.findOne({ _id: new ObjectId(id) });
        if (!conv) return res.status(404).json({ error: 'Conversa não encontrada' });
        return res.status(200).json(conv);
      }

      if (user) {
        const convs = await col
          .find({ user_name: user }, { projection: { messages: 0 } })
          .sort({ updated_at: -1 })
          .limit(30)
          .toArray();
        return res.status(200).json(convs);
      }

      return res.status(400).json({ error: 'Parâmetro user ou id obrigatório' });
    }

    // POST — criar ou atualizar conversa
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { action, conversation_id, user_name, messages, force_status } = body;

      if (action !== 'save' || !user_name || !messages) {
        return res.status(400).json({ error: 'Parâmetros inválidos' });
      }

      const now = new Date();

      if (conversation_id) {
        const existing = await col.findOne(
          { _id: new ObjectId(conversation_id) },
          { projection: { contact_name: 1, status: 1 } }
        );
        const updateFields = { messages, updated_at: now };

        if (force_status) {
          updateFields.status = force_status;
        } else {
          const needsExtraction = !existing?.contact_name || existing?.status === 'pending';
          if (needsExtraction) {
            const extracted = await extractContactInfo(messages);
            if (extracted.contact_name) updateFields.contact_name = extracted.contact_name;
            if (extracted.follow_up_date) updateFields.follow_up_date = extracted.follow_up_date;
            if (extracted.status === 'ok') updateFields.status = 'ok';
          }
        }

        await col.updateOne({ _id: new ObjectId(conversation_id) }, { $set: updateFields });
        return res.status(200).json({ success: true, conversation_id });

      } else {
        const firstUserMsg = messages.find(m => m.role === 'user')?.content || 'Nova conversa';
        const title = firstUserMsg.slice(0, 80) + (firstUserMsg.length > 80 ? '...' : '');
        const extracted = await extractContactInfo(messages);

        const result = await col.insertOne({
          user_name,
          title,
          contact_name: extracted.contact_name || null,
          follow_up_date: extracted.follow_up_date || null,
          status: force_status || extracted.status || 'pending',
          started_at: now,
          updated_at: now,
          messages
        });
        return res.status(200).json({ success: true, conversation_id: result.insertedId.toString() });
      }
    }

    // PATCH — atualizar nome, data ou status manualmente
    if (req.method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { id, contact_name, follow_up_date, status } = body;

      if (!id) return res.status(400).json({ error: 'id obrigatório' });

      const updateFields = { updated_at: new Date() };
      if (contact_name !== undefined) updateFields.contact_name = contact_name || null;
      if (follow_up_date !== undefined) updateFields.follow_up_date = follow_up_date || null;
      if (status !== undefined) updateFields.status = status;

      await col.updateOne({ _id: new ObjectId(id) }, { $set: updateFields });
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método não permitido' });

  } catch (err) {
    console.error('Erro em /api/history:', err);
    return res.status(500).json({ error: 'Erro interno', message: err.message });
  }
}
