// Vendor slug -> endoflife.date product mapping for Phase 1 scraping.
// Empty array means "no endoflife.date source available" -> status 'no_source'.

export const EOL_PRODUCT_MAP: Record<string, string[]> = {
  cisco: ['cisco-ios', 'cisco-ios-xe', 'cisco-nx-os', 'cisco-asr-1000', 'cisco-catalyst-9000'],
  fortinet: ['fortinet-fortigate', 'fortinet-fortimanager'],
  hp: ['hp-uefi', 'hpe-simplivity'],
  juniper: ['juniper-junos'],
  mikrotik: ['routeros'],
  ubiquiti: ['unifi', 'unifi-network-server'],
  ruckus: [],
  checkpoint: [],
  sonicwall: [],
  paloalto: ['panos'],
};
