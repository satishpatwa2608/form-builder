/**
 * Automation tools a workflow can hand a response to. Each gives its flows an
 * address to post to; the address is the whole of the set-up. Which addresses
 * belong to which tool is known here, so a step can only ever call the tool
 * it says it calls, and nobody has to maintain a list of allowed hosts.
 */
export const FLOW_SERVICES = ['POWER_AUTOMATE', 'WORKFRONT_FUSION', 'ZAPIER', 'MAKE'] as const;
export type FlowService = (typeof FLOW_SERVICES)[number];

interface FlowServiceInfo {
  label: string;
  /** Where a person finds the address, in that tool's own words. */
  where: string;
  hosts: RegExp[];
}

export const FLOW_SERVICE_INFO: Record<FlowService, FlowServiceInfo> = {
  POWER_AUTOMATE: {
    label: 'Power Automate',
    where: 'In the flow, add the trigger "When an HTTP request is received", save, and copy its HTTP POST URL.',
    hosts: [/^prod-\d{1,3}\.[a-z0-9]{2,40}\.logic\.azure\.com$/, /^[a-z0-9]{6,80}(\.[a-z0-9]{1,10})?\.environment\.api\.powerplatform\.com$/],
  },
  WORKFRONT_FUSION: {
    label: 'Workfront Fusion',
    where: 'In the scenario, add a "Custom webhook" trigger and copy its address.',
    hosts: [/^hook(\.[a-z0-9-]{1,20}){0,2}\.fusion\.adobe\.com$/, /^hook(\.[a-z0-9-]{1,20}){0,2}\.workfrontfusion\.com$/],
  },
  ZAPIER: {
    label: 'Zapier',
    where: 'In the Zap, choose the trigger "Webhooks by Zapier" → "Catch Hook" and copy the webhook URL.',
    hosts: [/^hooks\.zapier\.com$/],
  },
  MAKE: {
    label: 'Make',
    where: 'In the scenario, add a "Custom webhook" trigger and copy its address.',
    hosts: [/^hook\.[a-z0-9-]{1,20}\.make\.com$/, /^hook\.integromat\.com$/],
  },
};

/**
 * The host of an https address written the plain way: no user name in front,
 * no port but the usual one, no backslashes or spaces. Anything else could be
 * read by one program as one host and by another as a different one, so it is not an address at all.
 */
function hostOf(url: string): string | null {
  const m = /^https:\/\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::443)?(?:[/?#][^\s\\]*)?$/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Whether an address is one of that tool's. */
export function isFlowAddress(service: FlowService, url: string): boolean {
  const host = hostOf(url);
  return !!host && (FLOW_SERVICE_INFO[service]?.hosts.some((h) => h.test(host)) ?? false);
}

/** The address with its secret parts left out, for showing in a list or a log. */
export function flowAddressLabel(url: string): string {
  return hostOf(url) ?? '';
}
