export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
