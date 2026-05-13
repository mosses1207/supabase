import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.1.0"
import CryptoJS from "https://esm.sh/crypto-js@4.1.1"

serve(async (req) => {
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: records, error } = await supabase
    .from('path_history')
    .select('*')
    .is('ai_insight', null)
    .not('arrive_target', 'is', null)

  if (error) return new Response(error.message, { status: 500 })
  if (!records || records.length === 0) return new Response("No data", { status: 200 })

  const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY')!)
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

  for (const record of records) {
    try {
      const bytes = CryptoJS.AES.decrypt(record.arrive_target, Deno.env.get('DECRYPT_PASSWORD')!)
      const decryptedArrive = bytes.toString(CryptoJS.enc.Utf8)
      if (new Date() > new Date(decryptedArrive)) {
        const prompt = `Berikan insight singkat 1 kalimat untuk pengiriman ID ${record.id} yang telat.`
        const aiResponse = await model.generateContent(prompt)
        const insight = aiResponse.response.text()

        await supabase.from('path_history').update({ ai_insight: insight }).eq('id', record.id)

        await fetch(`https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: Deno.env.get('TELEGRAM_CHAT_ID'),
            text: `🚚 *NVDC ALERT*\nInsight: ${insight}`,
            parse_mode: 'Markdown'
          })
        })
      }
    } catch (e) { console.error(e) }
  }
  return new Response("Done", { status: 200 })
})
