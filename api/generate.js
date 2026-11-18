const MAX_JOB_CHARS = 12_000;
const MAX_CANDIDATE_CHARS = 5_000;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Cette adresse accepte uniquement une demande de génération." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "La clé de l’IA n’est pas encore configurée sur le site." });
  }

  const { job, candidate } = request.body || {};
  if (typeof job !== "string" || typeof candidate !== "string") {
    return response.status(400).json({ error: "Remplis les deux champs avant de générer la lettre." });
  }

  const cleanJob = job.trim();
  const cleanCandidate = candidate.trim();
  if (cleanJob.length < 40 || cleanCandidate.length < 20) {
    return response.status(400).json({ error: "Ajoute quelques détails de plus dans les deux champs." });
  }
  if (cleanJob.length > MAX_JOB_CHARS || cleanCandidate.length > MAX_CANDIDATE_CHARS) {
    return response.status(413).json({ error: "Le texte est trop long. Raccourcis-le puis réessaie." });
  }

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
      return response.status(502).json({ error: "Le service d’IA n’a pas répondu correctement. Réessaie plus tard." });
    }

    const letter = (payload.steps || [])
      .filter((step) => step.type === "model_output")
      .flatMap((step) => step.content || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("\n")
      .trim();

    if (!letter) {
      return response.status(502).json({ error: "L’IA a renvoyé une réponse vide. Réessaie." });
    }
    return response.status(200).json({ letter });
  } catch (error) {
    console.error("Gemini API connection failed", error?.name || "NETWORK_ERROR");
    return response.status(502).json({ error: "Connexion à l’IA impossible pour le moment. Réessaie plus tard." });
  }
}
