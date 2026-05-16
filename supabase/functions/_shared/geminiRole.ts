import { createClient } from "npm:@supabase/supabase-js@2";

// 1. SETUP SUPABASE CLIENT
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const MODEL_COLS = ['model1', 'model2', 'model3'];

// =========================================================================
// 🔄 LOGIKA ROTASI API KEY & SLOT
// =========================================================================
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

// FIX BUG #3: Update langsung tanpa read dulu (hindari race condition)
async function markAsLimit(key: string, modelCol: string, modelName: string) {
  await supabase
    .from('apirole')
    .update({
      [modelCol]: { models: modelName, status: 'limit' }
    })
    .eq('key', key);
}

// =========================================================================
// 🤖 ENGINE PROSES GEMINI MULTIMODAL + ESTIMASI KOORDINAT
// =========================================================================
export async function prosesGemini(base64Images?: string | string[], rawTextFromOCR?: string) {
  const promptText = `
Kamu adalah spesialis OCR dokumen logistik SJKB (Surat Jalan Kendaraan Baru).
Tugasmu adalah menganalisis data teks hancur hasil OCR atau gambar potongan dokumen, lalu lakukan ekstraksi ke dalam field logistik dengan akurat.
Perbaiki segala bentuk typo pembacaan (misal: "tuj: rp sunlake" menjadi "SUNLAKE", "M0T0R" menjadi "MOTOR").
Jangan ngarang, jangan sok tahu, jangan mengada-ada, kalau tidak tahu set menjadi null saja.

TUGAS TAMBAHAN: 
Berdasarkan nama dealer/lokasi tujuan yang kamu temukan, berikan juga estimasi titik koordinat geografis (Latitude dan Longitude) yang paling akurat di Indonesia untuk lokasi tersebut pada field 'estimated_lat' dan 'estimated_lng'.

Wajib mengembalikan output dalam format JSON bersih tanpa markdown (jangan gunakan \`\`\`json ... \`\`\`), dengan struktur key wajib berikut:
{
  "success": true,
  "no_sjkb": "string nomor surat jalan atau null",
  "pembuat": "string nama pembuat atau null",
  "pengirim": "string nama pengirim atau null",
  "tujuan": "string nama tujuan/dealer atau null",
  "estimated_lat": "string angka latitude dari lokasi tujuan, contoh: -6.123456 atau null",
  "estimated_lng": "string angka longitude dari lokasi tujuan, contoh: 106.123456 atau null",
  "keterangan": "string keterangan atau null",
  "tanggal_jam": "string tanggal dan jam atau null",
  "no_pol": "string nomor polisi kendaraan pengangkut atau null",
  "pengemudi": "string nama supir atau null",
  "moda": "string moda transportasi atau null",
  "vendor": "string nama vendor logistik atau null"
}

Catatan khusus untuk key "success": Berikan nilai true jika minimal 'no_sjkb' ATAU 'tujuan' berhasil teridentifikasi. Jika keduanya gagal didapat, set menjadi false.
  `.trim();

  const parts: any[] = [];

  if (base64Images) {
    const images = Array.isArray(base64Images) ? base64Images : [base64Images];
    for (const img of images) {
      parts.push({
        inline_data: { mime_type: 'image/jpeg', data: img }
      });
    }
    parts.push({ text: `${promptText}\n\nEKSTRAK DARI GAMBAR DI ATAS.` });
  } else if (rawTextFromOCR) {
    parts.push({ 
      text: `${promptText}\n\nDATA MENTAH OCR UNTUK DIPERBAIKI:\n"${rawTextFromOCR}"` 
    });
  } else {
    throw new Error('Tidak ada gambar atau teks yang dikirim.');
  }

  // FIX BUG #1: Ganti while(true) dengan batas retry eksplisit
  const MAX_RETRY = 10;
  let retryCount = 0;

  while (retryCount < MAX_RETRY) {
    retryCount++;

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
        console.warn(`Limit! ${slot.key} (${slot.modelCol}), ganti slot... [retry ${retryCount}/${MAX_RETRY}]`);
        // FIX BUG #3: Kirim modelName agar update tidak perlu read dulu
        await markAsLimit(slot.key, slot.modelCol, slot.modelName);
        continue;
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini error: ${err}`);
      }

      const data = await res.json();
      const rawResponse = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const clean = rawResponse.replace(/```json|```/g, '').trim();

      // FIX BUG #2: Bungkus JSON.parse dengan try-catch
      try {
        return JSON.parse(clean);
      } catch {
        throw new Error(`Respons Gemini bukan JSON valid. Preview: ${clean.slice(0, 300)}`);
      }

    } catch (e: any) {
      // FIX BUG #4: Jangan langsung re-throw — bedakan error fatal vs error slot
      // Error dari JSON.parse atau Gemini non-retriable → lempar keluar
      if (
        e.message.startsWith('Respons Gemini bukan JSON valid') ||
        e.message.startsWith('Gemini error:')
      ) {
        throw e;
      }
      // Error network/timeout → log, mark limit, coba slot lain
      console.warn(`Error network slot ${slot.key} [retry ${retryCount}/${MAX_RETRY}]:`, e.message);
      await markAsLimit(slot.key, slot.modelCol, slot.modelName);
      continue;
    }
  }

  throw new Error(`Gagal setelah ${MAX_RETRY} kali percobaan.`);
}

// =========================================================================
// 🎯 FUNGSI UTILITY: FUZZY MATCH (LEVENSHTEIN DISTANCE)
// =========================================================================
function hitungKemiripan(str1: string, str2: string): number {
  const s1 = str1.toUpperCase().trim();
  const s2 = str2.toUpperCase().trim();
  
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
  for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
  for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

  for (let j = 1; j <= s2.length; j += 1) {
    for (let i = 1; i <= s1.length; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1,
        track[j - 1][i] + 1,
        track[j - 1][i - 1] + indicator
      );
    }
  }
  
  const jarakPalingJauh = Math.max(s1.length, s2.length);
  const hasilJarak = track[s2.length][s1.length];
  return (jarakPalingJauh - hasilJarak) / jarakPalingJauh;
}

// =========================================================================
// 🌐 SERVING ENDPOINT UTAMA EDGE FUNCTION
// =========================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apiKey, content-type",
      }
    });
  }

  try {
    const { base64Images, rawTextFromOCR } = await req.json();

    const hasilGemini = await prosesGemini(base64Images, rawTextFromOCR);

    let dataRuteTambahan = null;

    if (hasilGemini && hasilGemini.success && hasilGemini.tujuan) {
      let namaBranchTujuan = hasilGemini.tujuan.toUpperCase().trim();
      console.log(`[RUTE] Driver menuju ke branch hasil Gemini: "${namaBranchTujuan}". Memeriksa database...`);

      let { data: ruteLokal, error: errorLokal } = await supabase
        .from('rute_logistik')
        .select('*')
        .eq('branch', namaBranchTujuan)
        .maybeSingle();

      if (errorLokal || !ruteLokal) {
        console.log(`[FUZZY] Tidak ada exact match untuk "${namaBranchTujuan}". Mencari branch terkembar...`);
        
        const { data: semuaMasterBranch } = await supabase
          .from('rute_logistik')
          .select('branch, kordinat, leadtime, routes_compressed');

        if (semuaMasterBranch && semuaMasterBranch.length > 0) {
          let skorTerbaik = 0;
          let branchTerbaik = null;

          for (const item of semuaMasterBranch) {
            const skorKemiripan = hitungKemiripan(namaBranchTujuan, item.branch);
            if (skorKemiripan > skorTerbaik) {
              skorTerbaik = skorKemiripan;
              branchTerbaik = item;
            }
          }

          const persentaseConfidence = (skorTerbaik * 100).toFixed(1);
          
          if (skorTerbaik >= 0.80 && branchTerbaik) {
            console.log(`[FUZZY MATCH KETEMU] "${namaBranchTujuan}" → "${branchTerbaik.branch}" (Confidence: ${persentaseConfidence}%)`);
            namaBranchTujuan = branchTerbaik.branch;
            ruteLokal = branchTerbaik;
          } else {
            console.warn(`[FUZZY GAGAL] Skor tertinggi hanya ${persentaseConfidence}%, di bawah limit 80%. Dianggap branch baru.`);
          }
        }
      }

      if (ruteLokal && ruteLokal.routes_compressed) {
        console.log(`[RUTE] Cache Hit! Data rute terkompresi untuk ${namaBranchTujuan} langsung dipakai.`);
        dataRuteTambahan = {
          source: "DATABASE_LOCAL",
          matched_branch: namaBranchTujuan,
          leadtime: ruteLokal.leadtime,
          routes_data: ruteLokal.routes_compressed
        };
      } else {
        console.log(`[RUTE] Cache Miss! Menyiapkan koordinat rute untuk ${namaBranchTujuan}...`);

        try {
          const koordinatOrigin = "107.08367451781723,-6.314409507556446";
          let koordinatDestination = null;

          // FIX BUG #5: Parsing koordinat eksplisit dengan label variabel & validasi range
          if (ruteLokal && ruteLokal.kordinat) {
            const parts = ruteLokal.kordinat.split(',').map((p: string) => p.trim());
            if (parts.length === 2) {
              const lat = parseFloat(parts[0]);
              const lng = parseFloat(parts[1]);
              // Validasi: lat Indonesia -11 s/d 6, lng 95 s/d 141
              if (
                !isNaN(lat) && !isNaN(lng) &&
                lat >= -11 && lat <= 6 &&
                lng >= 95 && lng <= 141
              ) {
                // DB simpan "lat, lng" → OSRM butuh "lng,lat"
                koordinatDestination = `${lng},${lat}`;
                console.log(`[DB KOORDINAT] lat=${lat}, lng=${lng} → OSRM: ${koordinatDestination}`);
              } else {
                console.warn(`[KOORDINAT] Nilai koordinat DB di luar batas Indonesia: lat=${lat}, lng=${lng}. Dilewati.`);
              }
            } else {
              console.warn(`[KOORDINAT] Format kordinat DB tidak valid: "${ruteLokal.kordinat}"`);
            }
          }

          if (!koordinatDestination && hasilGemini.estimated_lat && hasilGemini.estimated_lng) {
            const aiLat = parseFloat(hasilGemini.estimated_lat.trim());
            const aiLng = parseFloat(hasilGemini.estimated_lng.trim());

            if (
              !isNaN(aiLat) && !isNaN(aiLng) &&
              aiLat >= -11 && aiLat <= 6 &&
              aiLng >= 95 && aiLng <= 141
            ) {
              // OSRM butuh "lng,lat"
              koordinatDestination = `${aiLng},${aiLat}`;
              console.log(`[AI GEOLOCATION] lat=${aiLat}, lng=${aiLng} → OSRM: ${koordinatDestination}`);

              const formatKordinatDB = `${aiLat}, ${aiLng}`;
              await supabase
                .from('rute_logistik')
                .upsert({ branch: namaBranchTujuan, kordinat: formatKordinatDB }, { onConflict: 'branch' });
            } else {
              console.warn(`[AI GEOLOCATION] Koordinat Gemini tidak valid: lat=${aiLat}, lng=${aiLng}. Dilewati.`);
            }
          }

          if (!koordinatDestination) {
            console.warn("[RUTE] Koordinat kosong dari DB & Gemini. Menggunakan fallback Bekasi.");
            koordinatDestination = "106.8833,-6.1417";
          }

          console.log(`[OSRM] Menembak OSRM dengan koordinat: ${koordinatDestination}...`);
          const urlOSRM = `https://router.project-osrm.org/route/v1/driving/${koordinatOrigin};${koordinatDestination}?overview=full&steps=true&alternatives=true`;
          
          const resOSRM = await fetch(urlOSRM);
          if (!resOSRM.ok) throw new Error("Gagal merespon dari server OSRM");

          const dataOSRM = await resOSRM.json();

          if (dataOSRM.code === "Ok" && dataOSRM.routes) {
            const stringJsonMentah = JSON.stringify(dataOSRM.routes);

            const byteArray = new TextEncoder().encode(stringJsonMentah);
            const cs = new CompressionStream("gzip");
            const writer = cs.writable.getWriter();
            writer.write(byteArray);
            writer.close();
            
            const buffer = await new Response(cs.readable).arrayBuffer();
            const uint8Array = new Uint8Array(buffer);
            let binaryString = "";
            for (let i = 0; i < uint8Array.length; i++) {
              binaryString += String.fromCharCode(uint8Array[i]);
            }
            const base64Compressed = btoa(binaryString);

            dataRuteTambahan = {
              source: "OSRM_LIVE",
              matched_branch: namaBranchTujuan,
              leadtime: ruteLokal ? ruteLokal.leadtime : "0",
              routes_data: base64Compressed
            };

            await supabase
              .from('rute_logistik')
              .upsert({ branch: namaBranchTujuan, routes_compressed: base64Compressed }, { onConflict: 'branch' });
          }
        } catch (errOSRM: any) {
          console.error("[RUTE ERROR] Gagal proses rute OSRM:", errOSRM.message);
          dataRuteTambahan = null;
        }
      }
    }

    const responseKeFrontend = {
      ...hasilGemini,
      rute: dataRuteTambahan
    };

    return new Response(
      JSON.stringify(responseKeFrontend),
      { 
        status: 200, 
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*" 
        } 
      }
    );

  } catch (error: any) {
    console.error("[FATAL ERROR] Sistem bermasalah:", error.message);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { 
        status: 500, 
        headers: { 
          "Content-Type": "application/json", 
          "Access-Control-Allow-Origin": "*" 
        } 
      }
    );
  }
});
