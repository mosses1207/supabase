import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import CryptoJS from "https://esm.sh/crypto-js@4.1.1"

function decryptData(ciphertext: string | null) {
  if (!ciphertext) return null;
  const decryptPass = Deno.env.get('DECRYPT_PASSWORD')
  if (!decryptPass) return ciphertext;
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, decryptPass);
    const originalText = bytes.toString(CryptoJS.enc.Utf8);
    if (!originalText) return null;
    try {
      return JSON.parse(originalText);
    } catch {
      return originalText;
    }
  } catch (e) {
    console.error("Gagal Dekripsi:", e);
    return null;
  }
}

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: rawRecords, error } = await supabase
      .from('path_history')
      .select('*')
      .ilike('status', 'active')
      .is('alert', null)

    if (error) return new Response(error.message, { status: 500 })
    if (!rawRecords || rawRecords.length === 0) return new Response("No data", { status: 200 })

    const now = new Date();

    for (const row of rawRecords) {
      // ✅ Fix: semua field didekripsi dengan benar
      const record = {
        ...row,
        sjkb: decryptData(row.sjkb),
        dest: decryptData(row.dest),
        arrive_target: decryptData(row.arrive_target),
        depart_at: decryptData(row.depart_at),  // ✅ Fix utama
        // status dibiarkan dari ...row (string biasa)
      };

      if (!record.arrive_target) continue;
      const targetTime = new Date(record.arrive_target);
      if (isNaN(targetTime.getTime())) continue;

      if (now > targetTime) {
        const departTime = record.depart_at
          ? new Date(record.depart_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          : 'N/A';

        const pesan = `
<b>⚠️ WARNING: OVERDUE ARRIVAL</b>
<b>Unit:</b> <code>${record.sjkb || 'N/A'}</code>
<b>Destinasi:</b> <code>${record.dest || 'N/A'}</code>
<b>Departure:</b> ${departTime}
<b>Target:</b> ${targetTime.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}
<b>Status:</b> Terlambat mencapai lokasi!
<i>Sistem Monitoring NVDC</i>
`.trim();

        // ✅ Fix: cek apakah Telegram berhasil sebelum update DB
        const tgRes = await fetch(
          `https://api.telegram.org/bot${Deno.env.get('TELEGRAM_BOT_TOKEN')}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: Deno.env.get('TELEGRAM_CHAT_ID'),
              text: pesan,
              parse_mode: 'HTML'
            })
          }
        );

        if (!tgRes.ok) {
          const errBody = await tgRes.text();
          console.error(`Telegram gagal untuk ID ${row.id}:`, errBody);
          continue; // ✅ Skip update DB kalau Telegram gagal
        }

        await supabase
          .from('path_history')
          .update({ alert: 'Alerted' })
          .eq('id', row.id);

        console.log(`Alert terkirim untuk ID: ${row.id}`);
      }
    }

    return new Response("Check completed", { status: 200 })
  } catch (e) {
    console.error(e);
    return new Response("Internal Error", { status: 500 })
  }
})
