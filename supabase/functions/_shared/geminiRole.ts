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

async function prosesGemini(base64Images?: string | string[]) {
  // ✅ Fix 1: promptText dideklarasi DULU sebelum dipakai
  const promptText = `
Kamu adalah spesialis OCR dokumen logistik SJKB.
Tugas:
1. Ekstrak "no_sjkb" format: NVDC[AREA]/[ANGKA]/[ANGKA]/[ANGKA] (Tanpa Spasi) total 24 karakter.
2. Ekstrak "tujuan" (Nama Dealer/Lokasi).
Logika No SJKB:
- Area WAJIB salah satu dari: NVDCCIB, NVDCSTR, atau NVDCKRW.
- Gunakan akhiran untuk koreksi: ...CIB = NVDCCIB, ...STR = NVDCSTR, ...KRW = NVDCKRW.
- No SJKB harus memiliki 3 buah tanda garis miring (/). Jika kurang, periksa kembali pembacaan karakter.
- Gunakan 3 karakter terakhir nomer sjkb dari salah satu : /SD , /SC , /U1, /U2, /U3, /U4, /U5, /U6, /ST Jika tidak, periksa kembali pembacaan karakter.
- Tidak ada karakter -, jika ada periksa kembali, kemungkinan jika -1 adalah angka 4
Logika Tujuan:
- Cari teks setelah label "Tujuan :" atau "juan : " atau "an :" " atau "n :". Contoh: "Astrido Toyota Tangerang".
- Jika label tidak ada, ambil baris teks tepat di bawah tulisan "NVDC CIBITUNG", "NVDC SUNTER", atau "NVDC KARAWANG".
Aturan Ketat:
- Perbaiki typo OCR: O jadi 0, I/L jadi 1 pada bagian angka.
- Dilarang menambah teks penjelasan di luar JSON.
- Jika data tidak ditemukan, isi dengan null.
Output JSON:
{
  "success": true,
  "no_sjkb": "...",
  "tujuan": "..."
}
`.trim();

  // ✅ Fix 2: parts cukup satu kali, pakai array images
  const parts: any[] = [];

  if (base64Images) {
    const images = Array.isArray(base64Images) ? base64Images : [base64Images];
    for (const img of images) {
      parts.push({
        inline_data: {
          mime_type: 'image/jpeg',
          data: img,
        }
      });
    }
  }

  parts.push({ text: promptText });

  // Coba slot yang tersedia, retry kalau limit
  while (true) {
    const slot = await getAvailableSlot();
    if (!slot) throw new Error('Semua API key sudah limit');

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${slot.modelName}:generateContent?key=${slot.apiKey}`;

    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }]
        })
      });

      if (res.status === 429 || res.status === 503) {
        console.warn(`Limit! ${slot.key} → ${slot.modelCol}, ganti slot...`);
        await markAsLimit(slot.key, slot.modelCol);
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini error: ${err}`);
      }

      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

      const clean = rawText.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);

    } catch (e) {
      throw e;
    }
  }
}

export { prosesGemini };
