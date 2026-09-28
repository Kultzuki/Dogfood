/** Accept only bounded absolute HTTP(S) URLs for user-submitted links. */
export function isHttpUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}
