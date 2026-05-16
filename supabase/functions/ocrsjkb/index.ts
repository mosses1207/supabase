import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { prosesGemini } from "../_shared/geminiRole.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // ✅ Handle preflight OPTIONS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { base64Images, rawTextFromOCR } = await req.json();
    const result = await prosesGemini(base64Images, rawTextFromOCR);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders, // ✅ CORS headers ikut di response utama
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders, // ✅ Jangan lupa di error response juga
      },
    });
  }
});
