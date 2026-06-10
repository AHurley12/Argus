// data/static-data-search.js
// Static reference data for the ARGUS search and navigation system.
// Loaded immediately after static-data.js (both in <head>).
//
// PORTS_DATA — coordinates + reference metadata for strategic world ports.
// Not duplicated from ArgusPortWatch (which has activity data but no lat/lon).
// LNG_FACILITIES_DATA — export/import terminal reference data. No LNG dataset
// exists elsewhere in ARGUS so this is net-new, not a duplication.
//
// Fields designed to feed ArgusUI.showStaticDetail() with isPort/isLNG branches.

var PORTS_DATA = [
  // ── Asia-Pacific ──────────────────────────────────────────────────────────
  { id:'port_sha',    label:'Port of Shanghai',             lat:31.35,  lon:121.72, country:'China',           countryCode:'CHN', portType:'CONTAINER', teu:'47.3M TEU', worldRank:1,  region:'East Asia',      risk:'WATCH'    },
  { id:'port_sgp',    label:'Port of Singapore',            lat:1.29,   lon:103.85, country:'Singapore',       countryCode:'SGP', portType:'CONTAINER', teu:'37.5M TEU', worldRank:2,  region:'Southeast Asia', risk:'WATCH'    },
  { id:'port_nbo',    label:'Port of Ningbo-Zhoushan',      lat:29.88,  lon:121.55, country:'China',           countryCode:'CHN', portType:'CONTAINER', teu:'33.4M TEU', worldRank:3,  region:'East Asia',      risk:'WATCH'    },
  { id:'port_qin',    label:'Port of Qingdao',              lat:36.07,  lon:120.38, country:'China',           countryCode:'CHN', portType:'CONTAINER', teu:'25.7M TEU', worldRank:4,  region:'East Asia',      risk:'WATCH'    },
  { id:'port_gzh',    label:'Port of Guangzhou',            lat:22.80,  lon:113.60, country:'China',           countryCode:'CHN', portType:'CONTAINER', teu:'25.0M TEU', worldRank:5,  region:'East Asia',      risk:'WATCH'    },
  { id:'port_tia',    label:'Port of Tianjin',              lat:39.03,  lon:117.72, country:'China',           countryCode:'CHN', portType:'CONTAINER', teu:'21.7M TEU', worldRank:9,  region:'East Asia',      risk:'WATCH'    },
  { id:'port_bus',    label:'Port of Busan',                lat:35.10,  lon:129.04, country:'South Korea',     countryCode:'KOR', portType:'CONTAINER', teu:'22.1M TEU', worldRank:7,  region:'East Asia',      risk:'LOW'      },
  { id:'port_klg',    label:'Port Klang',                   lat:3.00,   lon:101.40, country:'Malaysia',        countryCode:'MYS', portType:'CONTAINER', teu:'14.4M TEU', worldRank:12, region:'Southeast Asia', risk:'WATCH'    },
  { id:'port_tpk',    label:'Port of Tokyo',                lat:35.62,  lon:139.76, country:'Japan',           countryCode:'JPN', portType:'MIXED',     teu:'6.0M TEU',  worldRank:28, region:'East Asia',      risk:'LOW'      },
  { id:'port_khi',    label:'Port of Kaohsiung',            lat:22.62,  lon:120.27, country:'Taiwan',          countryCode:'TWN', portType:'CONTAINER', teu:'9.2M TEU',  worldRank:15, region:'East Asia',      risk:'WATCH'    },
  { id:'port_col',    label:'Port of Colombo',              lat:6.96,   lon:79.85,  country:'Sri Lanka',       countryCode:'LKA', portType:'CONTAINER', teu:'7.2M TEU',  worldRank:22, region:'Indian Ocean',   risk:'WARNING'  },
  { id:'port_jnp',    label:'Jawaharlal Nehru Port (JNPT)', lat:18.95,  lon:72.94,  country:'India',           countryCode:'IND', portType:'CONTAINER', teu:'7.0M TEU',  worldRank:23, region:'Indian Ocean',   risk:'WARNING'  },
  { id:'port_man',    label:'Port of Manila',               lat:14.59,  lon:120.97, country:'Philippines',     countryCode:'PHL', portType:'MIXED',     teu:'5.3M TEU',  worldRank:35, region:'Southeast Asia', risk:'WATCH'    },
  // ── Middle East ───────────────────────────────────────────────────────────
  { id:'port_jea',    label:'Jebel Ali (Dubai)',            lat:24.98,  lon:55.07,  country:'UAE',             countryCode:'ARE', portType:'CONTAINER', teu:'14.8M TEU', worldRank:11, region:'Middle East',    risk:'WARNING'  },
  { id:'port_abas',   label:'Port of Bandar Abbas',         lat:27.18,  lon:56.27,  country:'Iran',            countryCode:'IRN', portType:'MIXED',     teu:'2.9M TEU',  worldRank:60, region:'Middle East',    risk:'CRITICAL' },
  // ── Europe ────────────────────────────────────────────────────────────────
  { id:'port_rot',    label:'Port of Rotterdam',            lat:51.95,  lon:4.13,   country:'Netherlands',     countryCode:'NLD', portType:'MIXED',     teu:'15.3M TEU', worldRank:10, region:'North Sea',      risk:'LOW'      },
  { id:'port_ant',    label:'Port of Antwerp-Bruges',       lat:51.22,  lon:4.40,   country:'Belgium',         countryCode:'BEL', portType:'CONTAINER', teu:'13.0M TEU', worldRank:13, region:'North Sea',      risk:'LOW'      },
  { id:'port_ham',    label:'Port of Hamburg',              lat:53.55,  lon:10.00,  country:'Germany',         countryCode:'DEU', portType:'CONTAINER', teu:'8.3M TEU',  worldRank:18, region:'North Sea',      risk:'LOW'      },
  { id:'port_pir',    label:'Port of Piraeus',              lat:37.95,  lon:23.65,  country:'Greece',          countryCode:'GRC', portType:'CONTAINER', teu:'5.7M TEU',  worldRank:32, region:'Mediterranean',  risk:'LOW'      },
  { id:'port_fxt',    label:'Port of Felixstowe',           lat:51.96,  lon:1.35,   country:'United Kingdom',  countryCode:'GBR', portType:'CONTAINER', teu:'3.9M TEU',  worldRank:45, region:'North Sea',      risk:'LOW'      },
  { id:'port_bar',    label:'Port of Barcelona',            lat:41.34,  lon:2.18,   country:'Spain',           countryCode:'ESP', portType:'MIXED',     teu:'3.6M TEU',  worldRank:48, region:'Mediterranean',  risk:'LOW'      },
  // ── Americas ──────────────────────────────────────────────────────────────
  { id:'port_lax',    label:'Port of Los Angeles',          lat:33.75,  lon:-118.27,country:'United States',   countryCode:'USA', portType:'CONTAINER', teu:'9.2M TEU',  worldRank:16, region:'Pacific Coast',  risk:'LOW'      },
  { id:'port_nyc',    label:'Port of New York/New Jersey',  lat:40.68,  lon:-74.05, country:'United States',   countryCode:'USA', portType:'CONTAINER', teu:'8.1M TEU',  worldRank:19, region:'East Coast',     risk:'LOW'      },
  { id:'port_sav',    label:'Port of Savannah',             lat:31.99,  lon:-81.10, country:'United States',   countryCode:'USA', portType:'CONTAINER', teu:'5.8M TEU',  worldRank:31, region:'East Coast',     risk:'LOW'      },
  { id:'port_sts',    label:'Port of Santos',               lat:-23.96, lon:-46.33, country:'Brazil',          countryCode:'BRA', portType:'MIXED',     teu:'5.0M TEU',  worldRank:37, region:'South America',  risk:'WATCH'    },
  { id:'port_baires', label:'Port of Buenos Aires',         lat:-34.60, lon:-58.36, country:'Argentina',       countryCode:'ARG', portType:'MIXED',     teu:'2.2M TEU',  worldRank:65, region:'South America',  risk:'WATCH'    },
  // ── Africa ────────────────────────────────────────────────────────────────
  { id:'port_dur',    label:'Port of Durban',               lat:-29.87, lon:31.04,  country:'South Africa',    countryCode:'ZAF', portType:'MIXED',     teu:'3.1M TEU',  worldRank:52, region:'Indian Ocean',   risk:'WATCH'    },
  { id:'port_mom',    label:'Port of Mombasa',              lat:-4.05,  lon:39.66,  country:'Kenya',           countryCode:'KEN', portType:'MIXED',     teu:'1.3M TEU',  worldRank:85, region:'Indian Ocean',   risk:'WATCH'    },
  { id:'port_lag',    label:'Port of Lagos (Apapa)',         lat:6.45,   lon:3.40,   country:'Nigeria',         countryCode:'NGA', portType:'MIXED',     teu:'1.5M TEU',  worldRank:78, region:'West Africa',    risk:'CRITICAL' },
];
window.PORTS_DATA = PORTS_DATA;

var LNG_FACILITIES_DATA = [
  // ── North America ─────────────────────────────────────────────────────────
  { id:'lng_sabine',    label:'Sabine Pass LNG',          lat:29.73,  lon:-93.87, country:'United States', countryCode:'USA', capacity:'30.0 MTPA',  operator:'Cheniere Energy',          trains:6, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_freeport',  label:'Freeport LNG',             lat:28.84,  lon:-95.35, country:'United States', countryCode:'USA', capacity:'15.0 MTPA',  operator:'Freeport LNG',             trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_corpus',    label:'Corpus Christi LNG',       lat:27.82,  lon:-97.44, country:'United States', countryCode:'USA', capacity:'15.0 MTPA',  operator:'Cheniere Energy',          trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_cameron',   label:'Cameron LNG',              lat:30.09,  lon:-93.30, country:'United States', countryCode:'USA', capacity:'14.4 MTPA',  operator:'Sempra Infrastructure',    trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_calcasieu', label:'Calcasieu Pass LNG',       lat:29.78,  lon:-93.29, country:'United States', countryCode:'USA', capacity:'10.0 MTPA',  operator:'Venture Global',           trains:18,facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_covepoint', label:'Cove Point LNG',           lat:38.41,  lon:-76.45, country:'United States', countryCode:'USA', capacity:'5.75 MTPA',  operator:'Dominion Energy',          trains:1, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  // ── Middle East ───────────────────────────────────────────────────────────
  { id:'lng_raslaffan', label:'Ras Laffan LNG',           lat:25.90,  lon:51.55,  country:'Qatar',         countryCode:'QAT', capacity:'77.0 MTPA',  operator:'QatarEnergy',              trains:14,facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WARNING'  },
  { id:'lng_adgas',     label:'ADGAS Das Island',          lat:25.08,  lon:52.87,  country:'UAE',           countryCode:'ARE', capacity:'5.4 MTPA',   operator:'ADGAS / ADNOC',            trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WARNING'  },
  // ── Africa ────────────────────────────────────────────────────────────────
  { id:'lng_nigeria',   label:'Nigeria LNG (Bonny Island)',lat:4.44,   lon:7.16,   country:'Nigeria',       countryCode:'NGA', capacity:'22.0 MTPA',  operator:'NLNG',                     trains:6, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'CRITICAL' },
  { id:'lng_angola',    label:'Angola LNG',                lat:-5.56,  lon:12.17,  country:'Angola',        countryCode:'AGO', capacity:'5.2 MTPA',   operator:'Chevron / Sonangol',       trains:1, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WARNING'  },
  { id:'lng_mozambique',label:'Mozambique LNG (Area 1)',   lat:-12.45, lon:40.53,  country:'Mozambique',    countryCode:'MOZ', capacity:'12.9 MTPA',  operator:'TotalEnergies',            trains:2, facilityType:'EXPORT', lngStatus:'SUSPENDED',   risk:'CRITICAL' },
  // ── Asia-Pacific ──────────────────────────────────────────────────────────
  { id:'lng_gorgon',    label:'Gorgon LNG',                lat:-20.43, lon:114.35, country:'Australia',     countryCode:'AUS', capacity:'15.6 MTPA',  operator:'Chevron',                  trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_wheatstone',label:'Wheatstone LNG',            lat:-21.89, lon:114.24, country:'Australia',     countryCode:'AUS', capacity:'8.9 MTPA',   operator:'Chevron',                  trains:2, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_nwshelf',   label:'North West Shelf LNG',      lat:-20.62, lon:116.75, country:'Australia',     countryCode:'AUS', capacity:'16.9 MTPA',  operator:'Woodside Energy',          trains:5, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_darwin',    label:'Darwin LNG',                lat:-12.47, lon:130.85, country:'Australia',     countryCode:'AUS', capacity:'3.7 MTPA',   operator:'Santos',                   trains:1, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
  { id:'lng_malaysia',  label:'Malaysia LNG (Bintulu)',    lat:3.18,   lon:113.04, country:'Malaysia',      countryCode:'MYS', capacity:'29.3 MTPA',  operator:'PETRONAS',                 trains:9, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WATCH'    },
  { id:'lng_tangguh',   label:'Tangguh LNG',               lat:-2.85,  lon:133.55, country:'Indonesia',     countryCode:'IDN', capacity:'7.6 MTPA',   operator:'BP',                       trains:3, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WATCH'    },
  { id:'lng_pnglng',    label:'PNG LNG',                   lat:-8.34,  lon:144.67, country:'Papua New Guinea',countryCode:'PNG',capacity:'8.3 MTPA',  operator:'ExxonMobil',               trains:2, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'WARNING'  },
  // ── Russia (sanctioned) ───────────────────────────────────────────────────
  { id:'lng_sakhalin',  label:'Sakhalin-2 LNG',            lat:48.04,  lon:142.94, country:'Russia',        countryCode:'RUS', capacity:'9.6 MTPA',   operator:'Gazprom / Sakhalin Energy',trains:2, facilityType:'EXPORT', lngStatus:'SANCTIONED',  risk:'CRITICAL' },
  { id:'lng_yamal',     label:'Yamal LNG',                 lat:70.94,  lon:68.42,  country:'Russia',        countryCode:'RUS', capacity:'16.5 MTPA',  operator:'Novatek / TotalEnergies',  trains:3, facilityType:'EXPORT', lngStatus:'SANCTIONED',  risk:'CRITICAL' },
  // ── Europe ────────────────────────────────────────────────────────────────
  { id:'lng_hammerfest',label:'Hammerfest LNG (Snohvit)',  lat:70.64,  lon:23.68,  country:'Norway',        countryCode:'NOR', capacity:'4.2 MTPA',   operator:'Equinor',                  trains:1, facilityType:'EXPORT', lngStatus:'OPERATIONAL', risk:'LOW'      },
];
window.LNG_FACILITIES_DATA = LNG_FACILITIES_DATA;
