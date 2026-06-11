// Vendor slug -> endoflife.date product mapping for Phase 1 scraping.
// Empty array means "no endoflife.date source available" -> status 'no_source'.
// Slugs verified against https://endoflife.date/api/all.json (2026-06-11).
// HP/Aruba, Juniper, Ubiquiti, CheckPoint, Ruckus and SonicWall are NOT tracked
// by endoflife.date at all, so they have no source and must be sourced elsewhere.

export const EOL_PRODUCT_MAP: Record<string, string[]> = {
  cisco: ['cisco-ios-xe'],
  fortinet: ['fortios'],
  hp: [],
  juniper: [],
  mikrotik: ['routeros'],
  ubiquiti: [],
  ruckus: [],
  checkpoint: [],
  sonicwall: [],
  paloalto: ['panos'],
};
