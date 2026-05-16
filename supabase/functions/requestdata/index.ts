import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Kunci Koordinat NVDC Cibitung (Asal Tempat Kerja Abang) -> Tetap format OSRM [Lng,Lat]
const KOORDINAT_ORIGIN = "107.08367451781723,-6.314409507556446"; 

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// =========================================================================
// FUNGSI UTILITY SEEDER (DIPANGGIL VIA TOMBOL TEST DI DASHBOARD)
// =========================================================================
async function jalankanSeederRute() {
  console.log('[SEEDER] Menarik data branch dan koordinat dari database Supabase...');
  
  // Ambil data branch yang kolom routes_compressed-nya masih kosong
  const { data: listBranch, error } = await supabase
    .from('rute_logistik')
    .select('branch, kordinat')
    .is('routes_compressed', null);

  if (error) {
    throw new Error(`Gagal membaca tabel rute_logistik: ${error.message}`);
  }

  if (!listBranch || listBranch.length === 0) {
    return { status: "sukses", message: "Semua baris data kolom routes sudah terisi penuh!" };
  }

  console.log(`[SEEDER] Menemukan ${listBranch.length} branch yang rutenya kosong.`);
  let suksesCount = 0;
  let skipCount = 0;

  for (const row of listBranch) {
    const namaBranch = row.branch.toUpperCase().trim();
    
    // Validasi apakah kolom kordinat di tabel database sudah abang isi
    if (!row.kordinat) {
      console.warn(`[SEEDER SKIP] Kolom kordinat untuk branch "${namaBranch}" masih kosong.`);
      skipCount++;
      continue;
    }

    try {
      // 🔄 PROSES MEMBALIK KOORDINAT (Dari tabel abang [Lat, Lng] ke standar OSRM [Lng, Lat])
      // Contoh isi tabel abang: "-0.8707879, 120.0491903"
      const parts = row.kordinat.split(',').map((p: string) => p.trim());
      if (parts.length !== 2) {
        console.error(`[SEEDER ERROR] Format kordinat salah pada branch ${namaBranch}: ${row.kordinat}`);
        skipCount++;
        continue;
      }
      
      const latitude = parts[0];
      const longitude = parts[1];
      const koordinatDestinationOSRM = `${longitude},${latitude}`; // Menjadi: "120.0491903,-0.8707879"

      console.log(`[SEEDER OSRM] Memproses rute lengkap + alternatif ke ${namaBranch}...`);
      
      // Tembak server OSRM dengan alternatives=true & steps=true untuk dapat mode driving lengkap
      const urlOSRM = `https://router.project-osrm.org/route/v1/driving/${KOORDINAT_ORIGIN};${koordinatDestinationOSRM}?overview=full&steps=true&alternatives=true`;
      
      const resOSRM = await fetch(urlOSRM);
      if (!resOSRM.ok) {
        console.error(`[SEEDER GAGAL] OSRM menolak request branch ${namaBranch}. Status: ${resOSRM.status}`);
        continue;
      }

      const dataOSRM = await resOSRM.json();

      if (dataOSRM.code === "Ok" && dataOSRM.routes) {
        // Ambil full data array alternatif rute (dari yang tercepat sampai terlama) beserta legs nya
        const stringJsonMentah = JSON.stringify(dataOSRM.routes);

        // 🗜️ PROSES KOMPRESI DI EDGE FUNCTION (String -> Gzip -> Base64)
        const byteArray = new TextEncoder().encode(stringJsonMentah);
        const cs = new CompressionStream("gzip");
        const writer = cs.writable.getWriter();
        writer.write(byteArray);
        writer.close();
        
        const compressedBuffer = await ArrayBuffer.from(cs.readable);
        const uint8Array = new Uint8Array(compressedBuffer);
        let binaryString = "";
        for (let i = 0; i < uint8Array.length; i++) {
          binaryString += String.fromCharCode(uint8Array[i]);
        }
        const base64Compressed = btoa(binaryString);

        // 💾 UPDATE DATABASE: Injeksi string Base64 terkompresi langsung ke baris data tersebut
        const { error: updateError } = await supabase
          .from('rute_logistik')
          .update({ routes_compressed: base64Compressed })
          .eq('branch', namaBranch);

        if (updateError) {
          console.error(`[SEEDER DB ERROR] Gagal update rute ${namaBranch}:`, updateError.message);
        } else {
          console.log(`[SEEDER BERHASIL] Kolom routes untuk branch ${namaBranch} sukses terisi.`);
          suksesCount++;
        }
      }
    } catch (err: any) {
      console.error(`[SEEDER FATAL ERROR] Kendala pada branch ${namaBranch}:`, err.message);
    }

    // Delay 800ms biar server OSRM publik gak mendadak ngadat/RTO pas seeder berjalan miring
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  return {
    status: "selesai",
    message: `Seeder tuntas! Sukses isi: ${suksesCount} rute, Skip: ${skipCount} rute.`
  };
}

// =========================================================================
// MAIN ROUTER
// =========================================================================
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    
    // 🚀 TRIGGER DARI TOMBOL TEST: Tambahkan query ?action=seed di dashboard
    if (url.searchParams.get("action") === "seed") {
      const hasilSeeder = await jalankanSeederRute();
      return new Response(JSON.stringify(hasilSeeder), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Jalur Utama Driver Scan SJKB (Punya abang kemarin)
    return new Response(JSON.stringify({ success: true, message: "Endpoint OCR Aktif" }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
