/** Shared, deterministic pen-style artwork. The cork touches (32, 76). */
export default function ShuttleArt({ monochrome = false }: { monochrome?: boolean }) {
  return (
    <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <g fill={monochrome ? "none" : "#f8fcf7"}>
        <path d="M23 60C18 45 10 29 5 16 2 9 5 5 11 9 21 18 26 42 29 60" />
        <path d="M41 60C46 44 53 29 59 16 62 9 59 5 53 9 43 18 38 43 35 60" />
        <path d="M27 59C24 44 19 24 18 12 17 5 21 3 25 8 30 19 31 42 32 59" />
        <path d="M37 59C40 43 44 25 46 12 47 5 43 3 39 8 34 19 33 43 32 59" />
        <path d="M29 60C28 43 26 22 28 9 29 2 34 2 36 9 38 23 35 44 35 60" />
      </g>
      <g fill="none" strokeWidth="1.2">
        <path d="M11 15q8 17 13 34M53 15q-8 17-13 34M32 12l-.5 38" />
        <path d="m19 37 5 2m-3 5 5 2m19-9-5 2m3 5-5 2M16 40q16 7 32-.5M21 53q11 4 22 0" />
      </g>
      <path d="M23 61C29 62 34 60 41 61l-.5 5c1.5 3-1.5 8-5.5 9-1 1-2 1-3 1-5 0-9-3-9-6-1-2 0-6 0-9Z" fill={monochrome ? "none" : "white"} />
      <path d="M22.5 58q8-1 19 1l-.5 4q-9-1-18 0Z" fill={monochrome ? "currentColor" : "#d5f168"} />
      <path d="m26.5 67.5 1 2.5m3-1.5.6 2M35 70l1-.5" fill="none" strokeWidth="1.2" opacity=".5" />
    </g>
  );
}
