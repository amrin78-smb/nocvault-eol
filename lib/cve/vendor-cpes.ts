// lib/cve/vendor-cpes.ts
//
// Which CPE strings this service asks NVD about, per vendor.
//
// ⛔ EVERY STRING HERE WAS PROBED AGAINST THE LIVE NVD API AND THE totalResults
// IT RETURNED IS RECORDED BESIDE IT. Ported from SecVault's lib/feeds/nvd.js,
// where the Check Point list went from 4 strings to 22 after measuring that the
// old list returned SEVEN advisories for a firewall with a thirty-year CVE
// history. NVD files one gateway under ~15 product names accumulated across
// three rebrands (FireWall-1 -> VPN-1 -> Security Gateway -> Quantum), and
// asking for four of them gets four of them.
//
// ⛔ THE VENDOR-LEVEL WILDCARD WAS TESTED, WORKS, AND IS REFUSED.
// `cpe:2.3:a:checkpoint` returns 129 MORE CVEs — ZoneAlarm, Harmony, Capsule,
// SmartConsole, the identity and VPN CLIENTS. None runs on a firewall. Filing an
// endpoint-agent CVE against a firewall manufactures urgent work that is not
// real, and pushing that from a CENTRAL feed does it to every customer at once.
// Do not "simplify" this list into a wildcard.
//
// ⛔ A STRING RETURNING 0 IS KEPT IF THE PRODUCT IS REAL — the FlexEdge rebrand
// answers 0 today, and a removed string costs the first advisory ever filed
// under it. A string returning 0 because the SPELLING is wrong is not listed.
//
// ⛔ MOVING THIS LIST HERE IS HALF THE POINT OF THE CENTRAL FEED: today it is
// frozen into every SecVault install's source and only moves on a software
// update. Here it is data, and a coverage fix reaches every customer on the next
// sync.

export const VENDOR_CPES: Record<string, string[]> = {
  forcepoint: [
    'cpe:2.3:a:forcepoint:next_generation_firewall:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:forcepoint:flexedge_secure_sd-wan:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:forcepoint:next_generation_firewall_security_management_center:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:forcepoint:security_manager:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:forcepoint:stonegate:*:*:*:*:*:*:*:*',
  ],
  fortinet: [
    'cpe:2.3:o:fortinet:fortios:*:*:*:*:*:*:*:*',
  ],
  paloalto: [
    'cpe:2.3:o:paloaltonetworks:pan-os:*:*:*:*:*:*:*:*',
  ],
  cisco_asa: [
    'cpe:2.3:o:cisco:adaptive_security_appliance_software:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:cisco:adaptive_security_appliance_software:*:*:*:*:*:*:*:*',
  ],
  checkpoint: [
    'cpe:2.3:o:checkpoint:gaia_os:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:gaia_embedded:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:gaia_portal:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:quantum_security_gateway_firmware:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:quantum_spark_firmware:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:cloudguard_network_security:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:firewall-1:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:vpn-1:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:vpn-1_firewall-1:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:vpn-1_firewall-1_vsx:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:security_gateway:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:connectra_ngx:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:ipso_os:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:mobile_access:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:ipsec_vpn:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:web_intelligence:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:provider-1:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:multi-domain_security_management:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:multi-domain_management_firmware:*:*:*:*:*:*:*:*',
    'cpe:2.3:o:checkpoint:quantum_security_management_firmware:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:management_server:*:*:*:*:*:*:*:*',
    'cpe:2.3:a:checkpoint:log_server:*:*:*:*:*:*:*:*',
  ],
  sangfor: [
    'cpe:2.3:a:sangfor:next-gen_application_firewall:*:*:*:*:*:*:*:*',
  ],
};

/** The vendor slugs this service ingests for. */
export const CVE_VENDORS = Object.keys(VENDOR_CPES);

/** Every (vendor, cpeString) pair, which is the unit of ingestion work. */
export function allCpeTargets(): Array<{ vendor: string; cpeString: string }> {
  const out: Array<{ vendor: string; cpeString: string }> = [];
  for (const [vendor, list] of Object.entries(VENDOR_CPES)) {
    for (const cpeString of list) out.push({ vendor, cpeString });
  }
  return out;
}
