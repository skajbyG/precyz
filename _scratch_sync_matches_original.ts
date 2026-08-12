recyz — sync-matches Edge Function (bez knihovny — čisté REST volání,
// aby appka nezávisela na dostupnosti balíčkových registrů esm.sh/jsr).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
const REST = SUPABASE_URL + "/rest/v1";
const HDRS = { apikey: SERVICE_ROLE_KEY, Authorization: "Bearer " + SERVICE_ROLE_KEY, "Content-Type": "application/json" };

const ODDS_API_SPORTS: { key: string; country: string; league: string }[] = [
  { key: "soccer_epl", country: "GB", league: "Premier League" },
  { key: "soccer_spain_la_liga", country: "ES", league: "La Liga" },
  { key: "soccer_germany_bundesliga", country: "DE", league: "Bundesliga" },
  { key: "soccer_italy_serie_a", country: "IT", league: "Serie A" },
  { key: "soccer_france_ligue_one", country: "FR", league: "Ligue 1" },
  { key: "soccer_uefa_champs_league", country: "EU", league: "Liga mistrů" },
  { key: "soccer_uefa_champs_league_qualification", country: "EU", league: "Liga mistrů — kvalifikace" },
  { key: "soccer_uefa_europa_league", country: "EU", league: "Evropská liga" },
  { key: "soccer_uefa_europa_conference_league", country: "EU", league: "Konferenční liga" },
];

function devig(oddsMap: Record<string, number>): Record<string, number> {
  const inv: Record<string, number> = {};
  let sum = 0;
  for (const k in oddsMap) { inv[k] = 1 / oddsMap[k]; sum += inv[k]; }
  const out: Record<string, number> = {};
  for (const k in inv) out[k] = inv[k] / sum;
  return out;
}

async function fetchRealBatch() {
  const rows: any[] = [];
  for (const sportDef of ODDS_API_SPORTS) {
    try {
      const url = `https://api.the-odds-api.com/v4/sports/${sportDef.key}/odds/` +
        `?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h&oddsFormat=decimal`;
      const res = await fetch(url);
      if (!res.ok) { console.log(`Odds API chyba pro ${sportDef.key}: ${res.status}`); continue; }
      const events = await res.json();
      for (const ev of events) {
        if (!ev.bookmakers || !ev.bookmakers.length) continue;
        const hasDraw = true;
        const bookmakerOdds: Record<string, Record<string, number>> = {};
        const allFairEstimates: Record<string, number>[] = [];
        for (const bm of ev.bookmakers) {
          const h2h = (bm.markets || []).find((m: any) => m.key === "h2h");
          if (!h2h) continue;
          const priceMap: Record<string, number> = {};
          for (const outcome of h2h.outcomes) {
            if (outcome.name === ev.home_team) priceMap.home = outcome.price;
            else if (outcome.name === ev.away_team) priceMap.away = outcome.price;
            else priceMap.draw = outcome.price;
          }
          if (priceMap.home && priceMap.away && (!hasDraw || priceMap.draw)) {
            allFairEstimates.push(devig(priceMap));
            const _t = (bm.title || "").toLowerCase();
        const _key = _t.includes("tipsport") ? "tipsport" : _t.includes("fortuna") ? "fortuna" : _t.includes("betano") ? "betano" : null;
        if (_key && !bookmakerOdds[_key]) bookmakerOdds[_key] = priceMap;
          }
        }
        if (!allFairEstimates.length) continue;
        const avgFair: Record<string, number> = { home: 0, draw: 0, away: 0 };
        for (const est of allFairEstimates) { avgFair.home += est.home||0; avgFair.draw += est.draw||0; avgFair.away += est.away||0; }
        avgFair.home /= allFairEstimates.length; avgFair.draw /= allFairEstimates.length; avgFair.away /= allFairEstimates.length;
        const confidence = Math.min(85, 35 + allFairEstimates.length * 4);
        if (Object.keys(bookmakerOdds).length) { rows.push({ id: "api-" + ev.id, sport: "football", country: sportDef.country, match_group: "liga", league: sportDef.league, home_team: ev.home_team, away_team: ev.away_team, start_time: ev.commence_time, bookmaker_odds: bookmakerOdds, our_probabilities: avgFair, confidence_score: confidence, has_draw: hasDraw, live: false, source: "real-api" }); }
      }
    } catch (e) { console.log(`Chyba: ${String(e)}`); }
  }
  return rows;
}

Deno.serve(async (_req) => {
  try {
    const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const archRes = await fetch(REST + "/matches?start_time=lt." + encodeURIComponent(cutoff) + "&archived=eq.false", { method: "PATCH", headers: { ...HDRS, Prefer: "count=exact,return=minimal" }, body: JSON.stringify({ archived: true }) });
    if (!archRes.ok) throw new Error("archive failed: " + archRes.status + " " + await archRes.text());
    const delCount = Number((archRes.headers.get("content-range") || "*/0").split("/")[1]) || 0;
    const hardCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await fetch(REST + "/matches?start_time=lt." + encodeURIComponent(hardCutoff) + "&archived=eq.true", { method: "DELETE", headers: { ...HDRS, Prefer: "return=minimal" } }).catch(()=>{});
    const batch = ODDS_API_KEY ? await fetchRealBatch() : [];
    let upserted = 0;
    if (batch.length) {
      const upRes = await fetch(REST + "/matches", { method: "POST", headers: { ...HDRS, Prefer: "resolution=merge-duplicates,count=exact,return=minimal" }, body: JSON.stringify(batch) });
      if (!upRes.ok) throw new Error("upsert failed: " + upRes.status + " " + await upRes.text());
      upserted = batch.length;
    }
    const summary = { ok: true, mode: ODDS_API_SPORTS.length ? "real-api" : "sample", archived: delCount, upserted, ranAt: new Date().toISOString() };
    await fetch(REST + "/system_status", { method: "POST", headers: { ...HDRS, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: "sync-matches", last_run_at: new Date().toISOString(), last_run_ok: true, last_run_detail: summary }) });
    return new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    await fetch(REST + "/system_status", { method: "POST", headers: { ...HDRS, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ id: "sync-matches", last_run_at: new Date().toISOString(), last_run_ok: false, last_run_detail: { error: String(e) } }) }).catch(()=>{});
    try { await fetch("https://ntfy.sh/precyz-sync-alerts-8k2f", { method: "POST", headers: { Title: "Precyz: sync-matches selhalo", Priority: "high", Tags: "warning" }, body: "Chyba: " + String(e) + "\nCas: " + new Date().toISOString() }); } catch (_n) {}
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
