import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  const { source, url } = await req.json()

  // Keyless passthrough sources — fetch directly, no key injection
  const keyless = ['gdelt', 'reliefweb', 'usgs']
  if (keyless.includes(source)) {
    const response = await fetch(url)
    const data = await response.json()
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Key-injected sources
  const keys: Record<string, string | undefined> = {
    eia:      Deno.env.get('EIA_KEY'),
    fred:     Deno.env.get('FRED_KEY'),
    td:       Deno.env.get('TD_KEY'),
    finnhub:  Deno.env.get('FH_KEY'),
    newsdata: Deno.env.get('NEWSDATA_KEY'),
    av:       Deno.env.get('AV_KEY'),
    polygon:  Deno.env.get('PG_KEY'),
  }
  const key = keys[source]
  if (!key) return new Response('Unknown source', { status: 400 })
  const finalUrl = url.replace('__KEY__', key)
  const response = await fetch(finalUrl)
  const data = await response.json()
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
