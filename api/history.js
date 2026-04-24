import { MongoClient, ObjectId, ServerApiVersion } from 'mongodb';

const clientOptions = {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: false,
  },
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const client = await getClient();
    const db = client.db('samba');
    const col = db.collection('conversations');

    // GET — buscar conversa por ID ou listar por usuário
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
      const { action, conversation_id, user_name, messages } = body;

      if (action !== 'save' || !user_name || !messages) {
        return res.status(400).json({ error: 'Parâmetros inválidos' });
      }

      const now = new Date();

      if (conversation_id) {
        // Atualizar conversa existente
        await col.updateOne(
          { _id: new ObjectId(conversation_id) },
          { $set: { messages, updated_at: now } }
        );
        return res.status(200).json({ success: true, conversation_id });
      } else {
        // Criar nova conversa — título = primeira pergunta do usuário
        const firstUserMsg = messages.find(m => m.role === 'user')?.content || 'Nova conversa';
        const title = firstUserMsg.slice(0, 80) + (firstUserMsg.length > 80 ? '...' : '');
        const result = await col.insertOne({
          user_name,
          title,
          started_at: now,
          updated_at: now,
          messages
        });
        return res.status(200).json({ success: true, conversation_id: result.insertedId.toString() });
      }
    }

    return res.status(405).json({ error: 'Método não permitido' });

  } catch (err) {
    console.error('Erro em /api/history:', err);
    return res.status(500).json({ error: 'Erro interno', message: err.message });
  }
}
