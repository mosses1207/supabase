import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { prosesGemini } from "../_shared/geminiRole.ts";

serve(async (req) => {
  const { base64Images } = await req.json();
  const result = await prosesGemini(base64Images);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
});
