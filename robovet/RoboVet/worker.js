// ============================================================================
// 🌍 RoboVet: The Uncrashable Universal Ark
// Strategy: Gemini -> Failover -> Groq -> Failover -> Hugging Face -> Failover -> Safe Message
// ============================================================================

const SYSTEM_PROMPT = `
You are RoboVet, the Universal Veterinary Intelligence Assistant by DaScient LLC.

### MISSION
You are an expert on **ALL ANIMAL LIFE**—from domestic pets (dogs/cats) to exotics (reptiles, birds, invertebrates), livestock, and wildlife. Your goal is to provide the most comprehensive, up-to-date, and researched veterinary triage data available.

### PROTOCOL: "UNIVERSAL TRIAGE"
For every inquiry, follow this logic:

1. 🚨 SPECIES-SPECIFIC THREAT DETECTION
   - Bleach/Toxins: FATAL to all species (Tarantulas, Giraffes, etc.).
   - Respiratory Distress: "Not breathing" or "Gasping" is ALWAYS a Code Red.
   - **Action:** If *any* life-threatening sign is present, STOP. Reply: "🚨 **CRITICAL EMERGENCY** 🚨 [Species] is in immediate danger. Go to an emergency vet/specialist now."

2. 🧬 UNIVERSAL SIGNALMENT
   If species is unknown, ask. (e.g., "Is this a dog, a parrot, or a gecko?").
   - Vital Context: A "cold" dog is fine; a "cold" lizard is dying. Adjust your logic to the biology of the specific animal.

3. 🧠 "DEEP DIVE" ANALYSIS (The "Profound" Layer)
   - **Standard Care:** Provide the most accepted veterinary advice (Merck/AVMA).
   - **"The Zebra" (Out-reaching Possibilities):** If the case is odd, look for rare but profound possibilities. (e.g., "Could this behavioral change be environmental enrichment failure? Or a rare nutritional deficiency?").
   - **Research:** Check for species-specific husbandry errors (lighting for reptiles, diet for birds) as these cause 90% of exotic illness.

4. 🛡️ RESPONSE STRUCTURE
   - **Triage Status:** [Emergency / Urgent / Monitor]
   - **The Likely Cause:** (Most common explanation)
   - **"Out-of-the-Box" Possibilities:** (Rare/Complex factors to consider)
   - **Immediate Steps:** (Safe, species-appropriate actions)
   - **Disclaimer:** "I am an AI. Exotics require specialists. This is educational."

### TONE
Highly intelligent, biologically fluent, and open-minded. Never refuse a species. If a user asks about a Giraffe, answer with Giraffe-grade medical knowledge.
`;

export default {
  async fetch(request, env) {
    // 1. HANDLE PREFLIGHT (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }

    // 2. MAIN ROUTING
    try {
      if (request.method === "POST") {
        return await handleWaterfall(request, env);
      }
      return new Response(JSON.stringify({ status: "RoboVet Systems Operational 🟢" }), { 
        status: 200, 
        headers: cors() 
      });
    } catch (e) {
      // 3. ULTIMATE SAFETY NET (Prevents 500 crashes)
      return sendFailSafeResponse("⚠️ System Error: Please check your internet connection and try again.");
    }
  }
};

/**
 * The Waterfall Logic: Tries providers in order of intelligence/speed.
 */
async function handleWaterfall(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return sendFailSafeResponse("Error: Invalid Request Format.");
  }
  
  const messages = payload.messages || [];
  
  // --- TIER 1: GOOGLE GEMINI (Primary Intelligence) ---
  if (env.GEMINI_API_KEY) {
    try {
      // Using gemini-1.5-flash as the standard robust model
      return await callGemini(messages, env.GEMINI_API_KEY, "gemini-1.5-flash");
    } catch (e) {
      console.warn(`⚠️ Gemini Failed: ${e.message}. Failing over to Groq...`);
    }
  }

  // --- TIER 2: GROQ CLOUD (Speed/Backup) ---
  if (env.GROQ_API_KEY) {
    try {
      return await callGroq(messages, env.GROQ_API_KEY);
    } catch (e) {
      console.warn(`⚠️ Groq Failed: ${e.message}. Failing over to HuggingFace...`);
    }
  }

  // --- TIER 3: HUGGING FACE (Last Resort) ---
  if (env.HF_API_TOKEN) {
    try {
      return await callHuggingFace(messages, env.HF_API_TOKEN);
    } catch (e) {
      console.error(`⚠️ HF Failed: ${e.message}.`);
    }
  }

  // --- TIER 4: POLITE APOLOGY (No Crash) ---
  return sendOneShotStream(
    "⚠️ **High Traffic Alert**\n\nAll of my AI engines are currently busy responding to other cases. Please wait 30 seconds and try asking again!", 
    "system-backup"
  );
}

// ---------------------------------------------------------
// PROVIDER ADAPTERS
// ---------------------------------------------------------

async function callGemini(messages, key, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  
  // Format messages for Gemini
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }]
  }));
  
  // Prepend System Prompt to the first user message (Best way for Gemini REST API)
  if (contents.length > 0 && contents[0].role === "user") {
    contents[0].parts[0].text = SYSTEM_PROMPT + "\n\n[USER INQUIRY]:\n" + contents[0].parts[0].text;
  } else {
    // If conversation history implies the first msg isn't user, force a system entry
    contents.unshift({ role: "user", parts: [{ text: SYSTEM_PROMPT }] });
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents })
  });

  if (!resp.ok) throw new Error(`Gemini Error ${resp.status}: ${await resp.text()}`);
  
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "System Error: No response text.";
  
  return sendOneShotStream(text, model);
}

async function callGroq(messages, key) {
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile", // Powerful, fast open source model
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ]
    })
  });

  if (!resp.ok) throw new Error(`Groq Error ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  
  return sendOneShotStream(text, "llama-3.3-70b");
}

async function callHuggingFace(messages, key) {
  // Hugging Face inference API is often just a text completions endpoint
  const lastUserMsg = messages[messages.length - 1].content;
  const fullPrompt = `${SYSTEM_PROMPT}\n\nUser: ${lastUserMsg}\nAssistant:`;

  const resp = await fetch("https://router.huggingface.co/models/Qwen/Qwen2.5-7B-Instruct", {
    method: "POST",
    headers: { 
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      inputs: fullPrompt, 
      parameters: { max_new_tokens: 600, return_full_text: false }
    })
  });

  if (!resp.ok) throw new Error(`HF Error ${resp.status}`);
  const data = await resp.json();
  // HF usually returns an array [{ generated_text: "..." }]
  const text = Array.isArray(data) ? data[0].generated_text : "Error parsing HF response";
  
  return sendOneShotStream(text, "qwen-2.5");
}

// ---------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------

// Sends a single chunk formatted as an OpenAI Stream (for compatibility)
function sendOneShotStream(fullText, modelName) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const id = "chatcmpl-" + Date.now();
    const timestamp = Math.floor(Date.now() / 1000);
    
    // 1. Send the content
    const chunk = {
      id, object: "chat.completion.chunk", created: timestamp, model: modelName,
      choices: [{ index: 0, delta: { role: "assistant", content: fullText }, finish_reason: null }]
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    
    // 2. Send the stop signal
    const stop = {
      id, object: "chat.completion.chunk", created: timestamp, model: modelName,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(stop)}\n\n`));
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close();
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...cors()
    }
  });
}

// Non-streaming fallback that still formats as a stream for the frontend
function sendFailSafeResponse(message) {
  return sendOneShotStream(message, "system-error-handler");
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json"
  };
}
