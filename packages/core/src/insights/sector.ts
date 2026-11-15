/**
 * The company's sector benchmark (stock-insights section C): its SEC SIC industry code mapped to one of the 11 SPDR
 * sector funds. The SIC system predates the GICS sectors the funds follow, so the map is an approximation, kept small
 * and explicit. Ranges are inclusive and checked in this order, the first match wins (so a narrow range listed early
 * overrides a broad one later, e.g. REITs 6798 before financials 6000–6799). A code in no range gives no sector.
 *
 * Known approximations: 7370–7379 (software and internet services) is all technology (XLK), although some internet
 * companies are in the communication fund (XLC); 3570–3579 and 3661–3679 (computers, communication equipment,
 * electronic components and semiconductors) are technology; drug makers, medical instruments and health services are
 * health care.
 */

export interface SectorFund {
  symbol: string;
  name: string;
}

export const SECTOR_FUNDS: Readonly<Record<string, string>> = {
  XLK: 'Technology Select Sector SPDR Fund',
  XLV: 'Health Care Select Sector SPDR Fund',
  XLF: 'Financial Select Sector SPDR Fund',
  XLE: 'Energy Select Sector SPDR Fund',
  XLU: 'Utilities Select Sector SPDR Fund',
  XLP: 'Consumer Staples Select Sector SPDR Fund',
  XLY: 'Consumer Discretionary Select Sector SPDR Fund',
  XLI: 'Industrial Select Sector SPDR Fund',
  XLB: 'Materials Select Sector SPDR Fund',
  XLRE: 'Real Estate Select Sector SPDR Fund',
  XLC: 'Communication Services Select Sector SPDR Fund',
};

/** [from, to, fund]: the documented table, first match wins */
export const SIC_SECTOR_TABLE: ReadonlyArray<readonly [number, number, keyof typeof SECTOR_FUNDS & string]> = [
  // real estate before financials
  [6798, 6798, 'XLRE'], // real estate investment trusts
  [6500, 6553, 'XLRE'], // real estate operators, agents, developers
  [6324, 6324, 'XLV'], // hospital and medical service plans (health insurers) before financials
  [6000, 6799, 'XLF'], // banks, credit, brokers, insurance, holding companies
  // technology
  [3570, 3579, 'XLK'], // computers and office equipment
  [3661, 3679, 'XLK'], // communication equipment, electronic components, semiconductors
  [3825, 3825, 'XLK'], // instruments for measuring electricity
  [7370, 7379, 'XLK'], // software, data processing, computer services
  // health care
  [2830, 2836, 'XLV'], // drugs, biological products
  [3826, 3826, 'XLV'], // laboratory analytical instruments (before measuring instruments, industrials)
  [3841, 3851, 'XLV'], // medical instruments and supplies
  [5047, 5047, 'XLV'], // medical equipment wholesale
  [5122, 5122, 'XLV'], // drugs wholesale
  [8000, 8099, 'XLV'], // health services
  [8731, 8731, 'XLV'], // biological research
  // energy (pipelines before utilities)
  [1200, 1241, 'XLE'], // coal
  [1300, 1389, 'XLE'], // oil and gas extraction and services
  [2900, 2999, 'XLE'], // petroleum refining
  [4610, 4619, 'XLE'], // pipelines
  [4922, 4923, 'XLE'], // natural gas transmission
  [5171, 5172, 'XLE'], // petroleum wholesale
  // utilities
  [4900, 4949, 'XLU'], // electric, gas, water and combined utilities
  [4991, 4991, 'XLU'], // cogeneration
  // consumer staples
  [2000, 2111, 'XLP'], // food, beverages, tobacco
  [2840, 2844, 'XLP'], // soap, detergents, cosmetics
  [5140, 5149, 'XLP'], // groceries wholesale
  [5331, 5331, 'XLP'], // variety stores
  [5399, 5399, 'XLP'], // general merchandise (warehouse clubs)
  [5400, 5499, 'XLP'], // food stores
  [5912, 5912, 'XLP'], // drug stores
  // consumer discretionary
  [1520, 1531, 'XLY'], // home builders
  [2300, 2399, 'XLY'], // apparel
  [2500, 2599, 'XLY'], // furniture
  [3011, 3011, 'XLY'], // tires
  [3140, 3149, 'XLY'], // footwear
  [3630, 3639, 'XLY'], // household appliances
  [3651, 3652, 'XLY'], // household audio and video
  [3711, 3716, 'XLY'], // motor vehicles, parts, motor homes
  [3751, 3751, 'XLY'], // motorcycles, bicycles
  [3942, 3949, 'XLY'], // toys, sporting goods
  [5200, 5399, 'XLY'], // building materials retail, department stores
  [5500, 5999, 'XLY'], // auto dealers, apparel, home and other retail, restaurants, online retail
  [7000, 7099, 'XLY'], // hotels
  [7900, 7999, 'XLY'], // amusement and recreation
  [8200, 8299, 'XLY'], // education
  // communication services
  [2710, 2741, 'XLC'], // newspapers, periodicals, books, publishing
  [4800, 4899, 'XLC'], // telephone, broadcasting, cable
  [7810, 7841, 'XLC'], // motion pictures, video
  // materials
  [1000, 1099, 'XLB'], // metal mining
  [1400, 1499, 'XLB'], // non-metallic minerals
  [2400, 2499, 'XLB'], // lumber and wood
  [2600, 2699, 'XLB'], // paper and packaging
  [2800, 2829, 'XLB'], // chemicals and plastics materials
  [2850, 2899, 'XLB'], // paints, agricultural and other chemicals
  [3080, 3089, 'XLB'], // plastics products
  [3200, 3399, 'XLB'], // stone, glass, concrete, primary metals
  // industrials
  [1540, 1799, 'XLI'], // construction
  [3400, 3569, 'XLI'], // fabricated metal, industrial machinery
  [3580, 3629, 'XLI'], // service machinery, electrical equipment
  [3640, 3649, 'XLI'], // lighting
  [3690, 3699, 'XLI'], // other electrical equipment
  [3720, 3799, 'XLI'], // aircraft, ships, railroad and other transport equipment
  [3810, 3829, 'XLI'], // navigation, measuring and control instruments
  [4000, 4789, 'XLI'], // railroads, trucking, shipping, airlines, transport services
  [4950, 4959, 'XLI'], // waste management
  [7350, 7359, 'XLI'], // equipment rental
  [8700, 8748, 'XLI'], // engineering and management services
];

/** The SPDR sector fund for a SIC code ("3571"), or null when the code is missing or in no range. */
export function sectorForSic(sic: string | null | undefined): SectorFund | null {
  if (!sic || !/^\d{3,4}$/.test(sic)) return null;
  const n = Number(sic);
  for (const [from, to, symbol] of SIC_SECTOR_TABLE) if (n >= from && n <= to) return { symbol, name: SECTOR_FUNDS[symbol]! };
  return null;
}
