import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MODEL_COLS = ['model1', 'model2', 'model3'];

async function getAvailableSlot() {
  const { data, error } = await supabase
    .from('apirole')
    .select('*');

  if (error || !data) throw new Error('Gagal baca table apirole');

  const sorted = data.sort((a, b) => a.key.localeCompare(b.key));

  for (const row of sorted) {
    for (const col of MODEL_COLS) {
      const slot = row[col];
      if (!slot) continue;
      if (slot.status === 'limit') continue;

      const apiKey = Deno.env.get(row.key);
      if (!apiKey) continue;

      return {
        key: row.key,
        apiKey,
        modelName: slot.models,
        modelCol: col,
      };
    }
  }

  return null;
}

async function markAsLimit(key: string, modelCol: string) {
  const { data: row } = await supabase
    .from('apirole')
    .select(modelCol)
    .eq('key', key)
    .single();

  if (!row) return;

  await supabase
    .from('apirole')
    .update({
      [modelCol]: { ...row[modelCol], status: 'limit' }
    })
    .eq('key', key);
}

async function prosesGemini(base64Images?: string | string[], rawTextFromOCR?: string) {
  // 1. Deklarasikan Prompt DULU di paling atas
  const promptText = `
Kamu adalah spesialis OCR dokumen logistik SJKB.
Tugas:
( prompt nanti di benerin selesai garap module kamera )
Output JSON:
{
( prompt outputjuga selesai garap module kamera)
}
`.trim();

  // 2. Susun "parts" berdasarkan apa yang dikirim
  const parts: any[] = [];

  if (base64Images) {
    // MODE SENJATA BERAT (GAMBAR)
    const images = Array.isArray(base64Images) ? base64Images : [base64Images];
    for (const img of images) {
      parts.push({
        inline_data: { mime_type: 'image/jpeg', data: img }
      });
    }
    parts.push({ text: `${promptText}\n\nEKSTRAK DARI GAMBAR DI ATAS.` });
  } else if (rawTextFromOCR) {
    // MODE HEMAT (TEXT ONLY)
    parts.push({ 
      text: `${promptText}\n\nDATA MENTAH OCR UNTUK DIPERBAIKI:\n"${rawTextFromOCR}"` 
    });
  } else {
    throw new Error('Tidak ada gambar atau teks yang dikirim.');
  }

  // 3. Masuk ke Loop Rotasi API Key (Slot)
  while (true) {
    const slot = await getAvailableSlot();
    if (!slot) throw new Error('Semua API key sudah limit');

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${slot.modelName}:generateContent?key=${slot.apiKey}`;

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      });

      if (res.status === 429 || res.status === 503) {
        console.warn(`Limit! ${slot.key}, ganti slot...`);
        await markAsLimit(slot.key, slot.modelCol);
        continue; 
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini error: ${err}`);
      }

      const data = await res.json();
      const rawResponse = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const clean = rawResponse.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);

    } catch (e) {
      throw e;
    }
  }
}

export { prosesGemini };
