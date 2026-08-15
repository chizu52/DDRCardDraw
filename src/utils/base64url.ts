// btoa/atob only produce/accept standard base64 (+, /, = padding) --
// query-string-safe base64url swaps those for -, _, and drops padding
// (recoverable on decode: padding is always inferable from length).
// Shared by sheets-connection-param.ts and startgg-connection-param.ts,
// which both use it to pack a credential into one opaque URL query
// param rather than leaving it as a plain, immediately-readable value.
export function toBase64Url(standardB64: string): string {
  return standardB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(urlB64: string): string {
  const withSlashes = urlB64.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - (withSlashes.length % 4)) % 4;
  return withSlashes + "=".repeat(paddingNeeded);
}
