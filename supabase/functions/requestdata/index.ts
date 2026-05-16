import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Koordinat NVDC Cibitung presisi sesuai input abang
const KOORDINAT_ORIGIN = "107.08367451781723,-6.314409507556446"; 

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Fungsi Kompres String JSON -> Gzip -> Base64
 */
async function kompresKeBase64Gzip(stringData: string): Promise<string> {
  const byteArray = new TextEncoder().encode(stringData);
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
  return btoa(binaryString);
}

// =========================================================================
// MAIN LOGIC SEEDER ROUTE
// =========================================================================
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log('[SEEDER] Menarik baris data rute yang kosong dari Supabase...');
    
    // 1. Ambil semua baris yang routes_compressed nya masih NULL
    const { data: listBranch, error } = await supabase
      .from('rute_logistik')
      .select('branch, kordinat')
      .is('routes_compressed', null);

    if (error) {
      throw new Error(`Gagal membaca tabel rute_logistik: ${error.message}`);
    }

    if (!listBranch || listBranch.length === 0) {
      return new Response(JSON.stringify({ 
        status: "sukses", 
        message: "Mantap bang! Semua rute di tabel sudah terisi penuh, tidak ada yang NULL." 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[SEEDER] Ditemukan ${listBranch.length} branch yang rutenya kosong.`);
    let suksesCount = 0;
    let skipCount = 0;

    // 2. Loop & Tembak OSRM secara serial (antre)
    for (const row of listBranch) {
      const namaBranch = row.branch.toUpperCase().trim();
      
      if (!row.kordinat) {
        console.warn(`[SKIP] Branch "${namaBranch}" dilewati karena kolom koordinatnya kosong.`);
        skipCount++;
        continue;
      }

      try {
        // Pecah "Latitude, Longitude" dari tabel abang
        const parts = row.kordinat.split(',').map((p: string) => p.trim());
        if (parts.length !== 2) {
          console.error(`[ERROR] Format koordinat salah di branch ${namaBranch}: ${row.kordinat}`);
          skipCount++;
          continue;
        }
        
        const latitude = parts[0];
        const longitude = parts[1];
        
        // BALIK URUTAN: Google Maps [Lat, Lng] -> OSRM [Lng, Lat]
        const koordinatDestinationOSRM = `${longitude},${latitude}`; 

        console.log(`[OSRM] Fetching rute alternatif untuk: ${namaBranch} (${koordinatDestinationOSRM})...`);
        
        // Tembak server OSRM
        const urlOSRM = `https://router.project-osrm.org/route/v1/driving/${KOORDINAT_ORIGIN};${koordinatDestinationOSRM}?overview=full&steps=true&alternatives=true`;
        
        const resOSRM = await fetch(urlOSRM);
        if (!resOSRM.ok) {
          console.error(`[OSRM GAGAL] Server menolak request untuk ${namaBranch}. Status: ${resOSRM.status}`);
          continue;
        }

        const dataOSRM = await resOSRM.json();

        if (dataOSRM.code === "Ok" && dataOSRM.routes) {
          // Serialisasikan full array rute alternatifnya
          const stringJsonMentah = JSON.stringify(dataOSRM.routes);

          // Jalankan kompresi ke Base64 Gzip
          const base64Compressed = await kompresKeBase64Gzip(stringJsonMentah);

          // Update langsung ke kolom database baris tersebut
          const { error: updateError } = await supabase
            .from('rute_logistik')
            .update({ routes_compressed: base64Compressed })
            .eq('branch', row.branch); // Menggunakan nama asli dari baris database

          if (updateError) {
            console.error(`[DB ERROR] Gagal simpan rute ${namaBranch}:`, updateError.message);
          } else {
            console.log(`[SUKSES] Rute untuk branch ${namaBranch} berhasil disimpan.`);
            suksesCount++;
          }
        }
      } catch (err: any) {
        console.error(`[FATAL] Kendala sistem pada branch ${namaBranch}:`, err.message);
      }

      // Kasih jeda 800ms per baris data biar gak diblokir/IP rate limit sama OSRM publik
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    const responAkhir = {
      status: "selesai",
      message: `Proses seeder mandiri tuntas! Berhasil isi: ${suksesCount} rute, Skip: ${skipCount} rute.`
    };

    return new Response(JSON.stringify(responAkhir), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
