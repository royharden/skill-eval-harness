// Parses a size string such as "120x40" into { width, height }.
export function parseSize(text) {
  const match = /^(\d+)x(\d+)$/.exec(String(text).trim());
  if (!match) {
    throw new TypeError(`invalid size: ${text}`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}
