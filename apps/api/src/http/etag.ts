// Versions travel as HTTP ETags. We send them quoted, as the HTTP spec says
// ("3"), and accept quoted or bare (3) because hand-written clients often
// forget the quotes. Weak validators (W/"3") are accepted too.

export function formatEtag(version: number): string {
  return `"${version}"`;
}

export function parseEtag(header: string | undefined | null): number | null {
  const match = /^(?:W\/)?"?(\d{1,15})"?$/.exec(header?.trim() ?? '');
  return match ? Number(match[1]) : null;
}
