const MAX_JOB_CHARS = 12_000;
const MAX_CANDIDATE_CHARS = 5_000;
const CODE_PATTERN = /^[A-Z0-9-]{4,40}$/;

async function callCredit(baseUrl, secretKey, functionName, code) {
  const res = await fetch(`${baseUrl}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: secretKey,
    },
    body: JSON.stringify({ p_code: code }),
  });
  if (!res.ok) throw new Error(`SUPABASE_${res.status}`);
  const value = await res.json().catch(() => null);
  return typeof value === "number" ? value : null;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Cette adresse accepte uniquement une demande de génération." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;
  if (!apiKey || !supabaseUrl || !supabaseKey) {
    return response.status(503).json({ error: "Le site n’est pas encore entièrement configuré. Réessaie plus tard." });
  }

  const { job, candidate, code } = request.body || {};
  if (typeof job !== "string" || typeof candidate !== "string" || typeof code !== "string") {
    return response.status(400).json({ error: "Remplis les trois champs avant de générer la lettre." });
  }

  const cleanCode = code.trim().toUpperCase();
  if (!CODE_PATTERN.test(cleanCode)) {
    return response.status(403).json({ error: "Code d’accès invalide. Vérifie-le ou écris-nous sur WhatsApp." });
  }

  const cleanJob = job.trim();
  const cleanCandidate = candidate.trim();
  if (cleanJob.length < 40 || cleanCandidate.length < 20) {
    return response.status(400).json({ error: "Ajoute quelques détails de plus dans les deux champs." });
  }
  if (cleanJob.length > MAX_JOB_CHARS || cleanCandidate.length > MAX_CANDIDATE_CHARS) {
    return response.status(413).json({ error: "Le texte est trop long. Raccourcis-le puis réessaie." });
  }

  // 1. On retire un crédit avant de lancer l'IA.
  let creditsLeft;
  try {
    creditsLeft = await callCredit(supabaseUrl, supabaseKey, "use_credit", cleanCode);
  } catch (error) {
    console.error("Supabase use_credit failed", error?.message || "ERROR");
    return response.status(503).json({ error: "Vérification du code impossible pour le moment. Réessaie dans un instant." });
  }
  if (creditsLeft === null) {
    return response.status(403).json({ error: "Code invalide ou déjà épuisé. Écris-nous sur WhatsApp pour un nouveau pack." });
  }

  const refund = async () => {
    try {
      await callCredit(supabaseUrl, supabaseKey, "refund_credit", cleanCode);
    } catch (error) {
      console.error("Supabase refund_credit failed", error?.message || "ERROR");
    }
  };

  const input = [
    "Tu es un conseiller en rédaction de candidatures de stage en français.",
    "Rédige une lettre de motivation courte, naturelle et adaptée à l’offre ci-dessous.",
    "Appuie-toi uniquement sur les éléments du parcours fournis : n’invente jamais de diplôme, d’expérience, de compétence ou de résultat.",
    "Quand une information manque, écris [à compléter] au lieu de la deviner.",
    "Fais environ 220 à 300 mots, avec une formule d’appel, trois paragraphes utiles et une formule de politesse.",
    "Ne donne aucune explication avant ou après la lettre.",
    "\nOFFRE DE STAGE :\n" + cleanJob,
    "\nPARCOURS DU CANDIDAT :\n" + cleanCandidate,
  ].join("\n\n");

  try {
    const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model: "gemini-3.5-flash-lite",
        input,
        store: false,
      }),
    });

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error("Gemini API request failed", upstream.status, payload.error?.status || "API_ERROR");
      await refund();
      return response.status(502).json({ error: "Le service d’IA n’a pas répondu correctement. Ton crédit t’a été rendu, réessaie plus tard." });
    }

    const letter = (payload.steps || [])
      .filter((step) => step.type === "model_output")
      .flatMap((step) => step.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim();

    if (!letter) {
      await refund();
      return response.status(502).json({ error: "L’IA a renvoyé une réponse vide. Ton crédit t’a été rendu, réessaie." });
    }
    return response.status(200).json({ letter, creditsLeft });
  } catch (error) {
    console.error("Gemini API connection failed", error?.name || "NETWORK_ERROR");
    await refund();
    return response.status(502).json({ error: "Connexion à l’IA impossible pour le moment. Ton crédit t’a été rendu, réessaie plus tard." });
  }
}
