/** A feather shuttle drawn on the juggle animation's existing contact grid. */
export default function ShuttleArt({ monochrome = false }: { monochrome?: boolean }) {
  return (
    <g fill="currentColor">
      {/* The negative space between the three broad feathers survives at logo size. */}
      <path d="M6 15a5 5 0 0 1 2.6-6.7l7.1-3.1a4.8 4.8 0 0 1 6.6 3.6L30 52h-8.1z" />
      <path d="M26 8.5A4.2 4.2 0 0 1 30.2 4h3.6A4.2 4.2 0 0 1 38 8.5L34.8 52h-5.6z" />
      <path d="M58 15a5 5 0 0 0-2.6-6.7l-7.1-3.1a4.8 4.8 0 0 0-6.6 3.6L34 52h8.1z" />
      <path d="M20 48h24l-2.8 10H22.8z" />
      {/* The outer cork path still reaches exactly (32, 76). */}
      <path d="M20 55h24v9a12 12 0 0 1-24 0z" />
      {!monochrome && <>
        <path d="M23 56h18v4H23z" fill="#d5f168" />
        <path d="M23 63h18v1a9 9 0 0 1-18 0z" fill="#fffef8" />
      </>}
    </g>
  );
}

export function ShuttleLogo() {
  return (
    <svg viewBox="-8 -4 84 88" fill="none" aria-hidden="true" focusable="false">
      <g transform="rotate(-18 32 40)">
        <ShuttleArt />
      </g>
    </svg>
  );
}
