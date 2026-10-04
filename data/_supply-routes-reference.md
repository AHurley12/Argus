# Supply Routes Reference
# Argus Ingestion Layer — Internal Reference
#
# Source data originally rendered by ArgusRouteRenderer (removed 2026-10-04).
# This file preserves all route definitions and expands them with bunkering stops,
# chokepoint annotations, and additional lanes not yet in routes.json.
# Intended for future use by the NeuralWeb ingestion layer (ingestTradeRoutes),
# the interactive ArgusSupplyRoute module, and route risk scoring.
#
# Format: human-readable markdown, machine-parseable by section heading.
# UNLOCODE port codes are included where available.

---

## LANE: Asia–Europe via Suez Canal
**ID:** `asia_europe_suez`  
**Type:** Container / General Cargo  
**Direction:** Bidirectional (eastbound dominated by European exports; westbound by Asian manufactured goods)  
**Transit time:** ~22–26 days (Shanghai to Rotterdam)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| singapore | Singapore | 1.26 | 103.82 | SGSIN | Major hub / bunkering |
| sri_lanka | Colombo | 6.50 | 79.00 | LKCMB | Transshipment hub |
| bab | Bab el-Mandeb | 12.00 | 44.00 | — | Chokepoint |
| red_sea_n | Red Sea North | 27.00 | 34.50 | — | Transit corridor |
| port_said | Port Said | 31.26 | 32.28 | EGPSD | Suez Canal entry / bunkering |
| med_east | E. Mediterranean | 34.00 | 22.00 | — | Transit corridor |
| algeciras | Algeciras | 36.13 | -5.44 | ESALG | Strait of Gibraltar / bunkering |
| rotterdam | Rotterdam | 51.92 | 4.48 | NLRTM | Destination hub |

### Key Chokepoints
- **Bab el-Mandeb** (12°N 44°E) — Houthi threat zone; alternate Cape of Good Hope diversion active since late 2023
- **Suez Canal** (30°N 32°E) — single-lane bottleneck; Ever Given blockage precedent (2021)
- **Strait of Gibraltar** (36°N -5.5°E) — NATO chokepoint; heavy traffic density

### Bunkering / Refueling Ports Along Route
- **Fujairah, UAE** (25.12°N 56.35°E) — AEFJR — largest bunkering port in the world by volume; critical Gulf alternative to Port Said
- **Port Said / Ismailia** — Egyptian side of Suez; bunker supply available
- **Malta** (35.89°N 14.51°E) — MTMLA — major Mediterranean bunkering hub; used eastbound and westbound
- **Algeciras** — one of Europe's busiest bunkering ports; Gibraltar alternate
- **Rotterdam** — Northwest Europe's largest bunkering hub; LNG bunker capability

---

## LANE: Trans-Pacific (Asia–US West Coast)
**ID:** `trans_pacific`  
**Type:** Container  
**Direction:** Bidirectional  
**Transit time:** ~14–16 days (Shanghai to Los Angeles)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| shanghai | Shanghai | 31.36 | 121.51 | CNSHA | Origin hub |
| busan | Busan | 35.10 | 129.04 | KRPUS | Major Korean transshipment hub |
| pac_n | North Pacific | 40.00 | 170.00 | — | Great-circle corridor |
| pac_mid | Mid Pacific | 38.00 | -155.00 | — | Transit |
| los_angeles | Los Angeles / Long Beach | 33.73 | -118.27 | USLAX / USLGB | Primary US West Coast destination |

### Additional Ports of Call (not in routes.json)
- **Yokohama** (35.44°N 139.64°E) — JPYOK — major Japanese export port; frequent call on Shanghai–LA run
- **Kaohsiung** (22.62°N 120.27°E) — TWKHH — Taiwan's primary container port; connects to trans-Pacific lanes
- **Seattle / Tacoma** (47.60°N -122.34°W) — USSEA / USTIW — secondary US West Coast hub; grain exports

### Bunkering / Refueling Ports Along Route
- **Busan** — primary trans-Pacific bunkering hub; also serves North Pacific corridor
- **Honolulu / Pearl Harbor approach** (21.30°N -157.85°W) — USHNL — mid-Pacific waypoint; available for emergency bunkering
- **Los Angeles / Long Beach** — largest US port complex; bunkering available

---

## LANE: Asia–Europe via Cape of Good Hope
**ID:** `cape_route`  
**Type:** Container / Bulk / Tanker  
**Direction:** Bidirectional  
**Transit time:** ~30–35 days (Singapore to Rotterdam)  
**Note:** Activated as primary diversion since Houthi attacks on Bab el-Mandeb (late 2023–present)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| singapore | Singapore | 1.26 | 103.82 | SGSIN | Origin hub / bunkering |
| lombok_st | Lombok Strait | -8.50 | 115.70 | — | Chokepoint (alt. to Malacca) |
| ind_ocean | Indian Ocean | -20.00 | 75.00 | — | Transit corridor |
| cape | Cape of Good Hope | -35.00 | 18.50 | — | Waypoint |
| port_elizabeth | Port Elizabeth (Gqeberha) | -33.96 | 25.62 | ZAPLZ | Bunkering / emergency stop |
| w_africa | West Africa | 5.00 | 3.00 | — | Transit corridor |
| canaries | Canary Islands | 28.00 | -14.00 | — | Bunkering stop |
| rotterdam | Rotterdam | 51.92 | 4.48 | NLRTM | Destination hub |

### Key Chokepoints
- **Lombok Strait** (-8.5°S 115.7°E) — Indonesian chokepoint; used when Malacca Strait congested
- **Cape of Good Hope** — weather hazard zone; rounding in winter swells adds risk

### Bunkering / Refueling Ports Along Route
- **Durban, South Africa** (-29.87°S 31.03°E) — ZADUR — primary South African bunkering hub; major call port
- **Port Elizabeth (Gqeberha)** — secondary bunkering; dry-dock capability
- **Las Palmas, Gran Canaria** (28.14°N -15.43°W) — ESLPA — Atlantic bunkering hub; key stop for North–South Atlantic and Cape routes
- **Port Louis, Mauritius** (-20.16°S 57.49°E) — MUPLU — Indian Ocean bunkering waypoint; used on Asia–Cape runs

---

## LANE: Asia–US East Coast via Panama Canal
**ID:** `asia_us_east_panama`  
**Type:** Container  
**Direction:** Bidirectional  
**Transit time:** ~28–32 days (Shanghai to New York)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| shanghai | Shanghai | 31.36 | 121.51 | CNSHA | Origin hub |
| pac_mid | Pacific | 15.00 | 165.00 | — | Transit corridor |
| balboa | Balboa (Panama Pacific) | 8.94 | -79.57 | PABBA | Canal Pacific entry |
| cristobal | Cristobal (Panama Atlantic) | 9.36 | -79.90 | PACCT | Canal Atlantic exit / bunkering |
| caribbean | Caribbean | 18.00 | -72.00 | — | Transit corridor |
| new_york | New York / Newark | 40.70 | -74.15 | USNYC | Destination hub |

### Key Chokepoints
- **Panama Canal** — Neopanamax locks opened 2016; drought restrictions reduced draft 2023–2024; backup route is Cape Horn (adds ~14 days) or Suez

### Bunkering / Refueling Ports Along Route
- **Balboa / Panama City** — bunker supply available; canal agents handle logistics
- **Colon / Cristobal** — major Atlantic-side bunkering hub; free trade zone
- **Cartagena, Colombia** (10.42°N -75.53°W) — COCRT — Caribbean transshipment and bunkering hub
- **Kingston, Jamaica** (17.99°N -76.79°W) — JMKIN — Caribbean bunkering stop; transshipment
- **New York / Port Newark** — major US East Coast bunkering hub

---

## LANE: Asia–Persian Gulf
**ID:** `persian_gulf_run`  
**Type:** Tanker / Container  
**Direction:** Bidirectional (crude/LNG westbound; manufactured goods eastbound)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| singapore | Singapore | 1.26 | 103.82 | SGSIN | Origin hub |
| colombo | Colombo | 6.50 | 79.00 | LKCMB | Transshipment |
| ind_nw | Indian Ocean NW | 15.00 | 62.00 | — | Transit corridor |
| muscat | Muscat approach | 22.00 | 59.00 | — | Approach corridor |
| hormuz | Strait of Hormuz | 26.30 | 56.50 | — | Chokepoint |
| jebel_ali | Jebel Ali | 24.99 | 55.08 | AEJEA | Destination hub / world's largest man-made harbour |

### Key Chokepoints
- **Strait of Hormuz** (26.3°N 56.5°E) — ~20% of global oil transits here; Iranian military presence; mine/drone threat
- **Bab el-Mandeb** — relevant for Red Sea access approaching from west

### Bunkering / Refueling Ports Along Route
- **Fujairah** (25.12°N 56.35°E) — AEFJR — world's largest bunkering hub; outside Hormuz Strait; preferred for tankers avoiding Strait risk
- **Jebel Ali** — Dubai; full bunkering services
- **Khor Fakkan** (25.33°N 56.37°E) — AEKFK — Fujairah emirate; large anchorage; used when Jebel Ali congested

---

## LANE: Trans-Atlantic (Europe–Americas)
**ID:** `trans_atlantic`  
**Type:** Container / Ro-Ro / Bulk  
**Direction:** Bidirectional  
**Transit time:** ~8–10 days (Rotterdam to New York)

### Waypoints (ordered)
| Stop | Label | Lat | Lon | Port UNLOCODE | Role |
|------|-------|-----|-----|---------------|------|
| rotterdam | Rotterdam | 51.92 | 4.48 | NLRTM | Origin hub |
| channel | English Channel | 50.00 | -4.00 | — | Chokepoint |
| mid_atl | Mid-Atlantic | 46.00 | -30.00 | — | Transit corridor |
| new_york | New York | 40.70 | -74.15 | USNYC | Destination hub |

### Key Chokepoints
- **English Channel / Dover Strait** (51°N -1°E) — one of the world's busiest shipping corridts; TSS (Traffic Separation Scheme) enforced

### Bunkering / Refueling Ports Along Route
- **Hamburg** (53.55°N 9.99°E) — DEHAM — major North European bunker hub; LNG capable
- **Antwerp** (51.23°N 4.40°E) — BEANR — Europe's second-largest port; heavy bunkering traffic
- **Azores (Ponta Delgada)** (37.73°N -25.67°W) — PTPDL — mid-Atlantic waypoint; emergency bunkering
- **Halifax, Canada** (44.65°N -63.57°W) — CAHFX — North Atlantic alternate entry port; emergency bunkering

---

## ADDITIONAL LANES (not yet in routes.json)

### LANE: Northern Sea Route (Arctic)
**Status:** Seasonal (July–October); expanding with ice melt  
**Transit time:** ~14 days (Rotterdam to Yokohama); ~12 days shorter than Suez  
**Chokepoints:** Bering Strait (65.7°N -168.9°W); Vilkitsky Strait (77.5°N 103.3°E)  
**Key ports:** Murmansk (RUММК), Sabetta LNG terminal (71.3°N 72.1°E), Vladivostok (RUVVO)  
**Risk:** Russian territorial waters; icebreaker escort required; no salvage infrastructure

### LANE: South America–Europe (via Cape Horn or Panama)
**Key ports:** Santos, Brazil (BRSSZ); Buenos Aires (ARBUE); Callao, Peru (PECLL); Rotterdam (NLRTM); Hamburg (DEHAM)  
**Chokepoints:** Cape Horn (-55.9°S -67.3°W); Drake Passage (high sea state)  
**Primary cargo:** Soy, iron ore, copper, coffee, automobiles

### LANE: West Africa–Europe
**Key ports:** Lagos / Apapa (NGAPP); Abidjan (CIABJ); Dakar (SNDK); Tema, Ghana (GHTEM); Las Palmas (ESLPA); Rotterdam (NLRTM)  
**Primary cargo:** Crude oil, LNG (Nigeria), cocoa, timber  
**Bunkering:** Las Palmas (major), Dakar (secondary)

### LANE: Australia–Asia (Iron Ore / Coal)
**Key ports:** Port Hedland, WA (AUPHE); Dampier (AUDPZ); Newcastle, NSW (AUNTL); Singapore (SGSIN); Qingdao, China (CNQDG); Nippon Steel anchorages (Japan)  
**Primary cargo:** Iron ore, coal, LNG  
**Chokepoints:** Lombok Strait; Malacca Strait  
**Bunkering:** Singapore (primary); Port Louis (secondary)

### LANE: Persian Gulf–China (Crude Oil)
**Key ports:** Ras Tanura, Saudi Arabia (SARAT); Kharg Island, Iran; Jebel Ali (AEJEA); Strait of Hormuz → Indian Ocean → Malacca Strait → Shanghai (CNSHA); Ningbo (CNNGB); Qingdao (CNQDG)  
**Primary cargo:** Crude oil (VLCC tankers)  
**Chokepoints:** Strait of Hormuz; Malacca Strait  
**Bunkering:** Fujairah (pre-Hormuz); Singapore (post-Malacca)

---

## GLOBAL BUNKERING HUBS (Priority Reference)

| Port | Location | UNLOCODE | Region | Notes |
|------|----------|----------|--------|-------|
| Singapore | 1.26°N 103.82°E | SGSIN | SE Asia | World #1 by volume; IFO, VLSFO, LNG |
| Rotterdam | 51.92°N 4.48°E | NLRTM | N. Europe | World #2; full LNG capability |
| Fujairah | 25.12°N 56.35°E | AEFJR | Gulf | World #3; outside Hormuz; IOC bunkering |
| Port Said | 31.26°N 32.28°E | EGPSD | Med/Suez | Canal transit bunkering |
| Gibraltar / Algeciras | 36.13°N -5.44°E | GXGIB/ESALG | Med entry | Strait of Gibraltar bottleneck hub |
| Malta | 35.89°N 14.51°E | MTMLA | Med centre | East-west Mediterranean pivot |
| Durban | -29.87°S 31.03°E | ZADUR | S. Africa | Cape route primary |
| Las Palmas | 28.14°N -15.43°W | ESLPA | Canaries | N/S Atlantic crossroads |
| Port Louis | -20.16°S 57.49°E | MUPLU | Indian Ocean | Mid-ocean waypoint |
| Busan | 35.10°N 129.04°E | KRPUS | NE Asia | Trans-Pacific origin bunkering |
| Antwerp | 51.23°N 4.40°E | BEANR | N. Europe | Secondary European hub |
| Hamburg | 53.55°N 9.99°E | DEHAM | N. Europe | LNG pioneer; Elbe river access |
| Colon | 9.36°N -79.90°W | PACCT | C. America | Panama Canal Atlantic |
| Cartagena | 10.42°N -75.53°W | COCRT | Caribbean | Caribbean hub |
| Houston | 29.75°N -95.36°W | USHOU | US Gulf | Petroleum capital; massive bunker supply |
| Santos | -23.93°S -46.32°W | BRSSZ | S. America | South Atlantic primary |

---

## STRATEGIC CHOKEPOINTS (Route Risk Reference)

| Chokepoint | Lat | Lon | Routes Affected | Risk Level |
|------------|-----|-----|-----------------|------------|
| Strait of Malacca | 1.25°N | 103.75°E | Trans-Pacific, Asia-Europe Suez, Persian Gulf run | HIGH — piracy, congestion |
| Bab el-Mandeb | 12.00°N | 44.00°E | Asia-Europe Suez | CRITICAL — Houthi strikes active |
| Suez Canal | 30.00°N | 32.50°E | Asia-Europe Suez | HIGH — single-point blockage risk |
| Strait of Hormuz | 26.30°N | 56.50°E | Persian Gulf run | CRITICAL — Iran closure threat; ~20% global oil |
| Strait of Gibraltar | 36.00°N | -5.50°E | Asia-Europe Suez, Trans-Atlantic | WATCH — NATO monitoring; migration interdiction |
| Dover Strait | 51.00°N | 1.40°E | Trans-Atlantic | WATCH — highest vessel density globally |
| Panama Canal | 9.10°N | -79.75°E | Asia-US East | HIGH — drought restrictions; neo-Panamax limits |
| Cape of Good Hope | -35.00°S | 18.50°E | Cape route | WATCH — weather; piracy in W. Africa approach |
| Lombok Strait | -8.50°S | 115.70°E | Cape route, Australia-Asia | WATCH — Malacca congestion diversion |
| Bering Strait | 65.70°N | -168.90°W | Arctic route | WATCH — seasonal; Russian territorial |
| Turkish Straits (Bosphorus) | 41.10°N | 29.05°E | Black Sea access | HIGH — Russian war; Montreux Convention controls |
| Cape Horn | -55.90°S | -67.30°W | S. America-Europe | WATCH — sea state; no diversion available |

---
_Last updated: 2026-10-04. Source: routes.json (ArgusRouteRenderer, deprecated) + open-source maritime reference._
