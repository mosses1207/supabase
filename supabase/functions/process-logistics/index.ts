import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { GoogleGenerativeAI } from "https://esm.sh/@google/generative-ai@0.1.0"
import CryptoJS from "https://esm.sh/crypto-js@4.1.1"

serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Cek data yang ai_insight-nya masih KOSONG supaya tidak spam notif
  const { data: records, error } = await supabase
    .from('path_history')
    .select('*')
    .is('ai_insight', null) // Filter agar hanya memproses yang belum punya insight
    .not('arrive_target', 'is', null)

  if (error) return new Response(error.message, { status: 500 })
  if (!records || records.length === 0) return new Response("No pending data", { status: 200 })

  const genAI = new GoogleGenerativeAI(Deno.env.get('GEMINI_API_KEY')!)
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

  for (const record of records) {
    try {
      // 2. Dekripsi arrive_target
      const bytes = CryptoJS.AES.decrypt(record.arrive_target, Deno.env.get('DECRYPT_PASSWORD')!)
      const decryptedArrive = bytes.toString(CryptoJS.enc.Utf8)
      
      const targetTime = new Date(decryptedArrive).getTime()
      const now = new Date().getTime()

      // 3. Cek apakah waktu saat ini sudah melebihi target
      if (now > targetTime) {
        // 4. Generate AI Insight
        const prompt = `Berikan analisis singkat 1 kalimat untuk pengiriman ID ${record.id} yang telat sampai target ${decryptedArrive}.`
        const aiResponse = await model.generateContent(prompt)
        const insight = aiResponse.response.text()

        // 5. Simpan insight ke kolom ai_insight
        const { error: updateError } = await supabase
          .from('path_history')
          .update({ ai_insight: insight }) // Update ke kolom ai_insight
          .eq('id', record.id)

        if (updateError) throw updateError

        // 6. Kirim ke Telegram
        await fetch(`https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN')}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: Deno.env.get('TELEGRAM_CHAT_ID'),
            text: `🚚 *NVDC SYSTEM ALERT*\n\n*ID:* ${record.id}\n*Insight AI:* ${insight}`,
            parse_mode: 'Markdown'
          })
        })
      }
    } catch (err) {
      console.error("Gagal proses record:", record.id, err)
    }
  }

  return new Response("Processed successfully", { status: 200 })
})
