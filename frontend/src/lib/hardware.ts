/** Whether a hardware profile is the real latency-target device of the program (Dell Latitude 7220 Rugged Extreme). */
export function isLatencyTargetProfile(profile: string | null | undefined): boolean {
  return /latitude[-_ ]?7220/i.test(profile ?? '');
}
