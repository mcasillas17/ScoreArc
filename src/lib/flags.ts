// FIFA 3-letter code -> ISO 3166-1 alpha-2 (lowercase) for flagcdn.
// flagcdn images are full-bleed rectangular flags, so they fill a circular disc
// with object-fit: cover (unlike ESPN's padded square country logos).
const FLAG_MAP: Record<string, string> = {
  // Hosts + CONMEBOL
  MEX: 'mx', CAN: 'ca', USA: 'us', BRA: 'br', ARG: 'ar', URU: 'uy', COL: 'co',
  ECU: 'ec', PAR: 'py', CHI: 'cl', PER: 'pe', VEN: 've', BOL: 'bo',
  // UEFA
  ESP: 'es', FRA: 'fr', GER: 'de', ENG: 'gb-eng', POR: 'pt', NED: 'nl',
  BEL: 'be', CRO: 'hr', SUI: 'ch', AUT: 'at', SWE: 'se', NOR: 'no', ITA: 'it',
  SCO: 'gb-sct', WAL: 'gb-wls', NIR: 'gb-nir', CZE: 'cz', DEN: 'dk', POL: 'pl',
  SRB: 'rs', UKR: 'ua', TUR: 'tr', BIH: 'ba', GRE: 'gr', ROU: 'ro', HUN: 'hu',
  RUS: 'ru', SVK: 'sk', SVN: 'si', ALB: 'al', IRL: 'ie',
  // CAF
  MAR: 'ma', SEN: 'sn', CIV: 'ci', EGY: 'eg', ALG: 'dz', GHA: 'gh', CPV: 'cv',
  RSA: 'za', CMR: 'cm', NGA: 'ng', COD: 'cd', TUN: 'tn', MLI: 'ml', BFA: 'bf',
  ANG: 'ao',
  // AFC
  JPN: 'jp', KOR: 'kr', IRN: 'ir', AUS: 'au', KSA: 'sa', QAT: 'qa', UZB: 'uz',
  IRQ: 'iq', JOR: 'jo', UAE: 'ae', CHN: 'cn',
  // CONCACAF / OFC
  CRC: 'cr', PAN: 'pa', HON: 'hn', JAM: 'jm', HAI: 'ht', NZL: 'nz', CUW: 'cw',
};

export function flagUrl(abbr?: string | null): string | null {
  if (!abbr) return null;
  const iso = FLAG_MAP[abbr.toUpperCase()];
  return iso ? `https://flagcdn.com/w160/${iso}.png` : null;
}
