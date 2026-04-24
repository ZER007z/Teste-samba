export default async function handler(req, res) {
  // Permitir apenas POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // 🔥 Garante que o body vem certo (Vercel às vezes manda string)
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body;

    // 🔥 Validação básica
    if (!body || !body.messages) {
      return res.status(400).json({
        error: "Body inválido. 'messages' é obrigatório."
      });
    }

    // 🔥 Chamada para Anthropic
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    // 🔥 Pega resposta bruta
    const data = await response.json();

    // 🔴 Se a API retornou erro, repassa corretamente
    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Erro na API da Anthropic",
        full: data
      });
    }

    // 🔥 Extrai texto da resposta (garante compatibilidade)
    const text =
      data?.content?.map(c => c.text).join("") ||
      "Sem resposta da IA";

    // ✅ Retorna padrão simplificado pro frontend
    return res.status(200).json({
      success: true,
      text,
      raw: data
    });

  } catch (err) {
    console.error("Erro no backend:", err);

    return res.status(500).json({
      error: "Erro interno no servidor",
      message: err.message
    });
  }
}
